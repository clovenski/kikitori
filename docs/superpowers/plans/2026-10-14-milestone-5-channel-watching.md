# Milestone 5: Channel Watching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user follows YouTube channels in Kikitori; new videos and finished live-stream recordings appear in a feed that is refreshed while the app is open, and Process opens the normal New job dialog for any of them.

**Architecture:** An Electron-free `src/core/channels` module lists a channel's Videos and Streams tabs with the bundled yt-dlp (`--flat-playlist -J`), parses and filters the result, and stores channels and feed items in two new SQLite tables (`ChannelStore`). A main-process `ChannelWatcher` runs the checks (start delay, 30-minute interval, one at a time) and broadcasts changes. New IPC channels expose the data to a Channels screen in the renderer; "processed" is derived from existing jobs.

**Tech Stack:** TypeScript, `node:sqlite` adapter, yt-dlp, Electron 44, React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-milestone-5-channel-watching-design.md`

## Global Constraints

- Windows x64; `src/core` stays free of Electron and React (ESLint enforces it); the renderer may import only types plus `core/time`, `core/errors`, `core/youtube`, `core/source-text`, `core/bytes`; `src/app/shared` may only import types.
- No API keys and no YouTube Data API; the only data source is the bundled yt-dlp. No automatic processing, no background checking when the app is closed, no notifications.
- Constants (easy to change, defined once in `src/core/channels/check.ts` and `channel-watcher.ts`): 5 videos per tab for the initial fill, 15 per tab for later checks, first check 15 s after start, interval 30 minutes, 1 s pause between channels.
- Never commit downloaded media, transcripts or real third-party channel content (tests use invented ids and titles).
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (pass it as a second `-m`).
- Tooling notes: the repo folder is `C:\Users\Joel\source\repos\kikitori`; the app command is `pnpm kikitori ...`. The Bash tool eats backslashes in inline scripts, so create and edit files with the Write/Edit tools (or `node` scripts that use `String.fromCharCode(92)`); repo files mix CRLF and LF, so re-read a file when an edit does not match. Work on branch `milestone-5`.

## Review Focus

Failure modes the spec implies that no single task's happy path covers (each gets a test in the named task):

1. Listing oddities: a channel with no Streams tab, live or upcoming streams and premieres (no duration), a removed or private channel, and a channel with no videos at all must each end in a sensible feed or error and never break the other channels (Tasks 2, 3, 4).
2. A re-check must not resurrect dismissed videos, must not re-add existing ones, and an offline check must keep the feed and the last good "checked" time (Tasks 1, 3).
3. Quitting while a check runs must not leave a yt-dlp child behind (Tasks 4, 5).
4. A video that already has a job (including older jobs without `video_id`) must show "Open in library" and not count in the badge (Tasks 5, 6).
5. Channel input forms: unicode handles, trailing tab paths (`/videos`, `/featured`), watch/playlist/Shorts URLs (rejected), and the same channel added by handle and by channel id (second add refused) (Tasks 2, 3).

---

## Task 0: Branch

- [ ] **Step 1:** Run `git switch -c milestone-5` (from `master`, tree clean).

---

## Task 1: Migration 4 and `ChannelStore`

**Files:**
- Modify: `src/core/db/schema.ts`, `tests/core/repo.test.ts` (the expected `user_version` becomes 4)
- Create: `src/core/db/channel-repo.ts`
- Test: `tests/core/channel-repo.test.ts`

**Interfaces:**
- Produces (`src/core/db/channel-repo.ts`):
  - `type FeedTab = 'videos' | 'streams'`
  - `interface Channel { id: number; youtubeChannelId: string; handle: string | null; title: string; url: string; addedAt: string; lastCheckedAt: string | null; lastError: string | null }`
  - `interface NewFeedItem { videoId: string; title: string; durationMs: number | null; tab: FeedTab }`
  - `interface FeedRow extends NewFeedItem { channelId: number; channelTitle: string; firstSeenAt: string }`
  - `class ChannelStore(db, now?)` with `addChannel(input: { youtubeChannelId; handle; title; url }): Channel`, `getChannel(id)`, `findByYoutubeId(youtubeChannelId)`, `listChannels(): Channel[]`, `removeChannel(id): void`, `recordCheck(id, error: string | null): void`, `addItems(channelId, items: NewFeedItem[]): number`, `listFeed(): FeedRow[]`, `dismiss(videoId): void`, `dismissAll(channelId?: number): void`

- [ ] **Step 1: Write the failing tests**

In `tests/core/repo.test.ts` change `expect(db.pragma('user_version', { simple: true })).toBe(3);` to `.toBe(4)`.

`tests/core/channel-repo.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/core/channel-repo.test.ts tests/core/repo.test.ts` — Expected: FAIL (module missing, `user_version` is 3).

- [ ] **Step 3: Append the migration** to `MIGRATIONS` in `src/core/db/schema.ts` (after the `submissions` migration, before the closing `];`):

```ts
  `
  CREATE TABLE channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_channel_id TEXT NOT NULL UNIQUE,
    handle TEXT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    added_at TEXT NOT NULL,
    last_checked_at TEXT,
    last_error TEXT
  );
  CREATE TABLE feed_items (
    video_id TEXT PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    title TEXT NOT NULL,
    duration_ms INTEGER,
    tab TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_feed_channel ON feed_items(channel_id, first_seen_at);
  `,
```

- [ ] **Step 4: Implement** `src/core/db/channel-repo.ts`:

```ts
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
```

- [ ] **Step 5: Run and commit**

Run: `pnpm vitest run tests/core/channel-repo.test.ts tests/core/repo.test.ts && pnpm typecheck && pnpm lint` — Expected: PASS.

```bash
git add -A && git commit -m "feat(channels): migration 4 and the channel store" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Channel input, listing and parsing

**Files:**
- Create: `src/core/channels/channel-url.ts`, `src/core/channels/listing.ts`
- Test: `tests/core/channel-url.test.ts`, `tests/core/channel-listing.test.ts`

**Interfaces:**
- Consumes: `runProcess`, `RunResult` (`src/core/tools/process.ts`), `BgtError`, `FeedTab` (Task 1).
- Produces:
  - `normalizeChannelInput(text: string): string` (throws `InvalidInput`)
  - `type ChannelTab = FeedTab`; `interface ChannelVideo { videoId; title; durationMs: number; tab: ChannelTab }`; `interface ChannelMeta { youtubeChannelId; handle: string | null; title; url }`; `interface ChannelListing { channel: ChannelMeta; items: ChannelVideo[] }`
  - `parseChannelListing(json: unknown, tab: ChannelTab): ChannelListing` (throws `DownloadFailed` when there is no channel id)
  - `listChannelTab(a: { ytdlpPath; url; tab; limit; signal?; run? }): Promise<ChannelListing>`

- [ ] **Step 1: Write the failing tests**

