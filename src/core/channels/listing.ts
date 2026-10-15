import { BgtError } from '../errors';
import type { FeedTab } from '../db/channel-repo';
import { runProcess } from '../tools/process';

export type ChannelTab = FeedTab;

export interface ChannelVideo {
  videoId: string;
  title: string;
  durationMs: number;
  tab: ChannelTab;
}

export interface ChannelMeta {
  youtubeChannelId: string;
  handle: string | null;
  title: string;
  url: string;
}

export interface ChannelListing {
  channel: ChannelMeta;
  items: ChannelVideo[];
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const UNFINISHED = new Set(['is_live', 'is_upcoming', 'post_live']);
const HINT = 'YouTube changes often: open Tools and choose Update yt-dlp, then try again.';

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Turns yt-dlp's `-J --flat-playlist` output for one channel tab into the channel and its finished videos. */
export function parseChannelListing(json: unknown, tab: ChannelTab): ChannelListing {
  const root = asObject(json);
  const id = root ? asString(root.channel_id) : null;
  if (!root || !id || !CHANNEL_ID.test(id)) {
    throw new BgtError('DownloadFailed', 'Could not find that channel.');
  }
  const uploader = asString(root.uploader_id);
  const channel: ChannelMeta = {
    youtubeChannelId: id,
    handle: uploader?.startsWith('@') ? uploader : null,
    title: asString(root.channel) ?? asString(root.uploader) ?? id,
    url: `https://www.youtube.com/channel/${id}`,
  };
  const items: ChannelVideo[] = [];
  for (const raw of Array.isArray(root.entries) ? root.entries : []) {
    const e = asObject(raw);
    if (!e) continue;
    const videoId = asString(e.id);
    const duration = typeof e.duration === 'number' ? e.duration : 0;
    const status = typeof e.live_status === 'string' ? e.live_status : '';
    if (!videoId || !VIDEO_ID.test(videoId) || duration <= 0 || UNFINISHED.has(status)) continue;
    items.push({ videoId, title: asString(e.title) ?? videoId, durationMs: Math.round(duration * 1000), tab });
  }
  return { channel, items };
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';

export async function listChannelTab(a: {
  ytdlpPath: string;
  /** Canonical channel URL without a tab. */
  url: string;
  tab: ChannelTab;
  /** How many entries to read from the top of the tab. */
  limit: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  run?: typeof runProcess;
}): Promise<ChannelListing> {
  const run = a.run ?? runProcess;
  const args = [
    '--flat-playlist',
    '--playlist-end',
    String(a.limit),
    '--no-warnings',
    '--encoding',
    'utf-8',
    // YouTube extraction needs a JS runtime; node is already required to run this tool.
    '--js-runtimes',
    'node',
    '--extractor-args',
    'youtube:player_client=default,-ios',
    '-J',
    `${a.url.replace(/\/+$/, '')}/${a.tab}`,
  ];
  const r = await run(a.ytdlpPath, args, { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('DownloadFailed', `yt-dlp could not read the channel: ${lastLine(r.stderr)}. ${HINT}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new BgtError('DownloadFailed', `yt-dlp returned something unreadable for the channel. ${HINT}`);
  }
  return parseChannelListing(json, a.tab);
}
