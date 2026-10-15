import { describe, expect, it } from 'vitest';
import { listChannelTab, parseChannelListing } from '../../src/core/channels/listing';
import type { RunResult } from '../../src/core/tools/process';

const UC = 'UCabcdefghijklmnopqrstuv';
const entry = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Title ${id}`, duration: 120, live_status: null, ...over });
const listing = (entries: unknown[], over: Record<string, unknown> = {}) => ({
  channel_id: UC,
  channel: 'Example Channel',
  uploader_id: '@example',
  channel_url: `https://www.youtube.com/channel/${UC}`,
  entries,
  ...over,
});

describe('parseChannelListing', () => {
  it('reads the channel and the finished videos', () => {
    const r = parseChannelListing(listing([entry('aaaaaaaaaaa'), entry('bbbbbbbbbbb', { duration: 61.5, live_status: 'was_live' })]), 'streams');
    expect(r.channel).toEqual({ youtubeChannelId: UC, handle: '@example', title: 'Example Channel', url: `https://www.youtube.com/channel/${UC}` });
    expect(r.items).toEqual([
      { videoId: 'aaaaaaaaaaa', title: 'Title aaaaaaaaaaa', durationMs: 120_000, tab: 'streams' },
      { videoId: 'bbbbbbbbbbb', title: 'Title bbbbbbbbbbb', durationMs: 61_500, tab: 'streams' },
    ]);
  });

  it('drops live, upcoming and premiering videos and entries that are not plain videos', () => {
    const r = parseChannelListing(
      listing([
        entry('aaaaaaaaaaa', { live_status: 'is_live', duration: null }),
        entry('bbbbbbbbbbb', { live_status: 'is_upcoming', duration: null }),
        entry('ccccccccccc', { live_status: 'post_live' }),
        entry('ddddddddddd', { duration: null }),
        entry('eeeeeeeeeee', { duration: 0 }),
        entry('too-short'),
        { title: 'no id' },
        entry('fffffffffff'),
      ]),
      'videos',
    );
    expect(r.items.map((i) => i.videoId)).toEqual(['fffffffffff']);
  });

  it('copes with missing optional fields and an empty channel', () => {
    const r = parseChannelListing({ channel_id: UC, entries: [] }, 'videos');
    expect(r.channel).toEqual({ youtubeChannelId: UC, handle: null, title: UC, url: `https://www.youtube.com/channel/${UC}` });
    expect(r.items).toEqual([]);
    expect(parseChannelListing(listing([entry('aaaaaaaaaaa', { title: '' })]), 'videos').items[0].title).toBe('aaaaaaaaaaa');
  });

  it('refuses output that has no channel id', () => {
    for (const bad of [null, 'text', {}, { entries: [] }, { channel_id: 'not-a-channel' }]) {
      expect(() => parseChannelListing(bad, 'videos')).toThrow(expect.objectContaining({ code: 'DownloadFailed' }));
    }
  });
});

describe('listChannelTab', () => {
  const ok = (json: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(json), stderr: '' });
  const base = { ytdlpPath: 'yt-dlp.exe', url: `https://www.youtube.com/channel/${UC}`, limit: 5 };

  it('asks yt-dlp for a flat listing of the tab and parses it', async () => {
    let seen: string[] = [];
    const r = await listChannelTab({
      ...base,
      tab: 'streams',
      run: async (_cmd, args) => {
        seen = args;
        return ok(listing([entry('aaaaaaaaaaa')]));
      },
    });
    expect(seen).toEqual(expect.arrayContaining(['--flat-playlist', '--playlist-end', '5', '-J']));
    expect(seen.at(-1)).toBe(`https://www.youtube.com/channel/${UC}/streams`);
    expect(r.items).toHaveLength(1);
  });

  it('turns a yt-dlp failure into a message with its last line and the update hint', async () => {
    const err = await listChannelTab({
      ...base,
      tab: 'videos',
      run: async () => ({ code: 1, stdout: '', stderr: 'noise\nERROR: This channel does not have a streams tab' }),
    }).catch((e) => e);
    expect(err.code).toBe('DownloadFailed');
    expect(err.message).toContain('This channel does not have a streams tab');
    expect(err.message).toMatch(/Update yt-dlp/);
  });

  it('reports unreadable output', async () => {
    await expect(
      listChannelTab({ ...base, tab: 'videos', run: async () => ({ code: 0, stdout: 'not json', stderr: '' }) }),
    ).rejects.toMatchObject({ code: 'DownloadFailed' });
  });
});
