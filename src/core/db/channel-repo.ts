import type { Database } from './sqlite';

export type FeedTab = 'videos' | 'streams';

export interface Channel {
  id: number;
  youtubeChannelId: string;
  handle: string | null;
  title: string;
  url: string;
  addedAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface NewFeedItem {
  videoId: string;
  title: string;
  durationMs: number | null;
  tab: FeedTab;
}

export interface FeedRow extends NewFeedItem {
  channelId: number;
  channelTitle: string;
  firstSeenAt: string;
}

interface ChannelDb {
  id: number;
  youtube_channel_id: string;
  handle: string | null;
  title: string;
  url: string;
  added_at: string;
  last_checked_at: string | null;
  last_error: string | null;
}

interface FeedDb {
  video_id: string;
  channel_id: number;
  channel_title: string;
  title: string;
  duration_ms: number | null;
  tab: FeedTab;
  first_seen_at: string;
}

const toChannel = (r: ChannelDb): Channel => ({
  id: r.id,
  youtubeChannelId: r.youtube_channel_id,
  handle: r.handle,
  title: r.title,
  url: r.url,
  addedAt: r.added_at,
  lastCheckedAt: r.last_checked_at,
  lastError: r.last_error,
});

export class ChannelStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  addChannel(input: { youtubeChannelId: string; handle: string | null; title: string; url: string }): Channel {
    const info = this.db
      .prepare('INSERT INTO channels (youtube_channel_id, handle, title, url, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.youtubeChannelId, input.handle, input.title, input.url, this.now());
    return this.getChannel(info.lastInsertRowid) as Channel;
  }

  getChannel(id: number): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelDb | undefined;
    return row ? toChannel(row) : undefined;
  }

  findByYoutubeId(youtubeChannelId: string): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM channels WHERE youtube_channel_id = ?').get(youtubeChannelId) as ChannelDb | undefined;
    return row ? toChannel(row) : undefined;
  }

  listChannels(): Channel[] {
    return (this.db.prepare('SELECT * FROM channels ORDER BY id').all() as ChannelDb[]).map(toChannel);
  }

  /** Deletes the channel and its feed items (done by hand: SQLite foreign keys are not relied on). */
  removeChannel(id: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM feed_items WHERE channel_id = ?').run(id);
      this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    })();
  }

  /** A good check stamps the time and clears the error; a failed one only records the error. */
  recordCheck(id: number, error: string | null): void {
    if (error === null) {
      this.db.prepare('UPDATE channels SET last_checked_at = ?, last_error = NULL WHERE id = ?').run(this.now(), id);
    } else {
      this.db.prepare('UPDATE channels SET last_error = ? WHERE id = ?').run(error, id);
    }
  }

  /** Adds videos not seen before and returns how many were new; dismissed videos stay dismissed. */
  addItems(channelId: number, items: NewFeedItem[]): number {
    const at = this.now();
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO feed_items (video_id, channel_id, title, duration_ms, tab, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    let added = 0;
    this.db.transaction(() => {
      for (const i of items) added += insert.run(i.videoId, channelId, i.title, i.durationMs, i.tab, at).changes;
    })();
    return added;
  }

  /** Every video this channel has shown (dismissed ones too) with the tab it came from, oldest first. */
  knownVideos(channelId: number): Map<string, FeedTab> {
    const rows = this.db.prepare('SELECT video_id, tab FROM feed_items WHERE channel_id = ? ORDER BY rowid').all(channelId) as {
      video_id: string;
      tab: FeedTab;
    }[];
    return new Map(rows.map((r) => [r.video_id, r.tab]));
  }

  /** Not-dismissed items, newest first; items from one check keep the order the listing gave them. */
  listFeed(): FeedRow[] {
    const rows = this.db
      .prepare(
        `SELECT f.video_id, f.channel_id, c.title AS channel_title, f.title, f.duration_ms, f.tab, f.first_seen_at
         FROM feed_items f JOIN channels c ON c.id = f.channel_id
         WHERE f.dismissed = 0
         ORDER BY f.first_seen_at DESC, f.rowid ASC`,
      )
      .all() as FeedDb[];
    return rows.map((r) => ({
      videoId: r.video_id,
      channelId: r.channel_id,
      channelTitle: r.channel_title,
      title: r.title,
      durationMs: r.duration_ms,
      tab: r.tab,
      firstSeenAt: r.first_seen_at,
    }));
  }

  dismiss(videoId: string): void {
    this.db.prepare('UPDATE feed_items SET dismissed = 1 WHERE video_id = ?').run(videoId);
  }

  dismissAll(channelId?: number): void {
    if (channelId === undefined) this.db.prepare('UPDATE feed_items SET dismissed = 1').run();
    else this.db.prepare('UPDATE feed_items SET dismissed = 1 WHERE channel_id = ?').run(channelId);
  }
}
