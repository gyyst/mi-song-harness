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

function fixture(t, options = {}) {
  const previous = { songloft: globalThis.songloft };
  t.after(() => { globalThis.songloft = previous.songloft; });

  const events = [];
  const speeches = [];
  const songs = options.songs ?? librarySongs;
  const config = {
    max_song_index: 10000,
    interrupt_tts_hint_enabled: false,
    external_search_enabled: true,
    external_search_no_import: true,
  };

  globalThis.songloft = {
    log: { info() { }, warn() { }, error() { } },
    songs: {
      list: async opts => {
        events.push(['songs.list', opts]);
        if (options.songsError) throw new Error('library unavailable');
        return songs;
      },
    },
  };

  const pm = {
    hasPlaylist: () => options.hasPlaylist ?? false,
    isRandomNetworkPlaylist: () => options.randomNetworkQueue ?? false,
    next: async () => { events.push('next'); return options.nextOK ?? true; },
    prepareForNewPlayback: () => events.push('prepare'),
    playWithSongs: async (...args) => { events.push(['playWithSongs', ...args]); return options.playOK ?? true; },
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
    searchPlaylist: () => options.playlists ?? [],
    findPlaylistByNameWithRefresh: async () => options.playlistMatch ?? null,
    getStatus: () => ({ ready: true, playlist_count: 0, is_refreshing: false }),
  };

  return { engine, events, speeches, songs };
}

test('空歌名且没有活动队列时播放曲库全部歌曲', async t => {
  const f = fixture(t);
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'songs.list'), [['songs.list', { limit: 10000 }]]);
  assert.ok(f.events.includes('prepare'));
  assert.ok(f.events.includes('stop'));
  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'playWithSongs'), [
    ['playWithSongs', f.songs, 0, 'loop', '全部歌曲', ''],
  ]);
  assert.deepEqual(f.speeches, []);
});

test('空歌名且当前队列已到队尾时回退到曲库', async t => {
  const f = fixture(t, { hasPlaylist: true, nextOK: false });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.ok(f.events.includes('next'), '应先尝试续播当前队列');
  assert.ok(f.events.some(e => Array.isArray(e) && e[0] === 'playWithSongs'), '队尾停止后应改为播放曲库');
  assert.ok(f.events.indexOf('next') < f.events.findIndex(e => Array.isArray(e) && e[0] === 'playWithSongs'));
});

test('空歌名且当前队列还有下一首时继续队列，不重播曲库', async t => {
  const f = fixture(t, { hasPlaylist: true, nextOK: true });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(f.events.filter(e => Array.isArray(e)), []);
  assert.ok(f.events.includes('next'));
  assert.deepEqual(f.speeches, []);
});

test('空歌单名且只有空歌单时回退到曲库', async t => {
  const f = fixture(t, {
    playlists: [
      { id: 1, name: '收藏', songCount: 0 },
      { id: 2, name: '电台收藏', songCount: 0 },
    ],
  });
  await f.engine.executePlayPlaylist('', 'account', 'speaker');

  assert.ok(f.events.some(e => Array.isArray(e) && e[0] === 'playWithSongs'));
  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'play'), []);
  assert.deepEqual(f.speeches, []);
});

test('空歌单名且当前队列已到队尾时回退到曲库', async t => {
  const f = fixture(t, { hasPlaylist: true, nextOK: false });
  await f.engine.executePlayPlaylist('', 'account', 'speaker');

  assert.ok(f.events.includes('next'), '应先尝试续播当前队列');
  assert.ok(f.events.some(e => Array.isArray(e) && e[0] === 'playWithSongs'), '队尾停止后应改为播放曲库');
  assert.ok(f.events.indexOf('next') < f.events.findIndex(e => Array.isArray(e) && e[0] === 'playWithSongs'));
});

test('空歌单名时选择第一个有歌的歌单', async t => {
  const f = fixture(t, {
    playlists: [
      { id: 1, name: '收藏', songCount: 0 },
      { id: 7, name: '我的歌单', songCount: 2 },
    ],
    playlistMatch: { id: 7, name: '我的歌单', songCount: 2 },
  });
  await f.engine.executePlayPlaylist('', 'account', 'speaker');

  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'play'), [['play', 7, 0, 'loop']]);
  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'songs.list'), []);
});

test('曲库为空时提示用户而不启动播放', async t => {
  const f = fixture(t, { songs: [] });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'playWithSongs'), []);
  assert.deepEqual(f.speeches, ['曲库为空，请先添加歌曲']);
});

test('读取曲库失败时提示重试，不误报曲库为空', async t => {
  const f = fixture(t, { songsError: true });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'playWithSongs'), []);
  assert.deepEqual(f.speeches, ['读取曲库失败，请稍后重试']);
});

test('播放曲库时沿用设备的播放模式', async t => {
  const f = fixture(t, { playMode: 'random' });
  await f.engine.executePlaySong('', 'account', 'speaker');

  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'playWithSongs'), [
    ['playWithSongs', f.songs, 0, 'random', '全部歌曲', ''],
  ]);
});
