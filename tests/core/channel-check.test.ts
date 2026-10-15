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
let honorLimit = false; // yt-dlp returns at most `limit` entries from the top of a tab
const deps = (): ChannelDeps => ({
  store,
  ytdlpPath: () => 'yt-dlp.exe',
  log: () => {},
  list: async (a) => {
    calls.push({ url: a.url, tab: a.tab, limit: a.limit });
    const r = behavior(a.tab);
    if (r instanceof Error) throw r;
    return honorLimit ? { ...r, items: r.items.slice(0, a.limit) } : r;
  },
});

beforeEach(() => {
  const db = new Database(':memory:');
  migrate(db);
  let tick = 0;
  store = new ChannelStore(db, () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString());
  calls = [];
  honorLimit = false;
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
    behavior = (tab) => listing([...videos(tab === 'videos' ? 'n' : 'm', 2, tab), ...(tab === 'videos' ? videos('v', 8, 'videos') : videos('s', 8, 'streams'))]);
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

describe('checkChannel after the first fill', () => {
  const twenty = (tab: ChannelTab) => listing(videos(tab === 'videos' ? 'v' : 's', 20, tab));

  it('does not pull in the older videos that the bigger check window now reaches', async () => {
    honorLimit = true;
    behavior = twenty;
    const c = await addChannel(deps(), '@example');
    expect(store.listFeed()).toHaveLength(2 * INITIAL_PER_TAB);
    expect(await checkChannel(deps(), c)).toEqual({ added: 0, error: null });
    expect(store.listFeed()).toHaveLength(2 * INITIAL_PER_TAB);
  });

  it('adds only what was published since, newest first, and stops at the first video it knew', async () => {
    honorLimit = true;
    behavior = twenty;
    const c = await addChannel(deps(), '@example');
    behavior = (tab) => listing([...videos(tab === 'videos' ? 'n' : 'm', 2, tab), ...twenty(tab).items]);
    expect(await checkChannel(deps(), c)).toEqual({ added: 4, error: null });
    const ids = store.listFeed().map((f) => f.videoId);
    expect(ids.slice(0, 4).sort()).toEqual(['m0000000000', 'm0000000001', 'n0000000000', 'n0000000001']);
    expect(ids).toHaveLength(2 * INITIAL_PER_TAB + 4);
  });

  it('still stops at a known video when the newest one was removed from the channel', async () => {
    honorLimit = true;
    behavior = twenty;
    const c = await addChannel(deps(), '@example');
    behavior = (tab) => listing([...videos(tab === 'videos' ? 'n' : 'm', 1, tab), ...twenty(tab).items.slice(1)]);
    expect(await checkChannel(deps(), c)).toEqual({ added: 2, error: null });
  });

  it('a dismissed video still marks where the known part begins', async () => {
    honorLimit = true;
    behavior = twenty;
    const c = await addChannel(deps(), '@example');
    store.dismissAll();
    expect(await checkChannel(deps(), c)).toEqual({ added: 0, error: null });
    expect(store.listFeed()).toEqual([]);
  });

  it('takes everything in the window when more than a window of videos came out since the last check', async () => {
    honorLimit = true;
    behavior = twenty;
    const c = await addChannel(deps(), '@example');
    behavior = (tab) => listing(videos(tab === 'videos' ? 'n' : 'm', 20, tab));
    expect(await checkChannel(deps(), c)).toEqual({ added: 2 * CHECK_PER_TAB, error: null });
  });

  it('a tab that had nothing at the first fill starts with 5 when it begins to work, not 15', async () => {
    honorLimit = true;
    behavior = (tab) => (tab === 'videos' ? twenty(tab) : new BgtError('DownloadFailed', 'temporary failure'));
    const c = await addChannel(deps(), '@example');
    expect(store.listFeed().filter((f) => f.tab === 'streams')).toHaveLength(0);
    behavior = twenty;
    expect(await checkChannel(deps(), c)).toEqual({ added: INITIAL_PER_TAB, error: null });
    expect(store.listFeed().filter((f) => f.tab === 'streams')).toHaveLength(INITIAL_PER_TAB);
  });
});
