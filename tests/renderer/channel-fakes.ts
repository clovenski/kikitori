import { vi } from 'vitest';
import type { BgtApi, ChannelInfo, FeedItem } from '../../src/app/shared/ipc';

export const channel = (id: number, over: Partial<ChannelInfo> = {}): ChannelInfo => ({
  id,
  youtubeChannelId: `UC${id}`,
  handle: `@chan${id}`,
  title: `Channel ${id}`,
  url: `https://www.youtube.com/channel/UC${id}`,
  lastCheckedAt: null,
  lastError: null,
  ...over,
});

export const feedItem = (videoId: string, over: Partial<FeedItem> = {}): FeedItem => ({
  videoId,
  channelId: 1,
  channelTitle: 'Channel 1',
  title: `Video ${videoId}`,
  durationMs: 125_000,
  tab: 'videos',
  firstSeenAt: '2026-01-01T00:00:00Z',
  job: null,
  queued: false,
  ...over,
});

export function fakeChannelsApi(over: { channels?: ChannelInfo[]; feed?: FeedItem[]; addError?: string } = {}) {
  const listeners = new Set<() => void>();
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const channels = {
    list: vi.fn(async () => ok(over.channels ?? [])),
    add: vi.fn(async (input: string) =>
      over.addError ? { ok: false as const, error: { code: 'InvalidInput', message: over.addError } } : ok(channel(9, { title: input })),
    ),
    remove: vi.fn<(id: number) => Promise<ReturnType<typeof ok<null>>>>(async () => ok(null)),
    refresh: vi.fn<(id?: number) => Promise<ReturnType<typeof ok<null>>>>(async () => ok(null)),
    feed: vi.fn(async () => ok(over.feed ?? [])),
    dismiss: vi.fn<(videoId: string) => Promise<ReturnType<typeof ok<null>>>>(async () => ok(null)),
    dismissAll: vi.fn<(channelId?: number) => Promise<ReturnType<typeof ok<null>>>>(async () => ok(null)),
    onChanged: (cb: () => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  return { channels, api: { channels } as unknown as BgtApi, emitChanged: () => listeners.forEach((cb) => cb()) };
}
