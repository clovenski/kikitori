# Milestone 4 Design: First-Run Setup and Installer

Date: 2026-10-14
Status: Implemented on branch milestone-4 (verification record in the plan and in docs/known-issues.md)
Builds on: Milestones 1 to 3, merged on `master`. Related: `docs/known-issues.md`.

## 1. Intent

- **Outcome:** a stranger downloads `Setup.exe` from a GitHub Release, installs it without admin rights, and reaches a working app through a guided first-run setup. No terminal, no `pnpm`, no manual downloads.
- **Who:** people on ordinary Windows machines, with or without an NVIDIA GPU. The author's RTX 3080 is the only GPU that can be tested.
- **Success criteria:**
  1. On a clean Windows profile the installed app opens a setup wizard, shows the detected hardware and a download size, and after one click ends with a working app.
  2. A machine without a usable NVIDIA GPU gets a working CPU setup (smaller models) and is told what to expect.
  3. An interrupted download resumes (HTTP Range), a corrupted file is detected and re-downloaded, and "Repair" can re-verify everything.
  4. Translation and summaries can be skipped at setup and added later, on demand, the first time a job needs them.
  5. "Update yt-dlp" works from the app, and a failed download offers it.
  6. Tagging `vX.Y.Z` builds the installer in CI and attaches it with a SHA-256 file to a GitHub Release.
  7. Every downloaded component is listed with its licence in `THIRD_PARTY_NOTICES.md`, and the project has a `LICENSE` (MIT).
- **Non-goals:** app auto-update, code signing, AMD/Intel GPUs, macOS/Linux, the Gemini backend, channel watching, the polished README and demo GIF (Milestone 6).

## 2. Decisions

| Topic | Decision |
|---|---|
| Hardware paths | NVIDIA GPU tier plus CPU-only tier; the user can override the detected tier |
| ffmpeg | Downloaded on first run, pinned and checksum-verified: Gyan `ffmpeg-9.0.2-essentials_build.zip` (permanent per-version release tag, 109 MB). Not redistributed by us |
| Download scope | One "Recommended setup" button for the detected tier; Translation and Summaries are opt-outs that download on demand later |
| Installer | One per-user NSIS installer from `electron-builder`; no admin rights; nothing but the app, the lock file and notices inside it |
| Signing | None. The README documents the SmartScreen warning |
| Licence | MIT, copyright "Joel Tengco" (confirmed) |
| Packaged data location | `%APPDATA%\\BG Auto Translator` for tools, models, database and settings; `Documents\\BG Auto Translator` for subtitles and summaries |
| Development | Unchanged: the project's `data/`, `resources/`, `output/`. The wizard stays out of the way if the needed components are already present |

## 3. Tiers and components

### 3.1 Hardware detection (`src/core/setup/hardware.ts`)
- `parseNvidiaSmi(csv)` reads `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`.
- `decideTier(hw)` returns `{ tier, reason }`:
  - `gpu` when an NVIDIA GPU has at least 7500 MB VRAM (8 GB cards report 8188 to 8192 MB) and driver 551 or newer (the CUDA 12.4 builds need it).
  - `cpu` otherwise, with a reason such as "no NVIDIA GPU found", "only 6144 MB of VRAM (8 GB needed)" or "NVIDIA driver 535 is older than 551".
- Also reports CPU core count and RAM, used only for messages (for example a warning below 8 GB RAM on the CPU tier). Detection failure (no `nvidia-smi`) means "no NVIDIA GPU".
- The wizard shows the result and lets the user switch tier.

### 3.2 Components (`tools.lock.json`, schema v2)
The lock groups pinned downloads into named components. Each component has `id`, `title`, `features` (a list of `core | transcription | translation | summaries`), `tier` (`all | gpu | cpu`), `license`, `homepage`, and `files` (the existing `LockEntry` shape plus `size` in bytes; yt-dlp also has `selfUpdates: true` because `yt-dlp -U` replaces it, so a changed size or checksum is not damage). Installing a component installs all its files.

| Component | Tier | Feature | Contents |
|---|---|---|---|
| `yt-dlp` | all | core | yt-dlp.exe (Unlicense) |
| `ffmpeg` | all | core | Gyan essentials 9.0.2 zip, extracted to `ffmpeg/` |
| `vad` | all | transcription | Silero VAD ggml |
| `whisper-gpu` / `whisper-cpu` | gpu / cpu | transcription | whisper.cpp CUDA 12.4 zip / CPU zip, extracted to `whisper/` |
| `model-transcribe-gpu` / `-cpu` | gpu / cpu | transcription | `ggml-large-v3.bin` (2.9 GB) / `ggml-large-v3-turbo-q5_0.bin` (547 MB) |
| `llama-gpu` / `llama-cpu` | gpu / cpu | translation, summaries | llama.cpp CUDA 12.4 zip + cudart zip / CPU zip, extracted to `llama/` |
| `model-translate-gpu` / `-cpu` | gpu / cpu | translation | Hy-MT2-7B Q4_K_M (4.7 GB) / Hy-MT2-1.8B Q4_K_M (1.1 GB) |
| `model-general-gpu` / `-cpu` | gpu / cpu | summaries | Qwen3-8B Q4_K_M (5 GB) / Qwen3-4B Q4_K_M (2.4 GB) |

