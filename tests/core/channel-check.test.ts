import { beforeEach, describe, expect, it } from 'vitest';
import { addChannel, checkChannel, CHECK_PER_TAB, INITIAL_PER_TAB, type ChannelDeps } from '../../src/core/channels/check';
import type { ChannelListing, ChannelTab } from '../../src/core/channels/listing';
import { ChannelStore } from '../../src/core/db/channel-repo';
import { migrate } from '../../src/core/db/schema';
import { Database } from '../../src/core/db/sqlite';
import { BgtError } from '../../src/core/errors';

const UC = 'UCabcdefghijklmnopqrstuv';
const videos = (prefix: string, n: number, tab: ChannelTab) =>
  Array.from({ length: n }, (_, i) => ({ videoId: `${prefix}${String(i).padStart(10, '0')}`, title: `${prefix} ${i}`, durationMs: 60_000, tab }));
const listing = (items: ChannelListing['items'], id = UC): ChannelListing => ({
  channel: { youtubeChannelId: id, handle: '@example', title: 'Example', url: `https://www.youtube.com/channel/${id}` },
  items,
});

let store: ChannelStore;
let calls: { url: string; tab: ChannelTab; limit: number }[];
let behavior: (tab: ChannelTab) => ChannelListing | Error;
const deps = (): ChannelDeps => ({
  store,
  ytdlpPath: () => 'yt-dlp.exe',
  log: () => {},
  list: async (a) => {
    calls.push({ url: a.url, tab: a.tab, limit: a.limit });
    const r = behavior(a.tab);
    if (r instanceof Error) throw r;
    return r;
  },
});

beforeEach(() => {
  const db = new Database(':memory:');
  migrate(db);
  store = new ChannelStore(db);
  calls = [];
  behavior = (tab) => listing(tab === 'videos' ? videos('v', 8, 'videos') : videos('s', 8, 'streams'));
});

describe('addChannel', () => {
  it('normalizes the input, follows the channel by its id and fills the feed with 5 per tab', async () => {
    const c = await addChannel(deps(), '@example');
    expect(c).toMatchObject({ youtubeChannelId: UC, title: 'Example', handle: '@example', url: `https://www.youtube.com/channel/${UC}` });
    expect(calls).toEqual([
      { url: 'https://www.youtube.com/@example', tab: 'videos', limit: INITIAL_PER_TAB },
      { url: 'https://www.youtube.com/@example', tab: 'streams', limit: INITIAL_PER_TAB },
    ]);
    expect(INITIAL_PER_TAB).toBe(5);
    const feed = store.listFeed();
    expect(feed).toHaveLength(16); // the fake ignores the limit; what matters is that both tabs were stored
    expect(feed.filter((f) => f.tab === 'streams')).toHaveLength(8);
    expect(store.getChannel(c.id)).toMatchObject({ lastError: null });
    expect(store.getChannel(c.id)?.lastCheckedAt).not.toBeNull();
  });

  it('refuses the same channel again, even when named differently', async () => {
    await addChannel(deps(), '@example');
    await expect(addChannel(deps(), UC)).rejects.toMatchObject({ code: 'InvalidInput', message: 'You already follow this channel.' });
    expect(store.listChannels()).toHaveLength(1);
  });

  it('rejects input that is not a channel without calling yt-dlp', async () => {
    await expect(addChannel(deps(), 'https://www.youtube.com/watch?v=7SHNxjFuw10')).rejects.toMatchObject({ code: 'InvalidInput' });
    expect(calls).toHaveLength(0);
  });

  it('works for a channel without a Streams tab', async () => {
    behavior = (tab) => (tab === 'videos' ? listing(videos('v', 2, 'videos')) : new BgtError('DownloadFailed', 'no streams tab'));
    const c = await addChannel(deps(), '@example');
    expect(store.listFeed()).toHaveLength(2);
    expect(store.getChannel(c.id)?.lastError).toBeNull();
  });

  it('works for a channel that has no videos at all', async () => {
    behavior = () => listing([]);
    const c = await addChannel(deps(), '@example');
    expect(store.listFeed()).toEqual([]);
    expect(store.getChannel(c.id)).toBeDefined();
  });

  it('stores nothing and says the channel was not found when both tabs fail', async () => {
    behavior = () => new BgtError('DownloadFailed', 'HTTP 404');
    await expect(addChannel(deps(), '@example')).rejects.toMatchObject({
      code: 'DownloadFailed',
      message: expect.stringContaining('Could not find that channel'),
    });
    expect(store.listChannels()).toEqual([]);
  });
});

describe('checkChannel', () => {
  it('lists 15 per tab, adds only unseen videos and stamps the check', async () => {
    const c = await addChannel(deps(), '@example');
    calls = [];
    behavior = (tab) => listing([...(tab === 'videos' ? videos('v', 8, 'videos') : videos('s', 8, 'streams')), ...videos(tab === 'videos' ? 'n' : 'm', 2, tab)]);
    const r = await checkChannel(deps(), c);
    expect(r).toEqual({ added: 4, error: null });
    expect(calls.map((x) => x.limit)).toEqual([CHECK_PER_TAB, CHECK_PER_TAB]);
    expect(calls[0].url).toBe(`https://www.youtube.com/channel/${UC}`);
    expect(await checkChannel(deps(), c)).toEqual({ added: 0, error: null });
  });

  it('never brings back a dismissed video', async () => {
    const c = await addChannel(deps(), '@example');
    const first = store.listFeed()[0].videoId;
    store.dismiss(first);
    await checkChannel(deps(), c);
    expect(store.listFeed().map((f) => f.videoId)).not.toContain(first);
  });

  it('keeps the feed and the last good time when the check fails, and records why', async () => {
    const c = await addChannel(deps(), '@example');
    const before = store.getChannel(c.id)?.lastCheckedAt;
    behavior = () => new BgtError('DownloadFailed', 'network down');
    const r = await checkChannel(deps(), c);
    expect(r.added).toBe(0);
    expect(r.error).toContain('network down');
    expect(store.listFeed()).toHaveLength(16);
    expect(store.getChannel(c.id)).toMatchObject({ lastCheckedAt: before, lastError: expect.stringContaining('network down') });
  });

  it('counts a missing Streams tab as nothing new, not as a failure', async () => {
    const c = await addChannel(deps(), '@example');
    behavior = (tab) => (tab === 'videos' ? listing(videos('v', 8, 'videos')) : new BgtError('DownloadFailed', 'no streams tab'));
    expect(await checkChannel(deps(), c)).toEqual({ added: 0, error: null });
  });

  it('rethrows an abort instead of recording it as a channel error', async () => {
    const c = await addChannel(deps(), '@example');
    const controller = new AbortController();
    behavior = () => {
      controller.abort();
      return Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(checkChannel(deps(), c, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.getChannel(c.id)?.lastError).toBeNull();
  });
});
