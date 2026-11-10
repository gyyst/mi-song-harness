import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, loadSdk } from './chat_loader.mjs';
import { storageOf } from './chat_fixture.mjs';

const load = loader();
const { ConfigManager } = load('../src/config/manager.ts');
const { registerSearchProviderComm } = load('../src/handlers/search_registry.ts');
const { registerConfigHandlers } = load('../src/handlers/config.ts');
const { createRouter } = loadSdk();

test('upsertSearchProvider stores playlistPath only as an internal path', async t => {
  storageOf(t);
  const manager = new ConfigManager();
  await manager.upsertSearchProvider({
    entryPath: 'lxmusic',
    name: '洛雪音源',
    searchPath: '/api/search/topone',
    playlistPath: '/api/songlist/random',
  });
  const stored = await new ConfigManager().getSearchProviders();
  assert.equal(stored[0].playlistPath, '/api/songlist/random');

  await manager.upsertSearchProvider({
    entryPath: 'lxmusic',
    name: '洛雪音源',
    searchPath: '/api/search/topone',
    playlistPath: 'https://evil.test/steal',
  });
  assert.equal((await manager.getSearchProviders())[0].playlistPath, undefined);

  // 老版本重新注册时不带 playlistPath，应清掉旧能力，避免继续调用已不存在的接口。
  await manager.upsertSearchProvider({
    entryPath: 'lxmusic',
    name: '洛雪音源',
    searchPath: '/api/search/topone',
    playlistPath: '/api/songlist/random',
  });
  await manager.upsertSearchProvider({
    entryPath: 'lxmusic',
    name: '洛雪音源',
    searchPath: '/api/search/topone',
  });
  assert.equal((await manager.getSearchProviders())[0].playlistPath, undefined);
});

test('register-search-provider accepts playlistPath from the trusted caller', async t => {
  storageOf(t);
  const handlers = new Map();
  globalThis.songloft.comm = {
    onMessage(name, handler) { handlers.set(name, handler); },
  };
  const manager = new ConfigManager();
  registerSearchProviderComm(manager);

  const result = await handlers.get('register-search-provider')({
    name: '洛雪音源',
    searchPath: '/api/search/topone',
    playlistPath: '/api/songlist/random',
  }, 'lxmusic');
  assert.deepEqual(result, { ok: true });
  const provider = (await manager.getSearchProviders())[0];
  assert.equal(provider.entryPath, 'lxmusic');
  assert.equal(provider.playlistPath, '/api/songlist/random');
});

test('GET /search-providers exposes the playlist endpoint of active providers', async t => {
  const env = storageOf(t);
  globalThis.songloft.plugin = { getToken: async () => 'token' };
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'http://host/api/v1/jsplugins/');
    return Response.json({ plugins: [{ entry_path: 'lxmusic', status: 'active' }] });
  });
  // getHostAPIBaseUrl 优先使用 songloft.plugin.getHostUrl，测试里直接给固定 host。
  globalThis.songloft.plugin.getHostUrl = async () => 'http://host';

  const manager = new ConfigManager();
  await manager.upsertSearchProvider({
    entryPath: 'lxmusic',
    name: '洛雪音源',
    searchPath: '/api/search/topone',
    playlistPath: '/api/songlist/random',
  });
  const router = createRouter();
  registerConfigHandlers(router, manager, {}, {}, {}, {});
  const result = await router.handle({ method: 'GET', path: '/search-providers' });
  const body = JSON.parse(result.body);
  assert.deepEqual(body.providers, [{
    id: 'lxmusic',
    name: '洛雪音源',
    url: '/api/v1/jsplugin/lxmusic/api/search/topone',
    playlist_path: '/api/songlist/random',
    playlist_url: '/api/v1/jsplugin/lxmusic/api/songlist/random',
    installed: true,
    active: true,
  }]);
});

test('config exposes and persists the random playlist switch', async t => {
  storageOf(t);
  globalThis.songloft.plugin = {
    getToken: async () => 'token',
    getNetworkAddresses: async () => [],
  };
  const manager = new ConfigManager();
  const router = createRouter();
  registerConfigHandlers(router, manager, {}, {}, {}, {});

  let result = await router.handle({ method: 'GET', path: '/config' });
  assert.equal(JSON.parse(result.body).data.external_search_random_playlist, true);

  result = await router.handle({
    method: 'POST',
    path: '/config',
    body: JSON.stringify({ external_search_random_playlist: false }),
  });
  assert.equal(JSON.parse(result.body).success, true);
  assert.equal((await new ConfigManager().getConfig()).external_search_random_playlist, false);
});
