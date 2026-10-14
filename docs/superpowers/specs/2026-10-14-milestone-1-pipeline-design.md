# Milestone 1 Design: Core Transcription Pipeline

Date: 2026-10-14
Status: Draft, awaiting review

Part of the larger "Local Japanese YouTube Understanding App" project (Electron + React, local Whisper + local LLM, zero cost by default). This document covers **Milestone 1 only**: URL (or local file) plus optional time range in, resumable chunked transcription out, written as a Japanese SRT. Later milestones (translation and summary, Electron app, wizard and packaging, channel watching) are out of scope here and have their own spec cycles.

## 1. Intent

- **Outcome:** a runnable CLI pipeline that produces an accurate Japanese SRT from a Japanese YouTube VOD, so the user can judge transcription accuracy on real stream audio before any UI or translation work.
- **Who:** the author first (Windows 11, i7-13700K, RTX 3080 with 12 GB VRAM), then strangers installing from GitHub in later milestones.
- **Why transcribe instead of using YouTube captions:** YouTube auto-captions are inaccurate, and translating them would inherit the errors.
- **Success criteria:**
  1. `bgt run <url> --start --end` produces a JA `.srt` for a 5-10 minute section of a real creator VOD.
  2. The user judges the transcript an acceptable draft on stream-style audio (game sound, music, overlapping speech).
  3. Killing the process mid-job and re-running resumes without redoing completed chunks.
  4. All core code is free of Electron and React imports so Milestone 3 can reuse it unchanged.

## 2. Decisions

| Topic | Decision |
|---|---|
| Layout | Single package, electron-vite, TypeScript, vitest, ESLint, pnpm. No monorepo |
| Core isolation | `src/core/` must not import `electron` or `react`; enforced by an ESLint restricted-imports rule |
| Transcription engine | whisper.cpp via `whisper-cli`, **spawned once per chunk**, JSON output parsed |
| Model | `large-v3` (ggml). Model name is a config value; no bake-off in M1 |
| VAD | whisper.cpp Silero VAD (`--vad`), tuned on the user's clips |
| Test material | One or two 5-10 minute sections of VODs from the user's followed creators (URLs supplied by the user; never committed) |
| Storage | SQLite via `better-sqlite3` for job and chunk state |
| Platform | Windows first; macOS and Linux untested |
| ffmpeg | Not bundled. Resolution order: `resources/`, then `PATH`, then download |

### Rejected alternatives for invoking whisper.cpp
- Long-lived `whisper-server` over HTTP: avoids model reloads but adds port, lifecycle and health-check complexity for little gain at 10-30 minute chunk sizes. Can replace the per-chunk spawn later behind the same `Transcriber` interface.
- Native Node bindings: fastest in theory, but needs per-platform and per-Electron-version native builds, which conflicts with the easy-install goal.

## 3. Project structure

```
bg-auto-translator/
├─ src/
│  ├─ core/                  # pure Node/TS, never imports electron or react
│  │  ├─ types.ts            # Segment, Chunk, Job
│  │  ├─ interfaces.ts       # Transcriber / Translator / Summarizer (all three declared; only Transcriber implemented in M1)
│  │  ├─ pipeline/           # fetch -> chunk -> transcribe, resumable
│  │  ├─ backends/transcribe/whispercpp.ts
│  │  ├─ tools/              # yt-dlp, ffmpeg, whisper.cpp wrappers, path resolution, fetch logic
│  │  ├─ subtitles/          # SRT writer
│  │  └─ db/                 # schema, migrations, repo
│  ├─ cli/                   # `bgt` entrypoint
│  ├─ main/  preload/  renderer/   # empty until Milestone 3
├─ resources/                # downloaded binaries and models (gitignored)
├─ scripts/                  # fetch-tools entrypoint
├─ tests/
├─ docs/superpowers/specs/
└─ README.md, LICENSE, .gitignore   # media, models, transcripts, work dirs gitignored
```

Interfaces (declared now, from the project spec):

```
transcribe(audioPath, opts) -> Segment[]     // {start, end, text, lang}
translate(segments, glossary) -> Segment[]   // M2
summarize(segments) -> Summary               // M2
```

## 4. Pipeline

CLI: `bgt run <url|file> [--start 1:20:00 --end 1:50:00] [--model large-v3] [--out dir] [--max-minutes N] [--keep-work]`

