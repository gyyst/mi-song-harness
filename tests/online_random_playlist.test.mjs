import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadSource(path, dependencies) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

const noop = () => { };
const { OnlineSearcher } = loadSource('../src/voicecmd/online_searcher.ts', {
  '../service/service': { MinaService: class { } },
  '../utils/http': {
    getHostAPIBaseUrl: async () => 'http://host',
    getHostBaseUrl: async () => 'http://host',
  },
  '../player/url_builder': { URLBuilder: { buildSongURL: async () => '' }, playbackOptionsOf: () => ({}) },
  '../config/manager': { ConfigManager: class { } },
  '../indexing/manager': { IndexingManager: class { } },
  '../group/coordinator': { GroupCoordinator: class { } },
});

const provider = {
  entryPath: 'lxmusic',
  name: '洛雪音源',
  searchPath: '/api/search/topone',
  playlistPath: '/api/songlist/random',
};
const relativeSource = {
  id: 'src_1',
  name: '洛雪音源',
  url: '/api/v1/jsplugin/lxmusic/api/search/topone',
  enabled: true,
};

function configWith(overrides = {}) {
  return {
    external_search_enabled: true,
    external_search_no_import: false,
    external_search_timeout: 6,
    external_search_sources: [relativeSource],
    ...overrides,
  };
}

function buildSearcher(config = configWith(), providers = [provider]) {
  const searcher = new OnlineSearcher({
    getConfig: async () => config,
    getSearchProviders: async () => providers,
  });
  return searcher;
}

function withGlobals(run) {
  const original = { songloft: globalThis.songloft, fetch: globalThis.fetch };
  const calls = [];
  globalThis.songloft = {
    log: { info: noop, warn: noop, error: noop },
    plugin: { getToken: async () => 'plugin-token' },
  };
  const result = Promise.resolve(run(calls)).finally(() => {
    globalThis.songloft = original.songloft;
    globalThis.fetch = original.fetch;
  });
  return result;
}

const playlistSongs = [
  { title: '晴天', artist: '周杰伦', duration: 269, dedup_key: 'tx:1', plugin_entry_path: 'lxmusic' },
  { title: '夜曲', artist: '周杰伦', duration: 226, dedup_key: 'tx:2', plugin_entry_path: 'lxmusic' },
];

test('fetchRandomPlaylist matches a registered provider by source path and parses songs', async () => {
  await withGlobals(async calls => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: { name: '华语热歌', platform: 'tx', songs: playlistSongs },
        }),
      };
    };
    const searcher = buildSearcher();
    const result = await searcher.fetchRandomPlaylist(10);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://host/api/v1/jsplugin/lxmusic/api/songlist/random?limit=10');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer plugin-token');
    assert.deepEqual(result, { name: '华语热歌', platform: 'tx', songs: playlistSongs });
  });
});

test('fetchRandomPlaylist keeps the origin of an absolute source URL', async () => {
  await withGlobals(async calls => {
    globalThis.fetch = async url => {
      calls.push(url);
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { name: '榜单', songs: playlistSongs } }) };
    };
    const searcher = buildSearcher(configWith({
      external_search_sources: [{
        id: 'src_1',
        name: '洛雪音源',
        url: 'http://192.168.1.20:58091/api/v1/jsplugin/lxmusic/api/search/topone',
        enabled: true,
      }],
    }));
    const result = await searcher.fetchRandomPlaylist();
    assert.equal(calls[0], 'http://192.168.1.20:58091/api/v1/jsplugin/lxmusic/api/songlist/random?limit=20');
    assert.equal(result.name, '榜单');
  });
});

test('fetchRandomPlaylist returns null without an enabled playlist-capable source', async () => {
  await withGlobals(async calls => {
    globalThis.fetch = async url => { calls.push(url); throw new Error('must not fetch'); };

    assert.equal(await buildSearcher(configWith(), []).fetchRandomPlaylist(), null);
    assert.equal(await buildSearcher(configWith({
      external_search_sources: [{ ...relativeSource, enabled: false }],
    })).fetchRandomPlaylist(), null);
    assert.equal(await buildSearcher(configWith({ external_search_enabled: false })).fetchRandomPlaylist(), null);
    assert.equal(await buildSearcher(configWith({ external_search_no_import: true })).fetchRandomPlaylist(), null);
    assert.deepEqual(calls, []);
  });
});

test('fetchRandomPlaylist rejects HTTP errors, invalid JSON and non-zero codes', async () => {
  await withGlobals(async () => {
    const cases = [
      { status: 500, body: 'server error' },
      { status: 200, body: 'not json' },
      { status: 200, body: JSON.stringify({ code: 404, msg: '没有歌单' }) },
      { status: 200, body: JSON.stringify({ code: 0, data: { name: '空', songs: [] } }) },
      { status: 200, body: JSON.stringify({ code: 0, data: { name: '坏数据', songs: [{ artist: 'x' }] } }) },
    ];
    for (const item of cases) {
      globalThis.fetch = async () => ({ status: item.status, text: async () => item.body });
      assert.equal(await buildSearcher().fetchRandomPlaylist(), null, `${item.status} ${item.body}`);
    }
  });
});

test('importPlaylistSongs maps imported rows by dedup key and builds playable songs', async () => {
  await withGlobals(async calls => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return {
        status: 200,
        text: async () => JSON.stringify({
          songs: [
            { id: 31, type: 'remote', title: '晴天', artist: '周杰伦', duration: 269, url: '/api/v1/songs/31/play', dedup_key: 'tx:1', plugin_entry_path: 'lxmusic' },
            { id: 32, type: 'remote', title: '夜曲', artist: '周杰伦', duration: 226, url: '/api/v1/songs/32/play', dedup_key: 'tx:2', plugin_entry_path: 'lxmusic' },
          ],
        }),
      };
    };
    const searcher = buildSearcher();
    const playable = await searcher.importPlaylistSongs(playlistSongs);

    assert.equal(calls[0].url, 'http://host/api/v1/songs/remote');
    assert.equal(calls[0].body.length, 2);
    assert.equal(calls[0].body[0].dedup_key, 'tx:1');
    assert.equal(calls[0].body[0].plugin_entry_path, 'lxmusic');
    assert.deepEqual(playable.map(song => [song.id, song.title, song.url]), [
      [31, '晴天', '/api/v1/songs/31/play'],
      [32, '夜曲', '/api/v1/songs/32/play'],
    ]);
    assert.equal(playable[0].type, 'remote');
    assert.equal(playable[0].duration, 269);
    assert.equal(playable[0].plugin_entry_path, 'lxmusic');
  });
});

test('importPlaylistSongs skips duplicate ids and survives import failures', async () => {
  await withGlobals(async () => {
    globalThis.fetch = async () => ({
      status: 200,
      text: async () => JSON.stringify({
        songs: [
          { id: 31, title: '晴天', url: '/api/v1/songs/31/play', dedup_key: 'tx:1' },
          { id: 31, title: '晴天副本', url: '/api/v1/songs/31/play', dedup_key: 'tx:1b' },
        ],
      }),
    });
    const searcher = buildSearcher();
    const playable = await searcher.importPlaylistSongs([
      playlistSongs[0],
      { title: '晴天副本', artist: '周杰伦', dedup_key: 'tx:1b' },
    ]);
    assert.deepEqual(playable.map(song => song.id), [31]);
  });

  await withGlobals(async () => {
    globalThis.fetch = async () => ({ status: 200, text: async () => 'oops' });
    assert.deepEqual(await buildSearcher().importPlaylistSongs(playlistSongs), []);
  });
});
