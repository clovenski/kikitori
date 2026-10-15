# Third-party notices

Kikitori is MIT licensed (see `LICENSE`). The installer contains only the app. On first run the app
**downloads** the programs and models below from their publishers; this project does not redistribute them.
Each keeps its own license. Exact versions and checksums are pinned in `tools.lock.json`.

| Component id | What it is | License | Source |
|---|---|---|---|
| `yt-dlp` | yt-dlp, video downloader | Unlicense | https://github.com/yt-dlp/yt-dlp |
| `ffmpeg` | ffmpeg, audio conversion (Gyan essentials build) | GPL-3.0-or-later | https://www.gyan.dev/ffmpeg/builds/ |
| `vad` | Silero voice activity model | MIT | https://huggingface.co/ggml-org/whisper-vad |
| `whisper-gpu` | whisper.cpp, speech recognition (NVIDIA GPU build) | MIT (the CUDA archive also contains NVIDIA CUDA runtime files under the NVIDIA license) | https://github.com/ggml-org/whisper.cpp |
| `whisper-cpu` | whisper.cpp, speech recognition (CPU build) | MIT | https://github.com/ggml-org/whisper.cpp |
| `model-transcribe-gpu` | Whisper large-v3 model | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| `model-transcribe-cpu` | Whisper large-v3-turbo model (5-bit) | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| `llama-gpu` | llama.cpp, language model runtime (NVIDIA GPU build) | MIT (the CUDA archive also contains NVIDIA CUDA runtime files under the NVIDIA license) | https://github.com/ggml-org/llama.cpp |
| `llama-cpu` | llama.cpp, language model runtime (CPU build) | MIT | https://github.com/ggml-org/llama.cpp |
| `model-translate-gpu` | Tencent Hy-MT2 7B translation model | Apache-2.0 | https://huggingface.co/tencent/Hy-MT2-7B-GGUF |
| `model-translate-cpu` | Tencent Hy-MT2 1.8B translation model | Apache-2.0 | https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF |
| `model-general-gpu` | Qwen3 8B model (names and summaries) | Apache-2.0 | https://huggingface.co/Qwen/Qwen3-8B-GGUF |
| `model-general-cpu` | Qwen3 4B model (names and summaries) | Apache-2.0 | https://huggingface.co/Qwen/Qwen3-4B-GGUF |

## ffmpeg and the GPL

The ffmpeg build is downloaded straight from its publisher and run as a separate program; this project does not
redistribute it. Its source code is available from https://ffmpeg.org and https://www.gyan.dev/ffmpeg/builds/.

## What the installer contains

- Electron and Chromium (MIT and other licenses; the texts are in `LICENSE.electron.txt` and
  `LICENSES.chromium.html` in the installation folder)
- React (MIT) and extract-zip (BSD-2-Clause), bundled into the app

The app is for personal use. Downloading videos may be against the terms of the site they come from; follow them
and the rights of the people who made the videos.