Both tiers install to the same folders (`whisper/`, `llama/`, `models/`), so the existing tool and model lookups keep working. Switching tier replaces those components.

Required components per feature: **transcription** = `core` + its transcription components; **translation** = `llama-*` + `model-translate-*`; **summaries** = `llama-*` + `model-general-*`. The auto-glossary needs the general model, so with Translation on and Summaries off the translation stage **skips the glossary with a notice** instead of failing (a user glossary file still applies). That keeps "Translation only" about 5 GB smaller on the GPU tier.

Approximate totals: GPU tier about 14 GB with everything, CPU tier about 4.5 GB. The wizard shows the real number computed from the lock's `size` fields.

### 3.3 Model names per tier
The transcription model name used in jobs follows the tier: `large-v3` on GPU, `large-v3-turbo-q5_0` on CPU (the existing `ggml-<name>.bin` convention). The new-job dialog and CLI default to the tier's name from settings; submissions keep storing the name they were created with. `createRealModelPool` takes the tier and resolves `model-translate-<tier>` / `model-general-<tier>` from the lock.

## 4. Settings and state

`settings.json` in the data directory, written atomically: `{ version: 1, tier, features: { translation, summaries }, setupCompleted }`. The filesystem is the source of truth for "is it installed": a file counts when it exists with the pinned size, an unpacked archive counts when its checksum marker file matches. `Repair` re-hashes model and data files and deletes the ones that do not match, then downloads them again. In development, a missing `settings.json` plus all components present for some tier writes a completed settings file without showing the wizard.

## 5. Download manager (`src/core/setup/`)

- `download.ts`: resumable download with `Range` (`.part` file; `206` appends, a `200` restarts), progress callback with bytes, speed and ETA, abort via `AbortSignal`; follows redirects; a stalled connection (no bytes for 30 s) is retried.
- `installer.ts`: `installComponents(plan, { onProgress, signal })` runs one file at a time: free-space check, download, SHA-256 check (a mismatch deletes the file and retries once, then fails with a clear message), extract for archives, record in `settings.json`. Reuses the existing `fetchEntry` extraction and merge logic.
- Free space: refuses to start unless the free space on the target drive is at least the remaining bytes plus the largest archive (extraction needs both), with a message that names the shortfall.
- `plan.ts`: `buildPlan(lock, tier, features, installed)` returns the components still needed with sizes; `requiredComponents(options, tier)` maps job options (translate/summarize/skim) to components.
- Errors: `DownloadFailed` (network, HTTP status, checksum) and a new `SetupRequired` carrying the missing component ids and total size.

## 6. Main process and IPC

- **Packaged paths:** before any core code runs, `main` sets `BGT_PROJECT_ROOT` to `process.resourcesPath` (where `tools.lock.json` and the notices are shipped via `extraResources`), `BGT_RESOURCES_DIR`, `BGT_DATA_DIR`, and a new `BGT_OUTPUT_DIR` from the locations in section 2, and calls `app.setName('BG Auto Translator')`. `BGT_USER_DATA` overrides the base folder (used to test with an empty profile).
- **`SetupService`:** one install at a time; holds state (`idle | installing | failed | done`), current component and file, aggregate progress.
- **IPC additions:** `setup.state()`, `setup.detect()`, `setup.plan({ tier, features })`, `setup.start({ tier, features })`, `setup.cancel()`, `setup.repair()`, `setup.updateYtDlp()`, `setup.openNotices()`; pushed event `setup:progress`. Existing handlers stay.
- **On demand:** `queue.submit` (and `runSubmission`) check `requiredComponents`; a missing one returns a typed `SetupRequired` error with the component list and size. The renderer asks "Download the translation model (4.7 GB)?", runs `setup.start` for just those components, then resubmits.
- **yt-dlp update:** `yt-dlp -U` in the user-writable `resources/bin`; a failed job whose error is `DownloadFailed` shows an "Update yt-dlp" button.
- **Gating:** if `setupCompleted` is false, or a `core` component is missing, the renderer shows the wizard instead of the library.

## 7. Renderer