Other commands: `bgt doctor` (tool paths, versions, CUDA check), `bgt update-ytdlp`.

1. **Job creation.** Insert a `jobs` row (source, range, settings). Re-running the same job id resumes it.
2. **Fetch.** yt-dlp downloads audio only, using `--download-sections` for a time range. ffmpeg converts to 16 kHz mono WAV. Local files skip yt-dlp and go straight to ffmpeg.
3. **Chunk.** ffmpeg `silencedetect` finds quiet points. Cut at the quiet point nearest each ~15 minute target with ~2 s overlap. Each chunk is written as its own WAV with `start_ms` / `end_ms` recorded in `chunks`. The planner is a pure function: silence points in, cut points out.
4. **Transcribe**, one chunk at a time: `whisper-cli -l ja --vad --vad-model <silero> -oj`. Segment timestamps are shifted by the chunk offset. Segments inside the overlap region are deduplicated, earlier chunk wins. Segments are written to `segments` and the chunk is marked `done`.
5. **Output.** JA `.srt` plus a raw JSON dump. Output is written as chunks complete.

### Guardrails
- **Per-job cap:** 30 minutes by default. An over-cap request fails with `OverCap` unless `--max-minutes` is passed.
- **Hallucination filter:** drops runs of repeated identical segments and segments with very low confidence (`avg_logprob`) over silence. Thresholds are constants tuned on the user's clips.
- **Time estimate** printed before processing, from audio length and a speed factor measured on the first run and stored for reuse.

## 5. Tool fetching and version pinning

- `tools.lock.json` pins version, URL and SHA-256 for yt-dlp, the whisper.cpp Windows release, the `large-v3` ggml model, and the Silero VAD model.
- Exact versions are chosen at implementation time after confirming the chosen whisper.cpp release supports `--vad` and ships a CUDA build. If no CUDA build is available, the lock falls back to a CPU build and the user is told.
- `pnpm setup:tools` runs `scripts/fetch-tools`, which downloads, verifies checksums and unpacks into `resources/`. The logic lives in `core/tools/` as an importable module because Milestone 4's first-run wizard will reuse it.

## 6. SQLite schema (M1)

Migrations tracked via `PRAGMA user_version`.

- `jobs(id, source, range_start_ms, range_end_ms, settings_json, status, created_at)`
- `chunks(job_id, idx, start_ms, end_ms, wav_path, status, attempts, error)`, status in `pending | running | done | failed`
- `segments(job_id, chunk_idx, start_ms, end_ms, text, lang, avg_logprob)`

Translation and summary tables are added in Milestone 2.

## 7. Error handling

- Typed errors: `ToolMissing`, `DownloadFailed`, `TranscribeFailed`, `OverCap`.
- A failed chunk is retried twice, then marked `failed`. The job continues and reports missing chunks at the end. Re-running processes only the non-`done` chunks.
- `DownloadFailed` suggests `bgt update-ytdlp` or passing a local file.
- Ctrl+C terminates the child process and leaves the job resumable.
- Working files live in `work/<jobId>/`, removed on success unless `--keep-work`.

## 8. Testing

- **Unit (vitest, no binaries):** SRT writer, time-range parsing, chunk planner, overlap dedupe, hallucination filter.
- **Resume test:** a fake `Transcriber` plus a mid-job kill; asserts completed chunks are skipped on re-run.
- **Integration (off by default, `BGT_INTEGRATION=1`):** real binaries on a few seconds of generated audio. No real media is committed.
- **Accuracy:** manual, judged by the user against their creator clips.

## 9. Out of scope for Milestone 1

Translation, summaries, glossary, Electron/React UI, player overlay, installers, setup wizard, channel watching, live streams, Gemini backend, model bake-off (Kotoba-Whisper, large-v3-turbo), macOS/Linux verification.

## 10. Known risks and open items

- whisper.cpp VAD quality on noisy stream audio is unverified. Tuning is part of M1 acceptance.
- A CUDA build of the pinned whisper.cpp release must exist for Windows; otherwise M1 runs CPU-only and is slower.
- `better-sqlite3` needs a native rebuild for Electron in M3; M1 runs on plain Node.
- Downloading YouTube audio may violate YouTube's terms. The README (Milestone 6) carries the personal-use disclaimer. No downloaded media or transcripts are ever committed.
- Whisper can hallucinate; output is a draft, not ground truth.
