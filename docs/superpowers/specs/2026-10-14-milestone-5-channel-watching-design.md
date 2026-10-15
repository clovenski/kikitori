# Milestone 5 Design: Channel Watching

Date: 2026-10-14
Status: Awaiting review
Builds on: Milestones 1 to 4, merged on `master` (released as v0.1.0). Related: `docs/known-issues.md`.

## 1. Intent

- **Outcome:** the user follows YouTube channels in Kikitori. New videos (including finished live-stream recordings) show up in a feed on their own, and one click starts the normal New job flow for any of them.
- **Who:** the single user of a local app, who today has to find each video on YouTube and paste its link.
- **Success criteria:**
  1. Pasting `@handle`, a channel URL (`/@handle`, `/channel/UC…`, `/c/…`, `/user/…`) or a bare channel id follows that channel.
  2. A new channel's feed starts with up to 5 recent videos from its Videos tab and up to 5 from its Streams tab; afterwards only videos not seen before appear.
  3. The app checks all followed channels shortly after it starts and then every 30 minutes while it is open, and on demand with Refresh.
  4. The Channels screen lists the feed with thumbnail, title, channel, length and a "Stream" badge, and offers Process and Dismiss; Process opens the New job dialog already filled in and probed.
  5. Videos that already have a job show "Open in library" instead of Process.
  6. A failing channel (bad URL, removed channel, network down) never breaks the others or the app; its error is shown next to it.
  7. The screen says that older or one-off videos can be pasted into New job.
- **Non-goals:** background or tray checking when the app is closed, notifications, auto-processing, history beyond the starting 5 per tab, upload dates, search, Shorts, live or upcoming streams, playlists, non-YouTube sites, per-channel settings, a configurable interval.

## 2. Decisions

| Topic | Decision |
|---|---|
| What happens to a new video | Shown in a feed; the user decides (no automatic processing) |
| When to check | While the app is open: about 15 s after start, then every 30 minutes, plus Refresh |
| Starting point | Up to 5 from the Videos tab and 5 from the Streams tab; no dates are available to merge them into one "latest 5" |
| Source of truth for listings | `yt-dlp --flat-playlist -J` on the channel's `/videos` and `/streams` tabs (no API key, handles every URL form) |
| What "new" means | A video id the channel has not shown before; no dates are needed |
| Processing | Process opens the New job dialog with the URL filled in and probed |
| Processed videos | Derived from existing jobs (matching video id); only "dismissed" is stored separately |

Evidence for the listing approach (probed against a public channel with the bundled yt-dlp): the flat listing returns id, title, duration, channel id and handle; `timestamp`/`upload_date` are null; the Streams tab entries carry `live_status: "was_live"`; entries come newest first.

## 3. Data

Migration 4 (append to `MIGRATIONS` in `src/core/db/schema.ts`):

```sql
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
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  duration_ms INTEGER,
  tab TEXT NOT NULL,            -- 'videos' | 'streams'
  first_seen_at TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_feed_channel ON feed_items(channel_id, first_seen_at);
```

`src/core/channels/channel-repo.ts` (`ChannelStore`): `addChannel`, `listChannels`, `removeChannel` (cascades to its feed items), `recordCheck(channelId, { error })`, `addItems(channelId, items): number` (returns how many were new; existing ids are ignored, dismissed ones stay dismissed), `listFeed()`, `dismiss(videoId)`, `dismissAll(channelId?)`, `countNew(processedIds)`.

"Processed" is computed by the caller from `Repo.listJobs()`: a job counts for a video when `video_id` matches or, for older jobs without one, `parseYoutubeId(source)` does. The feed shown to the renderer already carries `job: { jobId, status } | null`.

## 4. Checking

- **Input normalization** (`src/core/channels/channel-url.ts`, pure): `normalizeChannelInput(text)` returns the canonical channel URL (`https://www.youtube.com/@name`, `…/channel/UC…`, `…/c/name`, `…/user/name`) or throws `InvalidInput` ("That does not look like a YouTube channel."). A bare `@name` or `UC` + 22 characters is accepted; video, playlist, `/shorts` and non-YouTube URLs are rejected.
- **Listing** (`src/core/channels/listing.ts`): `parseChannelListing(json, tab)` turns yt-dlp's JSON into `{ channel: { id, handle, title, url }, items: ChannelVideo[] }`, keeping only finished videos: an entry is dropped when `live_status` is `is_live`, `is_upcoming` or `post_live`, when it has no id or no duration (premieres), and when its id is not a plain 11-character video id. `listChannelTab({ ytdlpPath, url, tab, limit, signal, run? })` runs `yt-dlp --flat-playlist --playlist-end <limit> --no-warnings --encoding utf-8 --js-runtimes node --extractor-args youtube:player_client=default,-ios -J <url>/<tab>` through `runProcess` (so the child registry and abort handling apply) and throws `DownloadFailed` with yt-dlp's last line plus the existing "try updating yt-dlp" hint.
- **Check** (`src/core/channels/check.ts`): `checkChannel(deps, channel, { initial })` lists both tabs (5 per tab for the initial fill, 15 per tab afterwards), adds the videos that are new and records the outcome. Listings are newest first, so a video is new when it comes before the first one the channel already showed (dismissed ones count as shown); the older videos that the bigger window reaches are not new and are left out. When nothing in a window is known: a tab the channel has shown before takes the whole window (more than a window of videos came out since the last check), and a tab with nothing known yet starts with 5 like a fresh channel. (Found in the real run: the first scheduled check had filled the feed with 30 items.) A tab that fails (for example a channel with no Streams tab) counts as empty as long as the other tab worked; both failing records the error.
- **Adding** (`addChannel(deps, input)`): normalizes, lists once to learn the channel id and title, refuses a channel already followed ("You already follow this channel."), stores it and runs the initial fill. Lookup failure throws `DownloadFailed` ("Could not find that channel.") without storing anything.