`tests/core/channel-url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeChannelInput } from '../../src/core/channels/channel-url';

const UC = 'UCabcdefghijklmnopqrstuv';

describe('normalizeChannelInput', () => {
  it('accepts every way of naming a channel', () => {
    expect(normalizeChannelInput('@NintendoJP')).toBe('https://www.youtube.com/@NintendoJP');
    expect(normalizeChannelInput('  https://www.youtube.com/@NintendoJP  ')).toBe('https://www.youtube.com/@NintendoJP');
    expect(normalizeChannelInput('youtube.com/@NintendoJP/videos')).toBe('https://www.youtube.com/@NintendoJP');
    expect(normalizeChannelInput('https://m.youtube.com/@NintendoJP/featured?si=x')).toBe('https://www.youtube.com/@NintendoJP');
    expect(normalizeChannelInput(UC)).toBe(`https://www.youtube.com/channel/${UC}`);
    expect(normalizeChannelInput(`https://www.youtube.com/channel/${UC}/streams`)).toBe(`https://www.youtube.com/channel/${UC}`);
    expect(normalizeChannelInput('https://www.youtube.com/c/SomeName')).toBe('https://www.youtube.com/c/SomeName');
    expect(normalizeChannelInput('https://www.youtube.com/user/some.name')).toBe('https://www.youtube.com/user/some.name');
  });

  it('keeps unicode handles, also when the URL percent-encodes them', () => {
    expect(normalizeChannelInput('@ゆりまる')).toBe('https://www.youtube.com/@ゆりまる');
    expect(normalizeChannelInput(`https://www.youtube.com/${encodeURIComponent('@ゆりまる')}/videos`)).toBe('https://www.youtube.com/@ゆりまる');
  });

  it('rejects anything that is not a channel', () => {
    for (const bad of [
      '',
      'hello',
      '@a',
      'UCshort',
      'https://www.youtube.com/watch?v=7SHNxjFuw10',
      'https://youtu.be/7SHNxjFuw10',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/shorts/7SHNxjFuw10',
      'https://www.youtube.com/results?search_query=x',
      'https://example.com/@someone',
      'C:\\videos\\clip.mp4',
    ]) {
      expect(() => normalizeChannelInput(bad), bad).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    }
  });
});
```

`tests/core/channel-listing.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/core/channel-url.test.ts tests/core/channel-listing.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** `src/core/channels/channel-url.ts`:

```ts
import { BgtError } from '../errors';

const bad = () => new BgtError('InvalidInput', 'That does not look like a YouTube channel.');
const HANDLE = /^@[\p{L}\p{N}._-]{3,30}$/u;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const NAME = /^[\p{L}\p{N}._-]{1,100}$/u;

/** Turns whatever the user pasted into a canonical channel URL, or throws InvalidInput. */
export function normalizeChannelInput(text: string): string {
  const t = text.trim();
  if (HANDLE.test(t)) return `https://www.youtube.com/${t}`;
  if (CHANNEL_ID.test(t)) return `https://www.youtube.com/channel/${t}`;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw bad();
  }
  if (url.hostname.replace(/^(www|m)\./, '') !== 'youtube.com') throw bad();
  const parts = url.pathname.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [first = '', second = ''] = parts;
  if (HANDLE.test(first)) return `https://www.youtube.com/${first}`;
  if (first === 'channel' && CHANNEL_ID.test(second)) return `https://www.youtube.com/channel/${second}`;
  if ((first === 'c' || first === 'user') && NAME.test(second)) return `https://www.youtube.com/${first}/${second}`;
  throw bad();
}
```

`src/core/channels/listing.ts`:

```ts
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
```

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run tests/core/channel-url.test.ts tests/core/channel-listing.test.ts && pnpm typecheck && pnpm lint` — Expected: PASS.

```bash
git add -A && git commit -m "feat(channels): channel input normalization and yt-dlp listing parser" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Checking and adding channels

**Files:**
- Create: `src/core/channels/check.ts`
- Test: `tests/core/channel-check.test.ts`

**Interfaces:**
- Consumes: `ChannelStore`, `Channel` (Task 1), `listChannelTab`, `ChannelListing`, `normalizeChannelInput` (Task 2).
- Produces: `INITIAL_PER_TAB = 5`, `CHECK_PER_TAB = 15`, `interface ChannelDeps { store: ChannelStore; ytdlpPath(): string; list?: typeof listChannelTab; log?(m: string): void }`, `addChannel(deps, input, signal?): Promise<Channel>`, `checkChannel(deps, channel, signal?): Promise<{ added: number; error: string | null }>`.

- [ ] **Step 1: Write the failing tests** — `tests/core/channel-check.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/core/channel-check.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/core/channels/check.ts`:

```ts
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
```

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run tests/core/channel-check.test.ts && pnpm typecheck && pnpm lint && pnpm test` — Expected: PASS.

```bash
git add -A && git commit -m "feat(channels): add and check channels with per-channel error handling" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 4: `ChannelWatcher`

**Files:**
- Create: `src/app/main/channel-watcher.ts`
- Test: `tests/app/channel-watcher.test.ts`

**Interfaces:**
- Consumes: `ChannelStore`, `Channel` (Task 1).
- Produces: `interface ChannelWatcherDeps { store: ChannelStore; check(channel: Channel, signal: AbortSignal): Promise<{ added: number; error: string | null }>; canRun(): boolean; onChanged(): void; log?(m: string): void; startDelayMs?: number; intervalMs?: number; pauseMs?: number }`, `class ChannelWatcher` with `start(): void`, `stop(): Promise<void>`, `refresh(channelId?: number): Promise<void>`; constants `START_DELAY_MS = 15_000`, `INTERVAL_MS = 1_800_000`, `PAUSE_MS = 1_000`.

- [ ] **Step 1: Write the failing tests** — `tests/app/channel-watcher.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelWatcher, type ChannelWatcherDeps } from '../../src/app/main/channel-watcher';
import { ChannelStore } from '../../src/core/db/channel-repo';
import { migrate } from '../../src/core/db/schema';
import { Database } from '../../src/core/db/sqlite';

let store: ChannelStore;
beforeEach(() => {
  vi.useFakeTimers();
  const db = new Database(':memory:');
  migrate(db);
  store = new ChannelStore(db);
  for (const id of ['UCa', 'UCb', 'UCc']) store.addChannel({ youtubeChannelId: id, handle: null, title: id, url: `https://www.youtube.com/channel/${id}` });
});
afterEach(() => vi.useRealTimers());

function make(over: Partial<ChannelWatcherDeps> = {}) {
  const checked: string[] = [];
  const signals: AbortSignal[] = [];
  const onChanged = vi.fn();
  const deps: ChannelWatcherDeps = {
    store,
    check: async (c, signal) => {
      checked.push(c.youtubeChannelId);
      signals.push(signal);
      return { added: 0, error: null };
    },
    canRun: () => true,
    onChanged,
    log: () => {},
    startDelayMs: 1000,
    intervalMs: 10_000,
    pauseMs: 100,
    ...over,
  };
  return { watcher: new ChannelWatcher(deps), checked, signals, onChanged };
}

