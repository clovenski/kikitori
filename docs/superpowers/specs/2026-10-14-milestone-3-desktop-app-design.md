# Milestone 3 Design: Desktop App (Electron + React)

Date: 2026-10-14
Status: Draft, awaiting review
Builds on: Milestone 1 (transcription) and Milestone 2 (translation, summaries), both merged on `master`.

## 1. Intent

- **Outcome:** a Windows desktop app where the author pastes a YouTube URL (or drops a local audio/video file), chooses a range and options, watches a queue make progress, and then watches the video with synced English/Japanese subtitles next to a clickable transcript and a timestamped summary.
- **Who:** the author first; strangers later (installers and the first-run wizard are Milestone 4).
- **Scope chosen:** the complete viewing loop (library, new job, queue with live progress, job page with player, overlay, transcript, summary) with minimal settings.
- **Success criteria:**
  1. Submitting a URL from the app produces the same results as `kikitori run ... --translate --summarize`, and the finished job opens in the app.
  2. The job page plays the video with an overlay that follows playback within ~150 ms; clicking a transcript line or a summary timestamp seeks the video.
  3. Jobs `2` and `3` already in `data/bgt.sqlite` appear in the library and play without reprocessing.
  4. Cancel stops the current job and its child processes (`whisper-cli`, `llama-server`, `yt-dlp`, `ffmpeg`); quitting the app leaves no orphaned processes; a job interrupted by a crash or quit is offered as Resume.
  5. When a video cannot be embedded, the job page still works as a reader (transcript, summary, "Open on YouTube").
- **Non-goals:** first-run wizard, installers, channel watching, settings screen, glossary editing, search, macOS/Linux, live streams.

## 2. Decisions

| Topic | Decision |
|---|---|
| Stack | electron-vite, Electron 44 (Node 24), React 19, TypeScript, plain CSS (light and dark themes via CSS variables), no UI library, no router library |
| Core reuse | `src/core/` is reused unchanged in behavior and still imports nothing from Electron or React; the app only drives `runJob` and `runLlmStages` |
| Pipeline process | Runs inside the Electron main process (heavy work is already in child processes) |
| Database | Switch from `better-sqlite3` to Node's built-in `node:sqlite` behind a small adapter, so the same code and the same DB work in plain Node (CLI, tests) and in Electron with no native build. `better-sqlite3` and its types are removed |
| Concurrency | Strictly one job at a time (GPU/VRAM); others wait in the queue |
| Dev data | Unpackaged app uses the project's `data/` and `resources/`, shared with the CLI |
| Player | YouTube IFrame player for URLs, normal `<video>` for local files; our own overlay |

## 3. Project structure

```
src/core/                      # unchanged API; small additions in section 5
src/cli/                       # unchanged
src/app/main/                  # Electron main: window, queue, IPC handlers, media protocol, referrer fix
src/app/preload/               # contextBridge: window.bgt
src/app/renderer/              # React UI (index.html, main.tsx, App.tsx, screens/, components/, lib/)
src/app/shared/ipc.ts          # types only: request/response shapes and event payloads
electron.vite.config.ts, tsconfig.node.json, tsconfig.web.json
scripts/smoke-app.mjs          # launches the built app with --smoke
```

Boundaries (enforced by ESLint restricted imports): `src/core` imports nothing from `src/app`; `src/app/renderer` imports no `electron`, no `node:*`, and no runtime code from `src/core` (type-only imports allowed); `src/app/shared` is types only.

## 4. Database changes

### 4.1 `node:sqlite` adapter (`src/core/db/sqlite.ts`)
A thin class exposing the subset the code already uses: `prepare(sql)` returning `{ run(...args), get(...args), all(...args) }` (`run` returns `{ changes, lastInsertRowid }`), `exec(sql)`, `pragma(text, { simple? })`, `transaction(fn)` returning a callable that commits or rolls back, and `close()`. `openDb(file)` opens, enables WAL and runs migrations. Repositories and tests switch their import from `better-sqlite3` to this adapter; their code is otherwise unchanged. The "ExperimentalWarning" that Node prints once is acceptable.

