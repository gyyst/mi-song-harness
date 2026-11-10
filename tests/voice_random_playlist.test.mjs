import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

const load = loader({
  '../playback/voice_resume': {},
  '../playback/sleep_timer': {},
  '../config/manager': {},
  '../account/manager': {},
  '../service/service': {},
  '../player/manager': { resolvePlaylistResumeStart: async () => null },
  '../indexing/manager': {},
  '../group/coordinator': {},
  '../player/url_builder': {
    playbackOptionsOf: () => ({}),
    URLBuilder: { buildSongURL: async song => `http://host${song.url}` },
  },
  '../voicecmd/ai_analyzer': {},
  '../handlers/playlist': {},
  '../utils/http': {
    getHostAPIBaseUrl: async () => 'http://host',
    getHostBaseUrl: async () => 'http://host',
  },
  '../utils/favorites': {},
  '../memory': {},
  '../sleep_timer': {},
});

const { MusicCommandService } = load('../src/music/service.ts');

const librarySongs = [
  { id: 1, title: '身骑白马', artist: '徐佳莹', url: '/api/v1/songs/1/play' },
  { id: 2, title: '光年之外', artist: 'G.E.M. 邓紫棋', url: '/api/v1/songs/2/play' },
];
const onlineSongs = [
  { id: 31, title: '晴天', artist: '周杰伦', url: '/api/v1/songs/31/play', duration: 269 },
  { id: 32, title: '夜曲', artist: '周杰伦', url: '/api/v1/songs/32/play', duration: 226 },
];

function fixture(t, options = {}) {
  const previous = { songloft: globalThis.songloft };
  t.after(() => { globalThis.songloft = previous.songloft; });

  const events = [];
  const speeches = [];
  const onlineCalls = [];
  const config = {
    max_song_index: 10000,
    interrupt_tts_hint_enabled: false,
    external_search_enabled: options.externalEnabled ?? true,
    external_search_random_playlist: options.randomEnabled ?? true,
    external_search_no_import: options.noImport ?? false,
  };

  globalThis.songloft = {
    log: { info() { }, warn() { }, error() { } },
    songs: {
      list: async opts => {
        events.push(['songs.list', opts]);
        return librarySongs;
      },
    },
  };

  const pm = {
    hasPlaylist: () => options.hasPlaylist ?? false,
    isRandomNetworkPlaylist: () => options.randomNetworkQueue ?? false,
    next: async () => { events.push('next'); return options.nextOK ?? true; },
    prepareForNewPlayback: () => events.push('prepare'),
    playWithSongs: async (...args) => {
      events.push(['playWithSongs', ...args]);
      if (options.playWithSongs) return options.playWithSongs(args, events);
      return true;
    },
    play: async (...args) => { events.push(['play', ...args]); return true; },
    setAnnounceOnSongChange: () => events.push('announce'),
    isPlaying: () => false,
    getPrimary: () => ({ account_id: 'account', device_id: 'speaker' }),
  };

  const engine = Object.create(MusicCommandService.prototype);
  engine.cancelPendingResume = () => events.push('cancel');
  engine.configManager = {
    getConfig: async () => config,
    getDevices: async () => [{ device_id: 'speaker', play_mode: options.playMode || 'loop' }],
  };
  engine.playlistManagerMap = {
    get: () => pm,
    getOrCreate: async () => pm,
    cancelHourlyResumes: () => { },
  };
  engine.minaService = {
    stopPlay: async () => { events.push('stop'); return true; },
    textToSpeech: async (_account, _device, text) => { speeches.push(text); },
  };
  engine.indexingManager = {
    isIndexReady: () => true,
    refresh: async () => ({ success: true }),
    searchPlaylist: () => [],
    findPlaylistByNameWithRefresh: async () => null,
    getStatus: () => ({ ready: true, playlist_count: 0, is_refreshing: false }),
  };
  engine.onlineSearcher = {
    fetchRandomPlaylist: async limit => {
      onlineCalls.push(['fetch', limit]);
      if (options.fetchThrows) throw new Error('provider down');
      return options.playlist === null ? null : (options.playlist ?? { name: '华语热歌', songs: [{ title: '晴天' }] });
    },
    importPlaylistSongs: async songs => {
      onlineCalls.push(['import', songs]);
      return options.playable ?? onlineSongs;
    },
  };

  return { engine, events, speeches, onlineCalls };
}