- **Wizard** (full screen, four steps): Welcome (personal-use and YouTube terms notice, link to third-party notices) → Hardware and Recommended setup (detected GPU or reason for CPU, tier switch, two opt-out checkboxes, total size and free disk space, Install) → Downloading (a bar per component with speed, remaining time, Cancel; on failure, the reason and Retry) → Done ("Add your first video").
- **Tools page** (a button in the top bar): installed components with sizes and versions, "Update yt-dlp", "Add translation / summaries", "Repair", "Switch tier", and the notices link.
- **On-demand prompt:** a small dialog with the component names and size, then the same progress UI.
- **Unfinished setup:** closing the app mid-download keeps `.part` files; the next start resumes.

## 8. Installer and release

- `electron-builder.yml`: `appId`, `productName: BG Auto Translator`, output `dist/`, `files: out/**`, `extraResources: tools.lock.json, THIRD_PARTY_NOTICES.md, LICENSE`, Windows target `nsis` x64, `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`, desktop and Start menu shortcuts, `deleteAppDataOnUninstall: false` (downloaded models survive an uninstall, and the uninstaller says where they are). A simple generated placeholder icon (`build/icon.ico`) that the author can replace.
- `package.json` gains `description`, `author`, `license`, `homepage`; scripts `build:installer` and `smoke:installed`.
- **CI** (`.github/workflows`): `ci.yml` on push and pull request runs install (frozen lockfile), tests, typecheck, lint, `build:app` and the smoke test on `windows-latest` with Node 24; `release.yml` on tags `v*` additionally builds the installer, writes `SHA256SUMS.txt` and publishes with `gh release create --generate-notes` (`contents: write`). The integration tests that need models never run in CI.
- No code signing; the README states the SmartScreen steps ("More info", "Run anyway").

## 9. Licences and notices

- `LICENSE`: MIT.
- `THIRD_PARTY_NOTICES.md` lists every downloaded component with version, licence, source and the fact that it is downloaded from its publisher rather than redistributed by this project: yt-dlp (Unlicense), ffmpeg Gyan essentials (GPLv3, source at the publisher), whisper.cpp (MIT), llama.cpp (MIT), CUDA runtime files inside the upstream CUDA archives (NVIDIA licence), Silero VAD (MIT), Whisper large-v3 (MIT), Hy-MT2 (Apache-2.0), Qwen3 (Apache-2.0); and, for the app itself, Electron and React (MIT).
- A test fails when a component in `tools.lock.json` has no `license` field or is missing from the notices file.

## 10. Error handling

- No network, HTTP 403/404/429, TLS failures: a plain-language message with the failing component and a Retry; the lock URL is shown in an expandable detail.
- Checksum mismatch: delete, retry once, then fail with "the download was corrupted twice".
- Disk full during extraction: clean up the partial folder, report the shortfall.
- Cancel: stops the transfer, keeps `.part` files for resume, leaves finished components installed.
- A tier switch asks for confirmation (it replaces runtimes and models) and keeps data and settings.
- A component present but failing its checksum on Repair is re-downloaded; Repair never touches the database or output.

## 11. Testing

- **Unit (Node):** `parseNvidiaSmi` and `decideTier` (no GPU, low VRAM, old driver, multi-GPU, malformed output); `buildPlan` and `requiredComponents` (tiers, features, already-installed parts, glossary skip rule); resumable download against a local HTTP server (full, resume from `.part`, server ignoring Range, stall, abort, redirect); installer sequencing with a fake downloader (checksum failure retry, disk-space refusal, extraction failure cleanup, cancel); settings atomic write and dev auto-detection; lock schema validation (sizes, licences, notices coverage); packaged path resolution.
- **Component (jsdom):** wizard steps and transitions, opt-out sizes, tier switch warning, failure and retry, on-demand prompt, Tools page actions.
- **Local build verification:** `build:installer`, silent install into a temp folder, launch with `BGT_USER_DATA` pointing at an empty folder and `--smoke`, confirm the wizard is the first screen.
- **Real run (author's machine):** force the CPU tier with real downloads into an empty profile and run the wizard to completion, interrupt a download and resume it, corrupt a model and Repair, then transcribe, translate and summarize a short video with the CPU components. Repeat the GPU tier on the author's existing profile to confirm nothing regressed.

## 12. Risks and open items

- **SmartScreen and antivirus:** an unsigned installer warns on first run; yt-dlp and llama binaries are occasionally flagged by antivirus tools. Both are documented, not fixed.
- **Hosting:** pinned URLs on GitHub, Hugging Face and Gyan's release page can disappear or be rate-limited. Checksums turn that into a clear error; the lock must be re-pinned when it happens.
- **CPU tier quality and speed are unmeasured** until the real run; the wizard's wording must not promise numbers it has not seen.
- **CUDA driver check** uses 551 as the threshold for the CUDA 12.4 builds; a machine that passes it can still fail at run time, which is why the CPU override and Repair exist.
- **Open items for the author:** create the GitHub repository and the first tag (nothing is pushed until asked). The app icon is a generated placeholder, which the author accepted.