## 5. Scheduling

`ChannelWatcher` (`src/app/main/channel-watcher.ts`, constructed in `main/index.ts`):

- `start()` waits `startDelayMs` (15 s), checks, then repeats every `intervalMs` (30 min); `refresh(channelId?)` runs a check now.
- One check at a time (a second request while one runs waits for it and shares its result); channels are checked sequentially with a 1 s pause between them.
- A check is skipped when the first-run wizard has not finished, a setup download is running, or yt-dlp is not installed; the next tick tries again.
- Per-channel errors are stored (`last_error`) and never thrown; a check that finds anything new or changes an error state broadcasts `channels:changed`.
- `stop()` aborts the check in progress and clears the timer; it is a step of the shutdown sequence (before the queue step) so no helper process outlives the app.

## 6. IPC and renderer

New channels (names in `CHANNELS`): `channels:list`, `channels:add`, `channels:remove`, `channels:refresh`, `feed:list`, `feed:dismiss`, `feed:dismissAll`, event `channels:changed`. Arguments are validated in `validate.ts` (`parseChannelInput`, `parseChannelId`, `parseVideoId` = 11 characters of `[A-Za-z0-9_-]`). `window.bgt.channels` mirrors them; shared types `ChannelInfo`, `FeedItem` live in `src/app/shared/ipc.ts`.

Renderer:

- **Top bar:** a Channels button with a badge counting feed items that are neither dismissed nor already a job.
- **Channels screen** (`ChannelsScreen.tsx`): an add field with a button; one row per followed channel with its name, "checked 5 min ago" or its error, and Remove (confirmation, because it deletes that channel's feed items); a Refresh button; the feed (ordered by first seen, newest first, and by listing order within one check): thumbnail from `https://i.ytimg.com/vi/<id>/mqdefault.jpg`, title, channel, length, a "Stream" badge for the Streams tab, **Process** and **Dismiss**; items that already have a job show the job status and "Open in library"; **Dismiss all**. Empty states: no channels yet, no new videos. A hint line: "Need an older or one-off video? Paste its link into New job."
- **Process** opens `NewJobDialog` with a new optional `initialSource` prop: the dialog fills the field and probes it on mount, so range inputs, options, the long-video cap and the missing-model prompt all behave as for a pasted link.
- The screen reloads on `channels:changed`, on the queue changing (so "Open in library" appears) and after its own actions.

## 7. Errors

- Offline or yt-dlp blocked: the channel keeps its feed, `last_error` shows the reason and the time of the last successful check stays; nothing is shown as a popup.
- A removed or renamed channel: the error is shown next to it; Remove clears it.
- A video that cannot be processed later (members-only, age-restricted) fails in the normal job flow with the existing messages.
- Adding while offline: "Could not find that channel." with yt-dlp's reason in the detail; nothing is stored.

## 8. Testing

- **Unit (Node):** `normalizeChannelInput` (every URL form, rejects), `parseChannelListing` (live/upcoming/premiere filtering, id validation, channel info), `listChannelTab` with a fake runner (arguments, failure messages), `ChannelStore` (add/duplicate/remove cascade, `addItems` idempotence and dismissed stay dismissed, counts), `checkChannel`/`addChannel` with a fake lister (initial limit of 5, later 15, one tab failing, both failing), `ChannelWatcher` with fake timers (start delay, interval, single flight, skips, error handling, stop), migration 4 on an existing database with jobs, handler validation.
- **Component (jsdom):** `ChannelsScreen` (add, error, remove confirmation, feed actions, processed items, badge count, hint), `NewJobDialog` with `initialSource`.
- **Real run (author's machine, public channel):** add a real channel, see up to 5 + 5 items, Refresh finds nothing new, Dismiss and Dismiss all persist across a restart, Process opens the dialog with the URL probed and filled in, a followed channel that is offline-failing shows its error, and the existing job flow still works. Test data is removed from the author's library afterwards (a separate `KTR_USER_DATA` profile is used so the real database is untouched).

## 9. Risks and open items

- **YouTube changes:** listing breaks like downloads do; the existing "update yt-dlp" path is the remedy and the error text points to it.
- **Request volume:** two small requests per channel every 30 minutes; with many channels the sequential pause keeps it polite. A cap or a longer interval can follow if it matters.
- **No dates:** the feed is ordered by when Kikitori first saw a video, newest first, and within one check by yt-dlp's order; the first fill therefore shows the Videos items before the Streams items.
- **Open for the author:** none; the numbers (5 per tab, 15 per check, 30 minutes) are constants that are easy to change.
