# Known issues

Things that are known, understood, and deliberately not fixed yet. None of them loses data, kills the wrong process, or leaves the app unusable. Each entry says what happens, why it was left, and what a fix would look like.

Last reviewed: before the v1.0.0 release (2026-10-15).

## Desktop app

### Startup resets a job a CLI is running
At startup the app turns every job still marked `running` into `pending` ("Not finished"). If you are running `kikitori run` in a terminal at that moment, that job briefly shows as "Not finished" in the library.
- **Why it is left:** cosmetic, only when the CLI and the app are used at the same time; the CLI sets the final status itself.
- **Fix:** record the owning process on a running job and only reset jobs whose owner is gone (the same check the child-process cleanup uses).

### YouTube player: retrying after a failed load can stall
If the YouTube player script fails to load, the app switches to reader mode and offers "Open on YouTube". Retrying inside the same session may not work until the app restarts: a late script error can discard the retry's cached promise, and a second script tag does nothing once YouTube's loader has started.
- **Why it is left:** the fallback is the designed behavior and it needs a bad network to trigger.
- **Fix:** ignore script errors that arrive after the timeout, and reload the iframe API by replacing the script tag.

## Helper-process cleanup

### A reused owner process id can hide orphans
Helper records are only acted on when their owner process is gone. If this process happens to get the same id as a dead owner, that owner's old records look alive and are never cleaned up. Temp files (`children.json.<pid>.tmp`) left by a crash mid-write are never deleted.
- **Why it is left:** the worst case is an orphan staying alive, never a wrong kill. Windows already kills the app's helpers together with the app in the cases tried.
- **Fix:** store the owner's start time too, and sweep stale `.tmp` files at startup.

## Setup and installer (Milestone 4)

- **Unsigned installer:** Windows SmartScreen warns on first run ("More info", then "Run anyway"), and some antivirus programs flag yt-dlp or the model runtimes. Both are documented in the README, not fixed.
- **CPU path speed:** on the author's i7-13700K a 2-minute range (audio download, transcription, translation, summary) took about 120 seconds with the CPU components (Whisper large-v3-turbo 5-bit, Hy-MT2 1.8B, Qwen3 4B). Other machines will be slower, and the quality was only spot-checked: translations read fine, the summary is thinner than the GPU tier's.
- **Only NVIDIA GPUs with a CUDA 12.4 driver (551 or newer) get the GPU path.** AMD and Intel GPUs use the CPU path. A driver that passes the check can still fail at run time: use Settings > Switch to CPU only.
- **Repair re-hashes model and data files.** Unpacked programs (ffmpeg, whisper, llama) are only downloaded again when their marker file is missing.
- **Changing tier with jobs queued is not handled:** finish or cancel queued jobs first. A resumed submission from before a tier switch runs with the installed tier's speech model.
- **Pinned download URLs can disappear or be rate limited** (GitHub, Hugging Face, Gyan). The checksum turns that into a clear error; re-pin with `pnpm pin:tools --update` when it happens.
- **Download robustness, left for later:** HTTP 429/502/503 answers are not retried and the message is the raw URL; the retry budget (4 tries) is used up even by tries that made progress ("Try again" resumes); a full disk during a download is reported as a connection problem and during unpacking names no shortfall; the speed and time-left figures are inflated for one session after a resume; quitting while unpacking downloads the archive again.
- **Setup details, left for later:** cancelling an on-demand download keeps the chosen feature in the settings, which hides Settings > "Add translation and summaries" until it is installed; switching tier inside an unfinished first-run wizard keeps the first tier's partial files; the CLI in a CPU-only checkout that never opened the app assumes the GPU tier; `pnpm setup:tools` replaces a self-updated yt-dlp with the pinned one; "Update yt-dlp" is also offered for errors it cannot fix (private or members-only video).
- **In the spec, not built:** a RAM warning below 8 GB on the CPU path, component versions on the Tools page, the uninstaller's note about kept models, versions in THIRD_PARTY_NOTICES, a component check when a queued job resumes, and refreshing the Tools list after a failed download.
- **Not proven yet:** the offline error message end to end (it is unit-tested), and the on-demand download prompt in a real window (unit-tested).

## Channel watching (Milestone 5)

- **Checks only run while the app is open** (about 15 seconds after start, then every 30 minutes, or Refresh). Nothing is checked in the background, and there are no notifications.
- **The feed has no upload dates.** YouTube's flat listing does not give them, so the feed is ordered by when Kikitori first saw a video, newest first.
- **A new channel starts with up to 5 videos from each of its Videos and Streams tabs.** For an older or one-off video, paste its link into New job. Later checks add only videos that came out since (a video counts as new when it comes before the first one already shown).
- **Live and upcoming streams appear after they end.** Shorts, playlists and non-YouTube channels are not followed.
- **Many channels check one after another** with a pause between them, so a large list can take a while.
- **Processed videos stay in the feed** (with "Open in library") until they are dismissed.
- **Left for later (from the Milestone 5 review):** two "Follow" requests for the same channel at once can show the database's raw "UNIQUE constraint" text for the second; following is not one transaction (a failure half way leaves a followed channel with no feed until the next check); Refresh shows nothing when a check cannot run (setup download, yt-dlp missing) and ignores errors from refresh, remove and dismiss; handles with combining marks (Devanagari, Thai) or a middle dot, and the older link forms `youtube.com/<name>` and `/Channel/UC...`, are rejected; a channel with no videos at all cannot be followed yet; a tab that fails on every check while the other works shows no error; "Checked N min ago" only updates when the data reloads; migration 4 is tested on a fresh database, not on a version 3 one with jobs; `refresh(id)` during a running check returns that check's result; the check broadcasts after every successful pass, not only when something changed; updating yt-dlp from Tools while a channel check runs is not coordinated.

## Updates

- **Only releases made after the updater was added can update themselves.** Earlier installs (0.1.0, 0.2.0) have no updater; install the first version that has it by hand.
- **The installer is unsigned, so an update is trusted by the checksum in `latest.yml`** (served from the GitHub release over HTTPS), not by a signature. Anyone who can publish a release to the repository can ship code to every install. Signing the installer and setting `win.publisherName` makes the updater verify the signature too.
- **Not tested end to end:** the restart that runs the installer (`quitAndInstall`). Checking and downloading were run against a local update server with the packaged app; installing one over a real install was not.
- **Closing the app does not install a downloaded update:** only "Restart and update" does (`autoInstallOnAppQuit` is off, on purpose). The next start finds the version again and offers the restart.
- **A release goes live for everyone at once:** the workflow publishes straight to "Latest" (no draft or staged rollout), so a bad build is offered to every install within minutes. Delete the release (and tag) to stop it; installs that already downloaded it keep it until they restart.
- **Pre-releases are ignored** (`allowPrerelease` is off), so there is no beta channel.

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
