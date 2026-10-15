# Development

## Commands
- `pnpm setup:tools` downloads yt-dlp, whisper.cpp, llama.cpp and the models into `resources/` (see `tools.lock.json`).
- `pnpm kikitori run <url|file> [--translate --summarize --skim]` is the command-line pipeline.
- `pnpm dev:app` starts the desktop app with hot reload. `pnpm build:app` builds it; `pnpm smoke:app` launches the build headless and checks the window and IPC bridge.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` (BGT_INTEGRATION=1 enables the tests that use the real binaries and models).

## Layout
- `src/core` pipeline, database, tool wrappers; no Electron or React imports.
- `src/app/main` Electron main process (queue, IPC handlers, media protocol); `src/app/preload` the `window.bgt` bridge; `src/app/renderer` the React UI; `src/app/shared` types shared by both.
- Data lives in `data/` (SQLite, work files) and `output/` (subtitles, summaries). The app and the CLI share them.