describe('ChannelWatcher', () => {
  it('checks every channel after the start delay, then again every interval', async () => {
    const { watcher, checked, onChanged } = make();
    watcher.start();
    await vi.advanceTimersByTimeAsync(900);
    expect(checked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checked).toEqual(['UCa', 'UCb', 'UCc']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checked).toHaveLength(6);
    await watcher.stop();
  });

  it('skips a round while it cannot run and tries again at the next one', async () => {
    let allowed = false;
    const { watcher, checked } = make({ canRun: () => allowed });
    watcher.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(checked).toEqual([]);
    allowed = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checked).toEqual(['UCa', 'UCb', 'UCc']);
    await watcher.stop();
  });

  it('refresh runs a check now, and a second request while one runs shares it', async () => {
    let release = () => {};
    let calls = 0;
    const { watcher } = make({
      check: () => {
        calls++;
        return new Promise((resolve) => (release = () => resolve({ added: 1, error: null })));
      },
    });
    const first = watcher.refresh();
    const second = watcher.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    for (let i = 0; i < 3; i++) {
      release();
      await vi.advanceTimersByTimeAsync(200);
    }
    await Promise.all([first, second]);
    expect(calls).toBe(3); // one per channel, in sequence, and the second request did not start another round
  });

  it('refresh(id) checks only that channel', async () => {
    const { watcher, checked } = make();
    await watcher.refresh(2);
    expect(checked).toEqual(['UCb']);
  });

  it('keeps going after one channel throws and logs it', async () => {
    const log = vi.fn();
    const seen: string[] = [];
    const { watcher } = make({
      log,
      check: async (c) => {
        seen.push(c.youtubeChannelId);
        if (c.youtubeChannelId === 'UCb') throw new Error('database is locked');
        return { added: 0, error: null };
      },
    });
    const done = watcher.refresh();
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(seen).toEqual(['UCa', 'UCb', 'UCc']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('database is locked'));
  });

  it('stop aborts a check in progress, waits for it and cancels the timer', async () => {
    let started: AbortSignal | null = null;
    const { watcher, checked } = make({
      check: (_c, signal) =>
        new Promise((_resolve, reject) => {
          started = signal;
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        }),
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).not.toBeNull();
    await watcher.stop();
    expect((started as unknown as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checked).toEqual([]);
  });

  it('refresh does nothing while it cannot run', async () => {
    const { watcher, checked } = make({ canRun: () => false });
    await watcher.refresh();
    expect(checked).toEqual([]);
  });
});
```

(In the "keeps going" test the unused `checked` from `make` is only there to satisfy the helper; the test records its own list.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/app/channel-watcher.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/app/main/channel-watcher.ts`:

```ts
import type { Channel, ChannelStore } from '../../core/db/channel-repo';

export const START_DELAY_MS = 15_000;
export const INTERVAL_MS = 30 * 60_000;
export const PAUSE_MS = 1_000;

export interface ChannelWatcherDeps {
  store: ChannelStore;
  /** Checks one channel; errors that belong to the channel are recorded by it, only aborts and bugs throw. */
  check(channel: Channel, signal: AbortSignal): Promise<{ added: number; error: string | null }>;
  /** False while the first-run wizard is open, a setup download runs or yt-dlp is missing. */
  canRun(): boolean;
  onChanged(): void;
  log?(message: string): void;
  startDelayMs?: number;
  intervalMs?: number;
  pauseMs?: number;
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Looks for new videos on the followed channels while the app is open: shortly after start, then on an interval. */
export class ChannelWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;

  constructor(private readonly d: ChannelWatcherDeps) {}

  start(): void {
    this.stopped = false;
    this.schedule(this.d.startDelayMs ?? START_DELAY_MS);
  }

  /** Aborts the check in progress (its yt-dlp is killed), waits for it and cancels the timer. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.running;
  }

  /** Checks one channel (or all of them) now. A request that arrives during a check shares that check. */
  refresh(channelId?: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.running ?? this.run(channelId);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().finally(() => this.schedule(this.d.intervalMs ?? INTERVAL_MS));
    }, ms);
  }

  private run(channelId?: number): Promise<void> {
    this.running = this.checkAll(channelId).finally(() => {
      this.running = null;
      this.controller = null;
    });
    return this.running;
  }

  private async checkAll(channelId?: number): Promise<void> {
    if (!this.d.canRun()) return;
    const controller = new AbortController();
    this.controller = controller;
    const channels = this.d.store.listChannels().filter((c) => channelId === undefined || c.id === channelId);
    let checkedAny = false;
    for (let i = 0; i < channels.length; i++) {
      if (controller.signal.aborted) break;
      try {
        await this.d.check(channels[i], controller.signal);
        checkedAny = true;
      } catch (err) {
        if (controller.signal.aborted) break;
        this.d.log?.(`Channels: unexpected error while checking "${channels[i].title}": ${err instanceof Error ? err.message : String(err)}`);
      }
      if (i < channels.length - 1) await delay(this.d.pauseMs ?? PAUSE_MS, controller.signal);
    }
    if (checkedAny) this.d.onChanged();
  }
}
```

- [ ] **Step 4: Run and iterate** — `pnpm vitest run tests/app/channel-watcher.test.ts && pnpm typecheck && pnpm lint`. Expected: PASS. If the "shares it" test is flaky, the expected behaviour is: two refresh calls produce one check per channel in sequence (3 calls total), never concurrently.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(channels): watcher that checks followed channels while the app is open" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 5: IPC, feed service, handlers and main-process wiring

**Files:**
- Create: `src/app/main/channel-service.ts`
- Modify: `src/app/shared/ipc.ts`, `src/app/main/validate.ts`, `src/app/main/handlers.ts`, `src/app/preload/index.ts`, `src/app/main/index.ts`
- Test: `tests/app/channel-service.test.ts`, `tests/app/validate.test.ts` (append), `tests/app/handlers.test.ts` (extend `setup()`)

**Interfaces:**
- Consumes: `ChannelStore`, `Channel` (Task 1), `addChannel`/`checkChannel` (Task 3), `ChannelWatcher` (Task 4), `Repo.listJobs()`, `parseYoutubeId`.
- Produces (`src/app/shared/ipc.ts`): `interface ChannelInfo { id: number; youtubeChannelId: string; handle: string | null; title: string; url: string; lastCheckedAt: string | null; lastError: string | null }`, `interface FeedItem { videoId: string; channelId: number; channelTitle: string; title: string; durationMs: number | null; tab: 'videos' | 'streams'; firstSeenAt: string; job: { jobId: number; status: JobStatus } | null }`, `window.bgt.channels` with `list()`, `add(input)`, `remove(id)`, `refresh(id?)`, `feed()`, `dismiss(videoId)`, `dismissAll(channelId?)`, `onChanged(cb)`; `CHANNELS.channelsList | channelsAdd | channelsRemove | channelsRefresh | feedList | feedDismiss | feedDismissAll | channelsChanged`.
- Produces (`channel-service.ts`): `toChannelInfo(c: Channel): ChannelInfo`, `buildFeed(store: ChannelStore, repo: Repo): FeedItem[]`.
- Produces (`validate.ts`): `parseChannelText(raw): string`, `parseVideoId(raw): string`, `parseOptionalId(raw, what): number | undefined`.
- `HandlerDeps` gains `channels: { store: ChannelStore; add(input: string): Promise<Channel>; refresh(id?: number): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

`tests/app/channel-service.test.ts`:

```ts
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
```

Append to `tests/app/validate.test.ts` (add `parseChannelText, parseOptionalId, parseVideoId` to its import from `../../src/app/main/validate`):

```ts
describe('channel arguments', () => {
  it('parseChannelText trims and refuses empty or huge text', () => {
    expect(parseChannelText('  @name  ')).toBe('@name');
    for (const bad of ['', '   ', null, 5, 'x'.repeat(301)]) {
      expect(() => parseChannelText(bad)).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    }
  });

  it('parseVideoId accepts exactly an 11 character video id', () => {
    expect(parseVideoId('7SHNxjFuw10')).toBe('7SHNxjFuw10');
    for (const bad of ['', 'short', '7SHNxjFuw10x', 'bad id here', 5, null]) {
      expect(() => parseVideoId(bad)).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    }
  });

  it('parseOptionalId allows nothing at all or a positive id', () => {
    expect(parseOptionalId(undefined, 'channel id')).toBeUndefined();
    expect(parseOptionalId(null, 'channel id')).toBeUndefined();
    expect(parseOptionalId(3, 'channel id')).toBe(3);
    expect(() => parseOptionalId('3', 'channel id')).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    expect(() => parseOptionalId(0, 'channel id')).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
  });
});
```

In `tests/app/handlers.test.ts` extend `setup()`: add imports `import { ChannelStore } from '../../src/core/db/channel-repo';`; after `const store = new SubmissionStore(db);` add

```ts
  const channelStore = new ChannelStore(db);
  const addChannel = vi.fn(async (input: string) =>
    channelStore.addChannel({ youtubeChannelId: `UC${input}`, handle: null, title: input, url: `https://www.youtube.com/channel/UC${input}` }),
  );
  const refreshChannels = vi.fn(async (_id?: number) => {});
```

add `channels: { store: channelStore, add: addChannel, refresh: refreshChannels },` after the `transcribeModel:` line of the `createHandlers({...})` call, and return `{ handlers, repo, stages, queue, opened, service, channelStore, addChannel, refreshChannels }`. Then add inside `describe('handlers', ...)`:

```ts
  it('channels:add trims the text, follows the channel and returns it; empty text is refused', async () => {
    const t = setup();
    expect(await t.handlers['channels:add']('  @abc  ')).toMatchObject({ ok: true, value: { title: '@abc', lastError: null } });
    expect(t.addChannel).toHaveBeenCalledWith('@abc');
    expect(await t.handlers['channels:add']('  ')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['channels:list']()).toMatchObject({ ok: true, value: [{ title: '@abc' }] });
  });

  it('channels:add passes a failure back as an error result', async () => {
    const t = setup();
    t.addChannel.mockRejectedValueOnce(new BgtError('InvalidInput', 'You already follow this channel.'));
    expect(await t.handlers['channels:add']('@abc')).toMatchObject({ ok: false, error: { message: 'You already follow this channel.' } });
  });

  it('channels:remove and channels:refresh validate their ids', async () => {
    const t = setup();
    const c = t.channelStore.addChannel({ youtubeChannelId: 'UCx', handle: null, title: 'x', url: 'u' });
    expect(await t.handlers['channels:refresh']()).toEqual({ ok: true, value: null });
    expect(t.refreshChannels).toHaveBeenLastCalledWith(undefined);
    expect(await t.handlers['channels:refresh'](c.id)).toEqual({ ok: true, value: null });
    expect(t.refreshChannels).toHaveBeenLastCalledWith(c.id);
    expect(await t.handlers['channels:refresh']('1')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['channels:remove']('x')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['channels:remove'](c.id)).toEqual({ ok: true, value: null });
    expect(t.channelStore.listChannels()).toEqual([]);
  });

  it('feed:list links videos that already have a job; feed:dismiss and feed:dismissAll validate and persist', async () => {
    const t = setup();
    const c = t.channelStore.addChannel({ youtubeChannelId: 'UCx', handle: null, title: 'x', url: 'u' });
    t.channelStore.addItems(c.id, [
      { videoId: 'aaaaaaaaaaa', title: 'A', durationMs: 1000, tab: 'videos' },
      { videoId: 'bbbbbbbbbbb', title: 'B', durationMs: 1000, tab: 'streams' },
    ]);
    const job = t.repo.createJob({ source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', rangeStartMs: 0, rangeEndMs: 1, settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 }, videoId: 'aaaaaaaaaaa' });
    const feed = await t.handlers['feed:list']();
    expect(feed).toMatchObject({ ok: true, value: [{ videoId: 'aaaaaaaaaaa', job: { jobId: job.id } }, { videoId: 'bbbbbbbbbbb', job: null }] });
    expect(await t.handlers['feed:dismiss']('nope')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['feed:dismiss']('bbbbbbbbbbb')).toEqual({ ok: true, value: null });
    expect(t.channelStore.listFeed().map((f) => f.videoId)).toEqual(['aaaaaaaaaaa']);
    expect(await t.handlers['feed:dismissAll']()).toEqual({ ok: true, value: null });
    expect(t.channelStore.listFeed()).toEqual([]);
  });
```

(The job lives in the `Repo` from `memoryRepos()` and the channel data in the `ChannelStore` on the file's own database; `buildFeed` reads each separately, so the two databases do not need to be the same.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/app/channel-service.test.ts tests/app/validate.test.ts tests/app/handlers.test.ts` — Expected: FAIL (modules and channels missing).

- [ ] **Step 3: Implement the shared types** — in `src/app/shared/ipc.ts`:

Add below the other exported interfaces:

```ts
export interface ChannelInfo {
  id: number;
  youtubeChannelId: string;
  handle: string | null;
  title: string;
  url: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface FeedItem {
  videoId: string;
  channelId: number;
  channelTitle: string;
  title: string;
  durationMs: number | null;
  tab: 'videos' | 'streams';
  firstSeenAt: string;
  /** The job that already exists for this video, if any. */
  job: { jobId: number; status: JobStatus } | null;
}
```

Add to `BgtApi` (after `setup`):

```ts
  channels: {
    list(): Promise<Result<ChannelInfo[]>>;
    add(input: string): Promise<Result<ChannelInfo>>;
    remove(id: number): Promise<Result<null>>;
    /** Checks one channel (or all of them) now and resolves when the check is done. */
    refresh(id?: number): Promise<Result<null>>;
    feed(): Promise<Result<FeedItem[]>>;
    dismiss(videoId: string): Promise<Result<null>>;
    dismissAll(channelId?: number): Promise<Result<null>>;
    onChanged(cb: () => void): () => void;
  };
```

and to `CHANNELS` (after `setupProgress`):

```ts
  channelsList: 'channels:list',
  channelsAdd: 'channels:add',
  channelsRemove: 'channels:remove',
  channelsRefresh: 'channels:refresh',
  feedList: 'feed:list',
  feedDismiss: 'feed:dismiss',
  feedDismissAll: 'feed:dismissAll',
  channelsChanged: 'channels:changed',
```

`src/app/main/channel-service.ts`:

```ts
import type { Channel, ChannelStore } from '../../core/db/channel-repo';
import type { Repo } from '../../core/db/repo';
import { parseYoutubeId } from '../../core/youtube';
import type { ChannelInfo, FeedItem, JobStatus } from '../shared/ipc';

export const toChannelInfo = (c: Channel): ChannelInfo => ({
  id: c.id,
  youtubeChannelId: c.youtubeChannelId,
  handle: c.handle,
  title: c.title,
  url: c.url,
  lastCheckedAt: c.lastCheckedAt,
  lastError: c.lastError,
});

/** The feed with the job (if any) that already exists for each video: matched by video id, or by the URL for older jobs. */
export function buildFeed(store: ChannelStore, repo: Repo): FeedItem[] {
  const jobs = new Map<string, { jobId: number; status: JobStatus }>();
  for (const job of repo.listJobs()) {
    // listJobs is newest first, so the first job seen for a video is its newest one; a finished job wins over it.
    const videoId = job.videoId ?? parseYoutubeId(job.source);
    if (!videoId) continue;
    const seen = jobs.get(videoId);
    if (!seen || (job.status === 'done' && seen.status !== 'done')) jobs.set(videoId, { jobId: job.id, status: job.status });
  }
  return store.listFeed().map((row) => ({
    videoId: row.videoId,
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    title: row.title,
    durationMs: row.durationMs,
    tab: row.tab,
    firstSeenAt: row.firstSeenAt,
    job: jobs.get(row.videoId) ?? null,
  }));
}
```

- [ ] **Step 4: Validators** — append to `src/app/main/validate.ts`:

```ts
export function parseChannelText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '' || text.length > 300) throw invalid('Enter a channel link or @handle.');
  return text;
}

export function parseVideoId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(raw)) throw invalid('Invalid video id.');
  return raw;
}

export function parseOptionalId(raw: unknown, what: string): number | undefined {
  return raw === undefined || raw === null ? undefined : parseId(raw, what);
}
```

- [ ] **Step 5: Handlers** — in `src/app/main/handlers.ts`: add `import type { Channel, ChannelStore } from '../../core/db/channel-repo';`, `import { buildFeed, toChannelInfo } from './channel-service';`, extend the validate import with `parseChannelText, parseOptionalId, parseVideoId`; add to `HandlerDeps`:

```ts
  channels: {
    store: ChannelStore;
    add(input: string): Promise<Channel>;
    refresh(id?: number): Promise<void>;
  };
```

and these entries before `} satisfies Record<string, Handler>;`:

```ts
    [CHANNELS.channelsList]: () => wrap(() => d.channels.store.listChannels().map(toChannelInfo)),
    [CHANNELS.channelsAdd]: (arg?: unknown) => wrap(async () => toChannelInfo(await d.channels.add(parseChannelText(arg)))),
    [CHANNELS.channelsRemove]: (arg?: unknown) =>
      wrap(() => {
        d.channels.store.removeChannel(parseId(arg, 'channel id'));
        return null;
      }),
    [CHANNELS.channelsRefresh]: (arg?: unknown) =>
      wrap(async () => {
        await d.channels.refresh(parseOptionalId(arg, 'channel id'));
        return null;
      }),
    [CHANNELS.feedList]: () => wrap(() => buildFeed(d.channels.store, d.repo)),
    [CHANNELS.feedDismiss]: (arg?: unknown) =>
      wrap(() => {
        d.channels.store.dismiss(parseVideoId(arg));
        return null;
      }),
    [CHANNELS.feedDismissAll]: (arg?: unknown) =>
      wrap(() => {
        d.channels.store.dismissAll(parseOptionalId(arg, 'channel id'));
        return null;
      }),
```

- [ ] **Step 6: Preload** — in `src/app/preload/index.ts` add after the `setup` block:

```ts
  channels: {
    list: () => invoke(CHANNELS.channelsList),
    add: (input) => invoke(CHANNELS.channelsAdd, input),
    remove: (id) => invoke(CHANNELS.channelsRemove, id),
    refresh: (id) => invoke(CHANNELS.channelsRefresh, id),
    feed: () => invoke(CHANNELS.feedList),
    dismiss: (videoId) => invoke(CHANNELS.feedDismiss, videoId),
    dismissAll: (channelId) => invoke(CHANNELS.feedDismissAll, channelId),
    onChanged: (cb) => subscribe<null>(CHANNELS.channelsChanged, () => cb()),
  },
```

- [ ] **Step 7: Main wiring** — in `src/app/main/index.ts` apply, in order:

1. Imports: `import { addChannel as followChannel, checkChannel } from '../../core/channels/check';`, `import { ChannelStore } from '../../core/db/channel-repo';`, `import { ChannelWatcher } from './channel-watcher';`.
2. After `const store = new SubmissionStore(db);` add `const channelStore = new ChannelStore(db);`.
3. Before the line `const pool = createRealModelPool(...)` add:

```ts
  const channelDeps = { store: channelStore, ytdlpPath: () => resolveTool('yt-dlp'), log: (m: string) => console.log(m) };
  const watcher = new ChannelWatcher({
    store: channelStore,
    check: (channel, signal) => checkChannel(channelDeps, channel, signal),
    canRun: () => {
      const state = setup.state();
      if (state.needsWizard || state.installing) return false;
      try {
        resolveTool('yt-dlp');
        return true;
      } catch {
        return false;
      }
    },
    onChanged: () => broadcast(CHANNELS.channelsChanged, null),
    log: (m) => console.log(m),
  });
```

4. In the `createHandlers({...})` call, after `transcribeModel: model,` add `channels: { store: channelStore, add: (input) => followChannel(channelDeps, input), refresh: (id) => watcher.refresh(id) },`.
5. In the non-smoke branch change `queue.start();` to `queue.start();\n    watcher.start();`.
6. In the shutdown steps add `{ name: 'channels', run: () => watcher.stop() },` as the first element.

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build:app && pnpm smoke:app` — Expected: all green; the smoke line still reads `SMOKE OK wizard=false`.

```bash
git add -A && git commit -m "feat(channels): IPC, feed service and main-process wiring" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Channels screen, badge and Process hand-off

**Files:**
- Create: `src/app/renderer/components/ChannelsScreen.tsx`, `tests/renderer/channel-fakes.ts`
- Modify: `src/app/renderer/lib/api.tsx`, `src/app/renderer/lib/format.ts`, `src/app/renderer/components/NewJobDialog.tsx`, `src/app/renderer/App.tsx`, `src/app/renderer/styles.css`
- Test: `tests/renderer/channels-screen.test.tsx`, `tests/renderer/format.test.ts` (append), `tests/renderer/new-job-dialog.test.tsx` (extend), `tests/renderer/app-setup.test.tsx` (extend)

**Interfaces:**
- Consumes: `window.bgt.channels` (Task 5), `ChannelInfo`, `FeedItem`.
- Produces: `useChannels(submissions): { channels: ChannelInfo[]; feed: FeedItem[]; reload(): void }`, `timeAgo(iso: string, now?: number): string`, `<ChannelsScreen channels feed onReload onProcess(videoId) onOpenJob(jobId) />`, `NewJobDialog` prop `initialSource?: string`; test helpers `channel(id, over?)`, `feedItem(videoId, over?)`, `fakeChannelsApi(over?)`.

- [ ] **Step 1: Test helpers and failing tests**

`tests/renderer/channel-fakes.ts`:

```ts
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
    remove: vi.fn(async (_id: number) => ok(null)),
    refresh: vi.fn(async (_id?: number) => ok(null)),
    feed: vi.fn(async () => ok(over.feed ?? [])),
    dismiss: vi.fn(async (_videoId: string) => ok(null)),
    dismissAll: vi.fn(async (_channelId?: number) => ok(null)),
    onChanged: (cb: () => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  return { channels, api: { channels } as unknown as BgtApi, emitChanged: () => listeners.forEach((cb) => cb()) };
}
```

`tests/renderer/format.test.ts` — add `timeAgo` to the import and append:

```ts
describe('timeAgo', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  it('says how long ago in the largest sensible unit', () => {
    expect(timeAgo('2026-01-01T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-01-01T11:55:00Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-01-01T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2025-12-29T12:00:00Z', now)).toBe('3 d ago');
    expect(timeAgo('not a date', now)).toBe('a while ago');
  });
});
```

`tests/renderer/channels-screen.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelsScreen } from '../../src/app/renderer/components/ChannelsScreen';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { ChannelInfo, FeedItem } from '../../src/app/shared/ipc';
import { channel, fakeChannelsApi, feedItem } from './channel-fakes';

afterEach(cleanup);

function renderScreen(over: { channels?: ChannelInfo[]; feed?: FeedItem[]; addError?: string } = {}) {
  const fake = fakeChannelsApi(over);
  const onReload = vi.fn();
  const onProcess = vi.fn();
  const onOpenJob = vi.fn();
  render(
    <ApiProvider api={fake.api}>
      <ChannelsScreen channels={over.channels ?? []} feed={over.feed ?? []} onReload={onReload} onProcess={onProcess} onOpenJob={onOpenJob} />
    </ApiProvider>,
  );
  return { ...fake, onReload, onProcess, onOpenJob };
}

describe('ChannelsScreen', () => {
  it('explains what to do with no channels and always points to New job for other videos', () => {
    renderScreen();
    expect(screen.getByText(/Follow a channel to see its new videos/)).toBeTruthy();
    expect(screen.getByText('Need an older or one-off video? Paste its link into New job.')).toBeTruthy();
  });

  it('follows a channel from what was typed and reloads', async () => {
    const t = renderScreen();
    fireEvent.change(screen.getByLabelText('Channel link or @handle'), { target: { value: '@someone' } });
    fireEvent.click(screen.getByText('Follow'));
    await waitFor(() => expect(t.channels.add).toHaveBeenCalledWith('@someone'));
    await waitFor(() => expect(t.onReload).toHaveBeenCalled());
    expect((screen.getByLabelText('Channel link or @handle') as HTMLInputElement).value).toBe('');
  });

  it('shows why a channel could not be followed and keeps what was typed', async () => {
    const t = renderScreen({ addError: 'Could not find that channel.' });
    fireEvent.change(screen.getByLabelText('Channel link or @handle'), { target: { value: '@nobody' } });
    fireEvent.click(screen.getByText('Follow'));
    expect(await screen.findByText('Could not find that channel.')).toBeTruthy();
    expect(t.onReload).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Channel link or @handle') as HTMLInputElement).value).toBe('@nobody');
  });

  it('shows when each channel was checked and its last error', () => {
    renderScreen({
      channels: [
        channel(1, { lastCheckedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
        channel(2, { lastError: 'yt-dlp could not read the channel', lastCheckedAt: null }),
        channel(3),
      ],
    });
    expect(screen.getByText('Checked 5 min ago')).toBeTruthy();
    expect(screen.getByText('yt-dlp could not read the channel')).toBeTruthy();
    expect(screen.getByText('Not checked yet')).toBeTruthy();
  });

  it('asks before removing a channel and then removes it', async () => {
    const t = renderScreen({ channels: [channel(1)] });
    fireEvent.click(screen.getByText('Remove'));
    expect(screen.getByText(/Remove Channel 1 and its videos from the feed\?/)).toBeTruthy();
    expect(t.channels.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Yes, remove'));
    await waitFor(() => expect(t.channels.remove).toHaveBeenCalledWith(1));
    await waitFor(() => expect(t.onReload).toHaveBeenCalled());
  });

  it('cancelling the removal keeps the channel', () => {
    const t = renderScreen({ channels: [channel(1)] });
    fireEvent.click(screen.getByText('Remove'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(t.channels.remove).not.toHaveBeenCalled();
    expect(screen.queryByText(/Yes, remove/)).toBeNull();
  });

  it('lists feed items with length and a Stream badge, and processes or dismisses them', async () => {
    const t = renderScreen({
      channels: [channel(1)],
      feed: [feedItem('aaaaaaaaaaa'), feedItem('bbbbbbbbbbb', { tab: 'streams', durationMs: 3_725_000 })],
    });
    expect(screen.getByText('Video aaaaaaaaaaa')).toBeTruthy();
    expect(screen.getByText('0:02:05')).toBeTruthy();
    expect(screen.getByText('1:02:05')).toBeTruthy();
    expect(screen.getAllByText('Stream')).toHaveLength(1);
    expect(screen.getAllByRole('img')[0].getAttribute('src')).toBe('https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg');
    fireEvent.click(screen.getAllByText('Process')[1]);
    expect(t.onProcess).toHaveBeenCalledWith('bbbbbbbbbbb');
    fireEvent.click(screen.getAllByText('Dismiss')[0]);
    await waitFor(() => expect(t.channels.dismiss).toHaveBeenCalledWith('aaaaaaaaaaa'));
    await waitFor(() => expect(t.onReload).toHaveBeenCalled());
  });

  it('a video that already has a job shows its status and opens it instead of processing again', () => {
    const t = renderScreen({ channels: [channel(1)], feed: [feedItem('aaaaaaaaaaa', { job: { jobId: 7, status: 'done' } })] });
    expect(screen.queryByText('Process')).toBeNull();
    expect(screen.getByText('Done')).toBeTruthy();
    fireEvent.click(screen.getByText('Open in library'));
    expect(t.onOpenJob).toHaveBeenCalledWith(7);
  });

  it('refreshes all channels and dismisses everything on request', async () => {
    const t = renderScreen({ channels: [channel(1)], feed: [feedItem('aaaaaaaaaaa')] });
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(t.channels.refresh).toHaveBeenCalledWith(undefined));
    fireEvent.click(screen.getByText('Dismiss all'));
    await waitFor(() => expect(t.channels.dismissAll).toHaveBeenCalledWith(undefined));
  });

  it('says so when there is nothing new', () => {
    renderScreen({ channels: [channel(1)] });
    expect(screen.getByText('No new videos right now.')).toBeTruthy();
  });
});
```

`tests/renderer/new-job-dialog.test.tsx` — add this test inside `describe('NewJobDialog', ...)` and let the file's `setup()` helper accept `initialSource` (add `initialSource?: string` to the `over` type and pass `initialSource={over.initialSource}` to `<NewJobDialog ... />`):

```tsx
  it('opens filled in and probed when given an initial source (the Process hand-off)', async () => {
    const probe = vi.fn(async () => ({ ok: true as const, value: { title: 'From the feed', durationMs: 300_000 } }));
    setup({ probe, initialSource: url });
    expect((screen.getByLabelText('YouTube link or file path') as HTMLInputElement).value).toBe(url);
    expect(await screen.findByText('From the feed')).toBeTruthy();
    expect(probe).toHaveBeenCalledTimes(1);
  });
```

`tests/renderer/app-setup.test.tsx` — in `renderApp` make the fake api also include channels: add `import { fakeChannelsApi, feedItem, channel } from './channel-fakes';`, change the signature to `renderApp(needsWizard: boolean, channelsOver: Parameters<typeof fakeChannelsApi>[0] = {})`, create `const ch = fakeChannelsApi(channelsOver);` and spread `...ch.api` into the `api` object (after `...fake.api`, so both `setup` and `channels` are present — keep each fake's own key by spreading `{ setup: fake.setup, channels: ch.channels }` instead of two `api` spreads); return `{ ...fake, ch }`. Then append:

```tsx
describe('App channels', () => {
  it('shows how many videos are new on the Channels button, not counting ones that already have a job', async () => {
    renderApp(false, {
      channels: [channel(1)],
      feed: [feedItem('aaaaaaaaaaa'), feedItem('bbbbbbbbbbb'), feedItem('ccccccccccc', { job: { jobId: 3, status: 'done' } })],
    });
    const button = await screen.findByRole('button', { name: /Channels/ });
    await waitFor(() => expect(button.textContent).toContain('2'));
  });

  it('Process on a feed item opens the New job dialog with its link filled in', async () => {
    renderApp(false, { channels: [channel(1)], feed: [feedItem('7SHNxjFuw10')] });
    fireEvent.click(await screen.findByRole('button', { name: /Channels/ }));
    fireEvent.click(await screen.findByText('Process'));
    const dialog = await screen.findByRole('dialog', { name: 'New job' });
    expect(dialog).toBeTruthy();
    expect((screen.getByLabelText('YouTube link or file path') as HTMLInputElement).value).toBe('https://www.youtube.com/watch?v=7SHNxjFuw10');
  });
});
```

(The existing `app-setup` tests must keep passing with the extra `channels` fake; the New job dialog's probe is not defined on this fake `source` API, so the Process test only asserts the prefilled field — the dialog's `api.source.probe` call must therefore be tolerated: add `source: { probe: async () => ({ ok: false as const, error: { code: 'Error', message: 'offline' } }), estimate: async () => ({ ok: true as const, value: null }) }` to the fake api object.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/renderer` — Expected: the new tests FAIL (component, helper and props missing).

- [ ] **Step 3: Helpers** — append to `src/app/renderer/lib/format.ts`:

```ts
/** "just now", "5 min ago", "3 h ago", "3 d ago". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'a while ago';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
```

In `src/app/renderer/lib/api.tsx` add `ChannelInfo, FeedItem` to the type import and append:

```tsx
/** Followed channels and their feed; reloads on `channels:changed` and whenever the queue changes (a new job links a video). */
export function useChannels(submissions: Submission[]): { channels: ChannelInfo[]; feed: FeedItem[]; reload(): void } {
  const api = useApi();
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void Promise.all([api.channels.list(), api.channels.feed()]).then(([c, f]) => {
      if (!alive) return;
      if (c.ok) setChannels(c.value);
      if (f.ok) setFeed(f.value);
    });
    return () => {
      alive = false;
    };
  }, [api, tick, submissions]);
  useEffect(() => api.channels.onChanged(() => setTick((t) => t + 1)), [api]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { channels, feed, reload };
}
```

- [ ] **Step 4: `ChannelsScreen`** — `src/app/renderer/components/ChannelsScreen.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import type { ChannelInfo, FeedItem } from '../../shared/ipc';
import { useApi } from '../lib/api';
import { formatClock, jobStatusLabel, timeAgo } from '../lib/format';

interface Props {
  channels: ChannelInfo[];
  feed: FeedItem[];
  onReload(): void;
  onProcess(videoId: string): void;
  onOpenJob(jobId: number): void;
}

export function ChannelsScreen({ channels, feed, onReload, onProcess, onOpenJob }: Props) {
  const api = useApi();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

  const follow = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() === '') return;
    setAdding(true);
    setError(null);
    const r = await api.channels.add(text);
    setAdding(false);
    if (r.ok) {
      setText('');
      onReload();
    } else {
      setError(r.error.message);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await api.channels.refresh();
    setRefreshing(false);
    onReload();
  };

  const remove = async (id: number) => {
    setConfirmRemove(null);
    await api.channels.remove(id);
    onReload();
  };

  const dismiss = async (videoId: string) => {
    await api.channels.dismiss(videoId);
    onReload();
  };

  const dismissAll = async () => {
    await api.channels.dismissAll();
    onReload();
  };

  return (
    <div className="channels">
      <h2>Channels</h2>
      <form className="add" onSubmit={(e) => void follow(e)}>
        <input
          type="text"
          aria-label="Channel link or @handle"
          placeholder="@handle or https://www.youtube.com/@..."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="primary" type="submit" disabled={adding}>
          Follow
        </button>
      </form>
      {error && <div className="error">{error}</div>}

      {channels.length === 0 ? (
        <p className="hint">Follow a channel to see its new videos and finished streams here. Kikitori checks while it is open.</p>
      ) : (
        <ul className="channel-list">
          {channels.map((c) => (
            <li key={c.id} className="channel-row">
              <div>
                <div className="title">{c.title}</div>
                <div className="sub">
                  {c.handle ? `${c.handle} - ` : ''}
                  {c.lastCheckedAt ? `Checked ${timeAgo(c.lastCheckedAt)}` : 'Not checked yet'}
                </div>
                {c.lastError && <div className="error">{c.lastError}</div>}
              </div>
              {confirmRemove === c.id ? (
                <div className="inline">
                  <span>{`Remove ${c.title} and its videos from the feed?`}</span>
                  <button className="primary" onClick={() => void remove(c.id)}>
                    Yes, remove
                  </button>
                  <button onClick={() => setConfirmRemove(null)}>Cancel</button>
                </div>
              ) : (
                <button onClick={() => setConfirmRemove(c.id)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="toolbar">
        <h3>New videos</h3>
        <button disabled={refreshing || channels.length === 0} onClick={() => void refresh()}>
          {refreshing ? 'Checking...' : 'Refresh'}
        </button>
        <button disabled={feed.length === 0} onClick={() => void dismissAll()}>
          Dismiss all
        </button>
      </div>
      <p className="hint">Need an older or one-off video? Paste its link into New job.</p>
      {channels.length > 0 && feed.length === 0 && <p className="hint">No new videos right now.</p>}
      <ul className="feed">
        {feed.map((f) => (
          <li key={f.videoId} className="feed-item">
            <img src={`https://i.ytimg.com/vi/${f.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
            <div>
              <div className="title">{f.title}</div>
              <div className="meta">
                <span>{f.channelTitle}</span>
                {f.durationMs !== null && <span>{formatClock(f.durationMs)}</span>}
                {f.tab === 'streams' && <span className="badge">Stream</span>}
                {f.job && <span className="badge">{jobStatusLabel(f.job.status)}</span>}
              </div>
            </div>
            <div className="actions">
              {f.job ? (
                <button onClick={() => onOpenJob((f.job as NonNullable<FeedItem['job']>).jobId)}>Open in library</button>
              ) : (
                <button className="primary" onClick={() => onProcess(f.videoId)}>
                  Process
                </button>
              )}
              <button onClick={() => void dismiss(f.videoId)}>Dismiss</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: `NewJobDialog` accepts an initial source** — in `src/app/renderer/components/NewJobDialog.tsx`: add `initialSource?: string;` to `Props`; destructure it (`{ onClose, onSubmitted, initialSource }`); change the form's initial `source: '',` to `source: initialSource ?? '',`; and add, right after the `runProbe` `useCallback(...)` call (before the "Recompute the estimate" effect):

```tsx
  // Opened from a feed item: the link is already there, so read the video straight away.
  useEffect(() => {
    if (initialSource) void runProbe(initialSource);
  }, []);
```


- [ ] **Step 6: `App.tsx`** — replace the whole file with:

```tsx
import { useEffect, useState } from 'react';
import { ChannelsScreen } from './components/ChannelsScreen';
import { JobScreen } from './components/JobScreen';
import { LibraryScreen } from './components/LibraryScreen';
import { NewJobDialog } from './components/NewJobDialog';
import { QueueStrip } from './components/QueueStrip';
import { ToolsDialog } from './components/ToolsDialog';
import { Wizard } from './components/Wizard';
import { useApi, useChannels, useLibrary, useProgress, useQueue, useSetupState } from './lib/api';

type Route = { name: 'library' } | { name: 'job'; jobId: number } | { name: 'channels' };

export function App() {
  const api = useApi();
  const submissions = useQueue();
  const progress = useProgress();
  const items = useLibrary(submissions);
  const { channels, feed, reload } = useChannels(submissions);
  const { state, refresh } = useSetupState();
  const [route, setRoute] = useState<Route>({ name: 'library' });
  const [newJobOpen, setNewJobOpen] = useState(false);
  const [newJobSource, setNewJobSource] = useState<string | undefined>(undefined);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const openNewJob = (source?: string) => {
    setNewJobSource(source);
    setNewJobOpen(true);
  };
  const updateYtDlp = async () => {
    setNote('Updating yt-dlp...');
    const r = await api.setup.updateYtDlp();
    setNote(r.ok ? r.value : r.error.message);
  };
  // Decided once, when the setup state first arrives: finishing the wizard must not pull it away before the user clicks on.
  const [wizard, setWizard] = useState<boolean | null>(null);
  useEffect(() => {
    if (state && wizard === null) setWizard(state.needsWizard);
  }, [state, wizard]);

  if (wizard === null) return <div className="app" />;
  if (wizard) {
    return (
      <Wizard
        onFinished={() => {
          setWizard(false);
          refresh();
          openNewJob();
        }}
      />
    );
  }

  const newVideos = feed.filter((f) => f.job === null).length;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setRoute({ name: 'library' })}>
          Kikitori
        </button>
        <div className="inline">
          <button onClick={() => setRoute({ name: 'channels' })}>
            Channels
            {newVideos > 0 && <span className="count">{newVideos}</span>}
          </button>
          <button onClick={() => setToolsOpen(true)}>Tools</button>
          <button className="primary" onClick={() => openNewJob()}>
            New job
          </button>
        </div>
      </header>
      <main className="content">
        {note && (
          <div className="notice" role="status">
            {note} <button onClick={() => setNote(null)}>Dismiss</button>
          </div>
        )}
        {route.name === 'library' && (
          <LibraryScreen items={items} submissions={submissions} onOpen={(jobId) => setRoute({ name: 'job', jobId })} onNew={() => openNewJob()} />
        )}
        {route.name === 'job' && <JobScreen jobId={route.jobId} onBack={() => setRoute({ name: 'library' })} />}
        {route.name === 'channels' && (
          <ChannelsScreen
            channels={channels}
            feed={feed}
            onReload={reload}
            onProcess={(videoId) => openNewJob(`https://www.youtube.com/watch?v=${videoId}`)}
            onOpenJob={(jobId) => setRoute({ name: 'job', jobId })}
          />
        )}
      </main>
      <QueueStrip
        submissions={submissions}
        progress={progress}
        onCancel={(id) => void api.queue.cancel(id)}
        onResume={(id) => void api.queue.resume(id)}
        onUpdateYtDlp={() => void updateYtDlp()}
      />
      {newJobOpen && (
        <NewJobDialog
          key={newJobSource ?? 'blank'}
          initialSource={newJobSource}
          onClose={() => setNewJobOpen(false)}
          onSubmitted={() => {
            setNewJobOpen(false);
            setRoute({ name: 'library' });
          }}
        />
      )}
      {toolsOpen && state && <ToolsDialog state={state} onClose={() => setToolsOpen(false)} onChanged={refresh} />}
    </div>
  );
}
```

- [ ] **Step 7: Styles** — append to `src/app/renderer/styles.css`:

```css
.channels { max-width: 900px; margin: 0 auto; display: grid; gap: 12px; }
.channels h2, .channels h3 { margin: 0; }
.channels .add { display: flex; gap: 8px; }
.channels .add input { flex: 1; }
.channels .hint { color: var(--muted); font-size: 12px; margin: 0; }
.channels .error { color: var(--bad); font-size: 12px; }
.channel-list, .feed { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.channel-row { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.channel-row .title { font-weight: 600; }
.channel-row .sub { color: var(--muted); font-size: 12px; }
.feed-item { display: grid; grid-template-columns: 160px 1fr auto; gap: 12px; align-items: center; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.feed-item img { width: 160px; height: 90px; object-fit: cover; border-radius: 6px; background: #000; }
.feed-item .title { font-weight: 600; overflow-wrap: anywhere; }
.feed-item .meta { display: flex; gap: 10px; flex-wrap: wrap; color: var(--muted); font-size: 12px; align-items: center; }
.feed-item .actions { display: grid; gap: 6px; }
.count { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--accent); color: var(--accent-text); font-size: 11px; text-align: center; }
```

- [ ] **Step 8: Run and commit**

Run: `pnpm vitest run tests/renderer && pnpm typecheck && pnpm lint && pnpm test && pnpm build:app && pnpm smoke:app` — Expected: all green.

```bash
git add -A && git commit -m "feat(renderer): Channels screen, new-video badge and Process hand-off to New job" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Real-channel verification and documentation

**Files:**
- Modify: `README.md`, `docs/known-issues.md`
- Scratchpad only (not committed): `drive-channels.mjs`

No product code changes unless a check fails; a failure is fixed test-first in the task that owns the code.

- [ ] **Step 1: Full gate** — `pnpm typecheck && pnpm lint && pnpm test && pnpm build:app && pnpm smoke:app`. Expected: all green.

- [ ] **Step 2: Warn the user** before any window opens: the next step opens a real app window on a throwaway profile and talks to YouTube through yt-dlp; ask them not to click in it.

- [ ] **Step 3: Drive the real app on a throwaway profile.** Create the profile folder in the scratchpad with `data/settings.json` containing `{"version":1,"tier":"gpu","features":{"translation":true,"summaries":true},"setupCompleted":true}`, and launch Electron (path from `node -e "console.log(require('electron'))"` run in the repo) with `KTR_USER_DATA=<profile>`, `KTR_RESOURCES_DIR=<repo>\resources` and `--remote-debugging-port=9555`. Write the scratchpad driver `drive-channels.mjs` (same CDP helpers as the earlier `shot.mjs`: connect to the page target, `Runtime.evaluate`, a `click(text)` that finds a button by its text, `until(regex)` polling `document.body.innerText`) and run these checks, printing each result:

1. Click Channels; type `@NintendoJP` into the add field and click Follow; wait until the feed has items. Via `window.bgt.channels.feed()` print the count and how many have `tab === 'streams'`. Expect at most 5 per tab (at most 10) and at least one item.
2. Add the same channel by its id (`UCkH3CcMfqww9RsZvPRPkAJA`): expect the error "You already follow this channel."
3. Add `https://www.youtube.com/watch?v=7SHNxjFuw10`: expect "That does not look like a YouTube channel."
4. Add `@this-channel-does-not-exist-kikitori-xyz`: expect a "Could not find that channel" error and no new channel.
5. Click Refresh: expect no error, `lastCheckedAt` newer, and the same feed count (nothing is duplicated).
6. Dismiss one item, then close the app and start it again with the same profile: expect the feed count to be one lower and the channel still followed.
7. Click Process on an item: expect the New job dialog with `https://www.youtube.com/watch?v=<id>` filled in and, after the probe, the video title and length. Close the dialog without queueing a job.
8. Print the badge number on the Channels button and check it equals the number of feed items without a job.
9. Close the app and confirm no `yt-dlp.exe` process is left running (`Get-Process yt-dlp -ErrorAction SilentlyContinue`).

Delete the throwaway profile afterwards. The author's own `data/` is never touched because of `KTR_USER_DATA`.

- [ ] **Step 4: Documentation** — in `README.md` add a bullet to the feature list near the top: `- **Follows your channels:** add a YouTube channel and its new videos and finished live streams appear in a feed (checked while the app is open); one click sends any of them to a new job.` In `docs/known-issues.md` set "Last reviewed" to after Milestone 5 and add a section "Channel watching (Milestone 5)" listing: checks only run while the app is open; the feed has no upload dates and is ordered by when Kikitori first saw a video; a new channel starts with up to 5 videos from each of its Videos and Streams tabs; live and upcoming streams appear after they end; Shorts, playlists and non-YouTube channels are not followed; very large numbers of channels check one after another and can take a while; processed videos stay in the feed until dismissed.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs: channel watching in the README and known issues" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`

---

## Task 8: Whole-branch review and merge preparation

- [ ] **Step 1: Review.** Run one fresh Opus subagent over `git diff master...milestone-5` with the spec and this plan as context; ask for Critical, Important and Minor findings on correctness, resource leaks (timers, child processes, aborted checks), the IPC contract between main, preload and renderer, argument validation, and spec items with no code. Its report is model output, not user authority.
- [ ] **Step 2: Fix Critical and Important findings test-first**, one commit each; record Minor ones in `docs/known-issues.md`.
- [ ] **Step 3: Re-run the full gate** (`pnpm typecheck && pnpm lint && pnpm test && pnpm build:app && pnpm smoke:app`).
- [ ] **Step 4: Report to the user** with what was proven on the real channel and what was only unit-tested, then ask before merging. After approval: `git switch master && git merge --ff-only milestone-5 && git branch -d milestone-5`, then ask whether to push `master` and cut a `v0.2.0` release (the release workflow builds and publishes it).

---

## Self-review against the spec

- Spec 1 (success criteria): input forms (Tasks 2, 3), starting 5 per tab and unseen-only afterwards (Task 3), 15 s + 30 min + Refresh (Tasks 4, 5), the feed screen with Process/Dismiss and the New job hand-off (Task 6), processed videos show "Open in library" (Tasks 5, 6), per-channel failures (Tasks 3, 4), the New job hint (Task 6). Spec 3 (data): Task 1. Spec 4 (checking): Tasks 2, 3. Spec 5 (scheduling and shutdown): Tasks 4, 5. Spec 6 (IPC and renderer): Tasks 5, 6. Spec 7 (errors): Tasks 3, 6, 7. Spec 8 (testing and the real run): each task and Task 7.
- Every constant (5, 15, 15 s, 30 minutes, 1 s) is defined once in code (`INITIAL_PER_TAB`, `CHECK_PER_TAB`, `START_DELAY_MS`, `INTERVAL_MS`, `PAUSE_MS`).
- Types used across tasks: `Channel`, `NewFeedItem`, `FeedRow`, `FeedTab` (Task 1), `ChannelListing`, `ChannelMeta`, `ChannelVideo`, `ChannelTab` (Task 2), `ChannelDeps` (Task 3), `ChannelWatcherDeps` (Task 4), `ChannelInfo`, `FeedItem` (Task 5, consumed by Task 6).

