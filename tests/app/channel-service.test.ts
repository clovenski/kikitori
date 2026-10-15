import { beforeEach, describe, expect, it } from 'vitest';
import { buildFeed, toChannelInfo } from '../../src/app/main/channel-service';
import { ChannelStore } from '../../src/core/db/channel-repo';
import { Repo } from '../../src/core/db/repo';
import { migrate } from '../../src/core/db/schema';
import { Database } from '../../src/core/db/sqlite';

let store: ChannelStore;
let repo: Repo;
let channelId: number;
beforeEach(() => {
  const db = new Database(':memory:');
  migrate(db);
  store = new ChannelStore(db);
  repo = new Repo(db);
  channelId = store.addChannel({ youtubeChannelId: 'UCa', handle: '@a', title: 'Channel A', url: 'https://www.youtube.com/channel/UCa' }).id;
});

const settings = { model: 'large-v3', language: 'ja', maxMinutes: 30 };
const feedOf = (...ids: string[]) =>
  store.addItems(channelId, ids.map((videoId) => ({ videoId, title: `T ${videoId}`, durationMs: 90_000, tab: 'videos' as const })));

describe('toChannelInfo', () => {
  it('exposes the fields the screen needs', () => {
    const c = store.getChannel(channelId)!;
    expect(toChannelInfo(c)).toEqual({ id: channelId, youtubeChannelId: 'UCa', handle: '@a', title: 'Channel A', url: 'https://www.youtube.com/channel/UCa', lastCheckedAt: null, lastError: null });
  });
});

describe('buildFeed', () => {
  it('marks videos that already have a job, including older jobs that only have the URL', () => {
    feedOf('aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc');
    const withId = repo.createJob({ source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', rangeStartMs: 0, rangeEndMs: 1, settings, videoId: 'aaaaaaaaaaa' });
    const legacy = repo.createJob({ source: 'https://youtu.be/bbbbbbbbbbb', rangeStartMs: 0, rangeEndMs: 1, settings });
    repo.setJobStatus(withId.id, 'done');
    const feed = buildFeed(store, repo);
    const by = Object.fromEntries(feed.map((f) => [f.videoId, f.job]));
    expect(by.aaaaaaaaaaa).toEqual({ jobId: withId.id, status: 'done' });
    expect(by.bbbbbbbbbbb).toEqual({ jobId: legacy.id, status: 'pending' });
    expect(by.ccccccccccc).toBeNull();
  });

  it('prefers a finished job over a newer unfinished one for the same video', () => {
    feedOf('aaaaaaaaaaa');
    const done = repo.createJob({ source: 'x', rangeStartMs: 0, rangeEndMs: 1, settings, videoId: 'aaaaaaaaaaa' });
    repo.setJobStatus(done.id, 'done');
    repo.createJob({ source: 'y', rangeStartMs: 0, rangeEndMs: 1, settings, videoId: 'aaaaaaaaaaa' });
    expect(buildFeed(store, repo)[0].job).toEqual({ jobId: done.id, status: 'done' });
  });

  it('carries the item fields and skips dismissed ones', () => {
    feedOf('aaaaaaaaaaa', 'bbbbbbbbbbb');
    store.dismiss('aaaaaaaaaaa');
    const feed = buildFeed(store, repo);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ videoId: 'bbbbbbbbbbb', channelId, channelTitle: 'Channel A', title: 'T bbbbbbbbbbb', durationMs: 90_000, tab: 'videos' });
  });
});
