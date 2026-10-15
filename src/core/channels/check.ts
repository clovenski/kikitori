import type { Channel, ChannelStore, NewFeedItem } from '../db/channel-repo';
import { BgtError } from '../errors';
import { normalizeChannelInput } from './channel-url';
import { listChannelTab, type ChannelListing, type ChannelMeta, type ChannelTab } from './listing';

/** Videos read from each tab when a channel is added, and on every later check. */
export const INITIAL_PER_TAB = 5;
export const CHECK_PER_TAB = 15;

export interface ChannelDeps {
  store: ChannelStore;
  ytdlpPath(): string;
  /** Injectable for tests. */
  list?: typeof listChannelTab;
  log?(message: string): void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const TABS: ChannelTab[] = ['videos', 'streams'];

/**
 * Lists both tabs of a channel, one after the other. A tab that fails (a channel without a Streams tab) counts as empty
 * as long as the other one worked; when both fail the first error is thrown.
 */
async function listBoth(
  deps: ChannelDeps,
  url: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ channel: ChannelMeta; items: NewFeedItem[] }> {
  const list = deps.list ?? listChannelTab;
  let channel: ChannelMeta | null = null;
  let firstError: unknown = null;
  const items: NewFeedItem[] = [];
  for (const tab of TABS) {
    signal?.throwIfAborted();
    try {
      const r: ChannelListing = await list({ ytdlpPath: deps.ytdlpPath(), url, tab, limit, signal });
      channel ??= r.channel;
      items.push(...r.items.map((i) => ({ videoId: i.videoId, title: i.title, durationMs: i.durationMs, tab: i.tab })));
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
      firstError ??= err;
      deps.log?.(`Channels: the ${tab} tab of ${url} could not be read: ${message(err)}`);
    }
  }
  if (!channel) throw firstError ?? new BgtError('DownloadFailed', 'Could not find that channel.');
  return { channel, items };
}

/** Follows a channel (any URL form, @handle or channel id) and fills its feed. */
export async function addChannel(deps: ChannelDeps, input: string, signal?: AbortSignal): Promise<Channel> {
  const url = normalizeChannelInput(input);
  let listed;
  try {
    listed = await listBoth(deps, url, INITIAL_PER_TAB, signal);
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
    throw new BgtError('DownloadFailed', `Could not find that channel. ${message(err)}`, { cause: err });
  }
  if (deps.store.findByYoutubeId(listed.channel.youtubeChannelId)) {
    throw new BgtError('InvalidInput', 'You already follow this channel.');
  }
  const channel = deps.store.addChannel(listed.channel);
  deps.store.addItems(channel.id, listed.items);
  deps.store.recordCheck(channel.id, null);
  return deps.store.getChannel(channel.id) as Channel;
}

/** Looks for videos the channel has not shown before. Errors are recorded on the channel, never thrown (except aborts). */
export async function checkChannel(
  deps: ChannelDeps,
  channel: Channel,
  signal?: AbortSignal,
): Promise<{ added: number; error: string | null }> {
  try {
    const listed = await listBoth(deps, channel.url, CHECK_PER_TAB, signal);
    const added = deps.store.addItems(channel.id, listed.items);
    deps.store.recordCheck(channel.id, null);
    return { added, error: null };
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
    const text = message(err);
    deps.store.recordCheck(channel.id, text);
    deps.log?.(`Channels: checking "${channel.title}" failed: ${text}`);
    return { added: 0, error: text };
  }
}
