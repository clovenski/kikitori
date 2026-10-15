## Kikitori VERSION

**Understand Japanese videos, on your own computer.** Kikitori listens to a Japanese YouTube video (or an audio/video file),
writes down what is said, translates it to English and summarizes it with timestamps, then shows everything next to the
video with subtitles that follow along. Everything runs locally and costs nothing.

### Install

1. Download **`Kikitori-Setup-VERSION.exe`** below (Windows 10 or 11, 64-bit). No administrator rights are needed.
2. Windows SmartScreen will warn ("Windows protected your PC") because the installer is not code-signed. Click **More info**,
   then **Run anyway**.
3. On first start the setup wizard looks at your computer and offers a one-click download of the tools and AI models it needs.

### What you get

- **Transcription, translation and summaries**, all local: Whisper for speech, Hy-MT2 for translation, Qwen3 for names and summaries.
- **A library** of everything you have processed, with a job page that plays the video with synced Japanese and English subtitles,
  a clickable transcript and a timestamped summary.
- **Long videos handled in chunks**, resumable after a restart, with no cap on length (set a start and end to pick the part you want).
- **Skim mode** for a summary without a full translation, and an optional glossary file for names and terms.
- **Channels**: follow YouTube channels and see their new videos and finished live streams in a feed, checked while the app is open. One click sends a video to a new job.
- **Updates**: the app tells you when a newer version is out. Nothing downloads until you press Download, and nothing installs until you press Restart and update. Installs of 0.2.0 or older have no updater and have to be updated by hand once, with this installer.
- **Subtitle files** (`.srt`, Japanese, English and bilingual) and a Markdown summary written to `Documents\Kikitori`, or to a folder you choose.
- **Deleting jobs** from the library, which also removes the files written for them.

### What the setup downloads

| Your computer | Download | Notes |
|---|---|---|
| NVIDIA GPU with 8 GB or more (driver 551+) | about 14 GB | fast path |
| Anything else (CPU only) | about 4.5 GB | transcription is slower than real time |

Translation and Summaries are optional in the wizard; anything you skip is downloaded the first time you need it.
Tools and models live in `%APPDATA%\Kikitori` and survive an uninstall. Every download is pinned to a checksum.

### Verify your download

`SHA256SUMS.txt` is attached. In PowerShell: `Get-FileHash .\Kikitori-Setup-VERSION.exe` and compare.

### Good to know

- The installer is unsigned, and some antivirus programs flag yt-dlp or the model runtimes. They are downloaded from their publishers.
- Personal use only. Downloading videos may be against the terms of the site they come from. Never publish downloaded media or transcripts.
- Known limitations are listed in [docs/known-issues.md](https://github.com/clovenski/kikitori/blob/master/docs/known-issues.md).

---