### 4.2 Migration 3 (`PRAGMA user_version = 3`)
- `jobs` gains `title TEXT` and `video_id TEXT` (nullable; old rows stay valid).
- New table `submissions`: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `source TEXT NOT NULL`, `start_ms INTEGER NOT NULL DEFAULT 0`, `end_ms INTEGER` (null = to the end), `options_json TEXT NOT NULL` (`{ translate, summarize, skim, glossaryPath?, maxMinutes, model }`), `state TEXT NOT NULL` (`queued | running | done | failed | cancelled | interrupted`), `job_id INTEGER REFERENCES jobs(id)`, `error TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`.

## 5. Small core additions (backward compatible)

- **Progress events.** `core/progress.ts` defines `ProgressEvent = { stage: 'fetch' | 'transcribe' | 'glossary' | 'translate' | 'summarize'; done: number; total: number; message: string }`. `PipelineDeps` gains optional `progress?(e)`; `runJob` emits fetch start/end and one event per finished chunk; the glossary, translate and summarize stage runners emit per window or batch. Log lines keep working.
- **Job identity early.** `RunParams` gains optional `onJob?(job: JobRow)`, called as soon as the job row exists, so the queue can link a submission to its job.
- **Probe with title.** `PipelineDeps.probeDurationMs` becomes `probe(source, signal?) -> { durationMs: number; title: string | null }`; for URLs yt-dlp prints duration and title in one call, for local files the title is the file name. `runJob` stores `title` and `video_id` on the new job. `parseYoutubeId(url)` is a pure function (watch, youtu.be, shorts, embed URLs).
- **Shared DB handle.** `createRealDeps` accepts an optional open database so the main process uses a single connection.

## 6. Main process

