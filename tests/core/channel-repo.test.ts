import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelStore } from '../../src/core/db/channel-repo';
import { migrate } from '../../src/core/db/schema';
import { Database } from '../../src/core/db/sqlite';

let db: Database;
let store: ChannelStore;
let tick = 0;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  tick = 0;
  store = new ChannelStore(db, () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}Z`);
});

const chan = (id: string, title = `Channel ${id}`) => ({ youtubeChannelId: id, handle: `@${id}`, title, url: `https://www.youtube.com/channel/${id}` });
const item = (videoId: string, tab: 'videos' | 'streams' = 'videos') => ({ videoId, title: `Video ${videoId}`, durationMs: 60_000, tab });

describe('migration 4', () => {
  it('creates the channel tables and is idempotent', () => {
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['channels', 'feed_items']));
  });
});

describe('channels', () => {
  it('adds, reads and lists channels in the order they were added', () => {
    const a = store.addChannel(chan('UCa'));
    const b = store.addChannel(chan('UCb'));
    expect(a).toMatchObject({ id: 1, youtubeChannelId: 'UCa', handle: '@UCa', lastCheckedAt: null, lastError: null });
    expect(store.getChannel(2)).toEqual(b);
    expect(store.findByYoutubeId('UCa')).toEqual(a);
    expect(store.findByYoutubeId('nope')).toBeUndefined();
    expect(store.listChannels().map((c) => c.youtubeChannelId)).toEqual(['UCa', 'UCb']);
  });

  it('refuses the same YouTube channel twice', () => {
    store.addChannel(chan('UCa'));
    expect(() => store.addChannel(chan('UCa', 'Again'))).toThrow();
  });

  it('a failed check keeps the last good time, a good check clears the error', () => {
    const c = store.addChannel(chan('UCa'));
    store.recordCheck(c.id, null);
    const good = store.getChannel(c.id)?.lastCheckedAt;
    expect(good).not.toBeNull();
    store.recordCheck(c.id, 'network down');
    expect(store.getChannel(c.id)).toMatchObject({ lastCheckedAt: good, lastError: 'network down' });
    store.recordCheck(c.id, null);
    expect(store.getChannel(c.id)?.lastError).toBeNull();
  });

  it('removing a channel removes only its own feed items', () => {
    const a = store.addChannel(chan('UCa'));
    const b = store.addChannel(chan('UCb'));
    store.addItems(a.id, [item('aaaaaaaaaaa')]);
    store.addItems(b.id, [item('bbbbbbbbbbb')]);
    store.removeChannel(a.id);
    expect(store.getChannel(a.id)).toBeUndefined();
    expect(store.listFeed().map((f) => f.videoId)).toEqual(['bbbbbbbbbbb']);
  });
});

describe('feed', () => {
  it('addItems returns how many were new and ignores ids it already has', () => {
    const c = store.addChannel(chan('UCa'));
    expect(store.addItems(c.id, [item('aaaaaaaaaaa'), item('bbbbbbbbbbb')])).toBe(2);
    expect(store.addItems(c.id, [item('bbbbbbbbbbb'), item('ccccccccccc')])).toBe(1);
    expect(store.addItems(c.id, [])).toBe(0);
  });

  it('lists newest first by first seen, keeping listing order within one check', () => {
    const c = store.addChannel(chan('UCa'));
    store.addItems(c.id, [item('aaaaaaaaaaa'), item('bbbbbbbbbbb', 'streams')]);
    store.addItems(c.id, [item('ccccccccccc'), item('ddddddddddd')]);
    expect(store.listFeed().map((f) => f.videoId)).toEqual(['ccccccccccc', 'ddddddddddd', 'aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(store.listFeed()[3]).toMatchObject({ tab: 'streams', channelTitle: 'Channel UCa', durationMs: 60_000 });
  });

  it('dismissed videos disappear and are not resurrected by a later check', () => {
    const c = store.addChannel(chan('UCa'));
    store.addItems(c.id, [item('aaaaaaaaaaa'), item('bbbbbbbbbbb')]);
    store.dismiss('aaaaaaaaaaa');
    expect(store.listFeed().map((f) => f.videoId)).toEqual(['bbbbbbbbbbb']);
    expect(store.addItems(c.id, [item('aaaaaaaaaaa')])).toBe(0);
    expect(store.listFeed().map((f) => f.videoId)).toEqual(['bbbbbbbbbbb']);
  });

  it('knownVideos lists every video a channel has shown with its tab, dismissed ones included', () => {
    const a = store.addChannel(chan('UCa'));
    const b = store.addChannel(chan('UCb'));
    store.addItems(a.id, [item('aaaaaaaaaaa'), item('bbbbbbbbbbb', 'streams')]);
    store.addItems(b.id, [item('ccccccccccc')]);
    store.dismiss('aaaaaaaaaaa');
    expect([...store.knownVideos(a.id)]).toEqual([
      ['aaaaaaaaaaa', 'videos'],
      ['bbbbbbbbbbb', 'streams'],
    ]);
    expect(store.knownVideos(99).size).toBe(0);
  });

  it('dismissAll can be limited to one channel', () => {
    const a = store.addChannel(chan('UCa'));
    const b = store.addChannel(chan('UCb'));
    store.addItems(a.id, [item('aaaaaaaaaaa')]);
    store.addItems(b.id, [item('bbbbbbbbbbb')]);
    store.dismissAll(a.id);
    expect(store.listFeed().map((f) => f.videoId)).toEqual(['bbbbbbbbbbb']);
    store.dismissAll();
    expect(store.listFeed()).toEqual([]);
  });
});