const playWithSongsCalls = events => events.filter(e => Array.isArray(e) && e[0] === 'playWithSongs');

test('播放音乐无队列时随机播放网络歌单，不读取曲库', async t => {
  const f = fixture(t);
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(f.onlineCalls.map(c => c[0]), ['fetch', 'import']);
  assert.deepEqual(playWithSongsCalls(f.events), [
    ['playWithSongs', onlineSongs, 0, 'loop', '网络歌单: 华语热歌', ''],
  ]);
  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'songs.list'), []);
  assert.ok(f.events.includes('prepare'));
  assert.ok(f.events.includes('stop'));
  assert.deepEqual(f.speeches, []);
});

test('播放音乐时队列已到队尾，续播失败后改播随机网络歌单', async t => {
  const f = fixture(t, { hasPlaylist: true, nextOK: false });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.ok(f.events.includes('next'));
  const onlineIndex = f.events.findIndex(e => Array.isArray(e) && e[0] === 'playWithSongs' && e[4] === '网络歌单: 华语热歌');
  assert.ok(onlineIndex > f.events.indexOf('next'), '应先尝试续播当前队列');
  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'songs.list'), []);
});

test('播放音乐时队列还有下一首，继续队列而不是换网络歌单', async t => {
  const f = fixture(t, { hasPlaylist: true, nextOK: true });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(f.events, ['cancel', 'next']);
  assert.deepEqual(f.onlineCalls, []);
});

test('播放音乐时随机网络歌单不逐首续播，直接重新随机', async t => {
  const f = fixture(t, { hasPlaylist: true, randomNetworkQueue: true, nextOK: true });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.ok(!f.events.includes('next'), '不可播平台的旧队列不应继续 next()');
  assert.deepEqual(f.onlineCalls.map(c => c[0]), ['fetch', 'import']);
  assert.deepEqual(playWithSongsCalls(f.events), [
    ['playWithSongs', onlineSongs, 0, 'loop', '网络歌单: 华语热歌', ''],
  ]);
});

test('随机歌单关闭时回落到曲库全部歌曲', async t => {
  const f = fixture(t, { randomEnabled: false });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(f.onlineCalls, []);
  assert.deepEqual(playWithSongsCalls(f.events), [
    ['playWithSongs', librarySongs, 0, 'loop', '全部歌曲', ''],
  ]);
});

test('外部搜索关闭或开启不入库直接播放时不请求随机歌单', async t => {
  for (const options of [{ externalEnabled: false }, { noImport: true }]) {
    const f = fixture(t, options);
    await f.engine.executePlaySong('', 'account', 'speaker');
    assert.deepEqual(f.onlineCalls, [], JSON.stringify(options));
    assert.deepEqual(playWithSongsCalls(f.events)[0][4], '全部歌曲');
  }
});

test('搜索源没有随机歌单时回落到曲库', async t => {
  const f = fixture(t, { playlist: null });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(f.onlineCalls.map(c => c[0]), ['fetch']);
  assert.deepEqual(playWithSongsCalls(f.events), [
    ['playWithSongs', librarySongs, 0, 'loop', '全部歌曲', ''],
  ]);
});

test('歌单导入为空或搜索源抛错时回落到曲库', async t => {
  for (const options of [{ playable: [] }, { fetchThrows: true }]) {
    const f = fixture(t, options);
    await f.engine.executePlaySong('', 'account', 'speaker');
    assert.deepEqual(playWithSongsCalls(f.events), [
      ['playWithSongs', librarySongs, 0, 'loop', '全部歌曲', ''],
    ], JSON.stringify(options));
  }
});

test('随机网络歌单沿用设备的播放模式', async t => {
  const f = fixture(t, { playMode: 'random' });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(playWithSongsCalls(f.events), [
    ['playWithSongs', onlineSongs, 0, 'random', '网络歌单: 华语热歌', ''],
  ]);
});