### 6.1 Queue (`src/app/main/queue.ts`)
`JobQueue` takes injected `store` (submissions persistence), `runSubmission(sub, { signal, progress, onJob })` and `emit(event)`, so it is unit-testable with fakes.
- `submit(request)` inserts a `queued` submission and starts processing if idle.
- `cancel(id)`: a queued submission becomes `cancelled`; the running one is aborted via `AbortSignal` and ends `cancelled`.
- `resume(id)`: an `interrupted`, `failed` or `cancelled` submission returns to `queued` (the pipeline's own resume logic skips finished chunks, batches and windows).
- On startup, submissions found `running` become `interrupted`, then the queue starts.
- Events: `queue:changed` (full list) and `queue:progress` ({ submissionId, ProgressEvent }).

### 6.2 Running a submission
`runSubmission` probes and runs `runJob` (reusing a job through the existing `findResumableJob` rule), then, if any LLM option is set, `runLlmStages` with the real model pool. The pool's `stopAll()` always runs in `finally`. Outputs are still written to `output/` as with the CLI. Failures are recorded with their `BgtError` code and message.

### 6.3 IPC (`window.bgt`, types in `shared/ipc.ts`)
Request/response: `library.list()`, `job.get(jobId)` (job, segments with Japanese text and optional English, summaries; times are absolute video times), `queue.list()`, `queue.submit(request)`, `queue.cancel(id)`, `queue.resume(id)`, `source.probe(source)` (title, duration, or an `InvalidInput`/`DownloadFailed` message), `source.estimate({ durationMs, startMs, endMs })` (seconds or null), `dialog.pickMedia()`, `dialog.pickGlossary()`, `job.openOutputFolder(jobId)`. Push events: `queue:changed`, `queue:progress`. The main process validates every argument and returns typed errors; the renderer never sees raw exceptions.

### 6.4 Security
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the preload exposes only the API above; a restrictive CSP allows only the app's own scripts plus `https://www.youtube.com` (script and frame); external links open in the system browser. The `bgt-media://job/<id>` protocol serves a local file only if it is the `source` of an existing job, with range support; arbitrary paths are refused.

## 7. Renderer

- **Screens:** Library; New job (modal); Job page. The queue strip is always visible at the bottom.
- **Library:** one row per job (title, source type, status, range/length, date, badges for English and summary); newest first; click opens the job page. A submission that has no job yet (queued, probing) appears as a row labeled with its source.
- **New job:** field for URL or a drop zone / "Choose file", start and end (same formats as the CLI), checkboxes Translate, Summarize, Skim (Skim excludes Translate), optional glossary file. After the user finishes typing the URL, the app probes it and shows title, duration and a time estimate ("about 5 min" or "unknown until a first run"); the 30-minute cap is enforced with the CLI's message.
- **Queue strip:** current submission, stage name, progress bar from `done/total`, elapsed time, Cancel; waiting count; failed/interrupted items show the error and Resume.
- **Job page:** player on the left; right side has tabs Transcript and Summary; toolbar with subtitle mode (English, Japanese, Both; English falls back to Japanese when a line has no translation), overlay size, "Open output folder", and "Open on YouTube".
- **Transcript tab:** all lines with timestamps, the active line highlighted and kept in view; click seeks.
- **Summary tab:** overview, sections and window bullets; each `[h:mm:ss]` is a link that seeks.

## 8. Player and overlay

- **Overlay logic** is pure and tested: `findActiveIndex(segments, timeMs)` (binary search, handles gaps and overlaps) and a `useActiveSubtitle` hook driven by a `TimeSource` with `getTimeMs()`, `seek(ms)`, `onState(cb)`. The overlay polls via `requestAnimationFrame` capped to ~10 Hz while playing.
- **YouTubePlayer:** the IFrame API (`enablejsapi=1`, `fs=0`, `rel=0`); a referrer is set for YouTube requests in the main process's session so the embed does not fail with a configuration error. Error states 101, 150 and 153 switch the page to reader mode with a visible notice.
- **LocalPlayer:** `<video>` with `src` on the media protocol.
- **Fullscreen:** the app's own button fullscreens the player container (Fullscreen API), so the overlay stays visible; YouTube's own fullscreen button is disabled.
- **Time base:** subtitles use absolute video time (the range offset is already applied in `job.get`). For a ranged local file the player seeks to the range start at load.

## 9. Lifecycle and cleanup
Closing the window while a job runs asks for confirmation; quitting aborts the running submission, waits for `stopAll()` and kills remaining child process trees. Only one app instance runs (`requestSingleInstanceLock`).

## 10. Tooling
`pnpm dev:app` (electron-vite dev), `pnpm build:app`, `pnpm smoke:app`. `electron` and `esbuild` are approved for build scripts in `pnpm-workspace.yaml`. Vitest runs core and main tests in Node and renderer tests in jsdom (per-file environment).

## 11. Testing

- **Unit (Node):** `node:sqlite` adapter (prepare/run/get/all, transaction commit and rollback, pragma, `:memory:`); migration 3; `parseYoutubeId`; progress events emitted by `runJob` and the stage runners; `JobQueue` (ordering, cancel running/queued, resume, startup recovery, error recording) with fakes; IPC argument validation; media-protocol path authorization.
- **Component/logic (jsdom):** `findActiveIndex`; subtitle mode and fallback; library rendering from a fixture; New job form validation (skim vs translate, range formats, cap message); transcript active-line behavior.
- **Smoke:** `pnpm smoke:app` launches the built app with `--smoke`; success means the window loaded, `window.bgt` is defined and `library.list()` returns, then exit code 0.
- **Manual (author):** run jobs 2 and 3 and a fresh URL through the UI; check overlay sync, seeking from transcript and summary, cancel mid-translation, quit during a job and Resume.
- All existing Milestone 1 and 2 tests must keep passing after the `node:sqlite` switch.

## 12. Risks and open items

- **YouTube embed in Electron** is the main unknown (referrer, error 153, per-video embedding bans). Mitigated by the session referrer, reader mode and "Open on YouTube"; verified manually with the author's videos.
- **Bundling `src/core`:** `paths.ts` derives the project root from `import.meta.url`. In the bundled main process this must be replaced by explicit directories passed in at startup (environment variables already supported: `BGT_RESOURCES_DIR`, `BGT_DATA_DIR`).
- **`node:sqlite` is flagged experimental**; usage is limited to simple statements, and the adapter isolates any future API change.
- **Electron binary download** during `pnpm install` adds a large one-time download.
- Subtitle sync accuracy is bounded by the IFrame API's `getCurrentTime()` resolution (~100 to 250 ms); acceptable for reading.
