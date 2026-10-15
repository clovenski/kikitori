# BG Auto Translator

Understand Japanese YouTube videos without speaking Japanese: it transcribes the audio on your own computer,
translates it to English and writes a timestamped summary, shown next to the video with synced subtitles.
Everything runs locally and costs nothing.

> Personal use only. Downloading videos may be against the terms of the site they come from, so follow them.
> Never publish downloaded media or transcripts, and never commit them to a repository.

## Install (Windows 10 or 11, 64-bit)

1. Download `BG-Auto-Translator-Setup-<version>.exe` from the Releases page. Check it against `SHA256SUMS.txt`
   if you like (`Get-FileHash <file>` in PowerShell).
2. Run it. **Windows SmartScreen will warn** ("Windows protected your PC") because the installer is not signed:
   click **More info**, then **Run anyway**. No administrator rights are needed.
3. On first start the app looks at your computer and offers a one-click setup:
   - **NVIDIA GPU with 8 GB or more** (driver 551 or newer): about 14 GB of fast programs and models.
   - **Anything else (CPU only)**: about 4.5 GB. Transcription is slower than real time on this path.
   You can leave out Translation and Summaries; they are downloaded the first time you need them.
4. Paste a YouTube link (or drop an audio/video file) and press **Add to queue**.

Downloaded tools and models live in `%APPDATA%\BG Auto Translator`; subtitles and summaries are written to
`Documents\BG Auto Translator`. Uninstalling keeps them, so delete the first folder yourself to free the space.
Antivirus programs sometimes flag yt-dlp or the model runtimes; they are downloaded from their publishers and
checked against pinned checksums.

## Development

```
pnpm install
pnpm setup:tools           # downloads the GPU set into resources/ (add --tier cpu for the CPU set)
pnpm dev:app               # run the desktop app
pnpm bgt run <url> --translate --summarize
pnpm test && pnpm typecheck && pnpm lint
pnpm build:installer       # dist/BG-Auto-Translator-Setup-<version>.exe
```

`BGT_USER_DATA=<folder>` runs the app against an empty profile (it then shows the first-run wizard).
Third-party components and licences: `THIRD_PARTY_NOTICES.md`. Project licence: MIT.
