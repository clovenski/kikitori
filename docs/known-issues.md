# Known issues

Things that are known, understood, and deliberately not fixed yet. None of them loses data, kills the wrong process, or leaves the app unusable. Each entry says what happens, why it was left, and what a fix would look like.

Last reviewed: after Milestone 3 (2026-10-14).

## Desktop app

### Quitting twice quits early
Clicking the window's X while a File > Exit shutdown is still running makes the app exit immediately and cuts the cleanup short.
- **Why it is left:** the cleanup that gets skipped is what the orphan cleanup at the next start already covers.
- **Fix:** call `event.preventDefault()` in `before-quit` while a shutdown is in progress (`src/app/main/index.ts`). One line; worth doing with Milestone 4.

### A model can restart after shutdown stopped it
If the queue step of shutdown times out in the middle of a translation or summary stage, `pool.stopAll()` runs and the still-running stage can start a new `llama-server`.
- **Why it is left:** needs a stuck queue step first; the next launch kills the stray process.
- **Fix:** make `ModelPool.use()` refuse once `stopAll()` has been called for shutdown.

### Startup resets a job a CLI is running
At startup the app turns every job still marked `running` into `pending` ("Not finished"). If you are running `bgt run` in a terminal at that moment, that job briefly shows as "Not finished" in the library.
- **Why it is left:** cosmetic, only when the CLI and the app are used at the same time; the CLI sets the final status itself.
- **Fix:** record the owning process on a running job and only reset jobs whose owner is gone (the same check the child-process cleanup uses).

### YouTube player: retrying after a failed load can stall
If the YouTube player script fails to load, the app switches to reader mode and offers "Open on YouTube". Retrying inside the same session may not work until the app restarts: a late script error can discard the retry's cached promise, and a second script tag does nothing once YouTube's loader has started.
- **Why it is left:** the fallback is the designed behavior and it needs a bad network to trigger.
- **Fix:** ignore script errors that arrive after the timeout, and reload the iframe API by replacing the script tag.

## Pipeline

### Every yt-dlp failure is retried
Downloads retry up to 3 times with a short backoff, because YouTube intermittently refuses ffmpeg's direct fetch (the cause was inferred, not seen in the failing output). Permanent failures (format not available, disk full, members-only video that passed the probe) are retried too and take about 6 seconds longer to report.
- **Why it is left:** private videos and bad URLs already fail earlier, at the probe.
- **Fix:** do not retry exit conditions that cannot change (read yt-dlp's error text, or exit code).

## Helper-process cleanup

### A reused owner process id can hide orphans
Helper records are only acted on when their owner process is gone. If this process happens to get the same id as a dead owner, that owner's old records look alive and are never cleaned up. Temp files (`children.json.<pid>.tmp`) left by a crash mid-write are never deleted.
- **Why it is left:** the worst case is an orphan staying alive, never a wrong kill. Windows already kills the app's helpers together with the app in the cases tried.
- **Fix:** store the owner's start time too, and sweep stale `.tmp` files at startup.

## Translation quality (Milestone 2)

- **Glossary spellings:** the same person can get two English spellings when the Japanese forms differ (`じっぴーず` / `ジッピーズ`), and the model sometimes uses macrons ("Higemē"). A prompt line asking for plain letters would help; merging variants needs a small de-duplication step.
- **Glossary scope:** only people, handles and places that occur at least twice are kept. Brand names are left to the translator on purpose, so a brand can be spelled slightly differently from line to line.
- **Local models are weaker than cloud models** on slang, names and gaming talk. Treat the output as a good draft, not ground truth.

## Verified only partly

- **File > Exit confirmation:** the dialog blocks synchronously, so it could not be driven automatically. The decision logic is tested and the code is shared with the window close button, but it was not clicked through during a running job. Try it by hand.
- **Orphan cleanup after a real crash:** a real orphan could not be produced on Windows, because it kills the app's helpers together with the app. The cleanup was proven with a real orphan created on purpose (and with unit tests), not with one left by a crash.

## Environment

- **Windows only.** macOS and Linux are untested.
- **`electron-vite` is a beta** (`6.0.0-beta.8`) because of pnpm's release-age policy; builds, the sandboxed preload and the smoke test pass with it. Revisit when 6.0.0 is allowed.
- **Downloading YouTube audio may violate YouTube's terms.** Personal use only; never commit downloaded media or transcripts.
