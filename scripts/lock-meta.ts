import type { Feature, Tier } from '../src/core/tools/lock';

export interface ComponentMeta {
  id: string;
  title: string;
  features: Feature[];
  tier: 'all' | Tier;
  license: string;
  homepage: string;
}

const NVIDIA_NOTE = ' (the CUDA archive also contains NVIDIA CUDA runtime files under the NVIDIA license)';

/** Display order of the lock file. */
export const META: ComponentMeta[] = [
  { id: 'yt-dlp', title: 'yt-dlp (video downloader)', features: ['core'], tier: 'all', license: 'Unlicense', homepage: 'https://github.com/yt-dlp/yt-dlp' },
  { id: 'ffmpeg', title: 'ffmpeg (audio conversion, Gyan essentials build)', features: ['core'], tier: 'all', license: 'GPL-3.0-or-later', homepage: 'https://www.gyan.dev/ffmpeg/builds/' },
  { id: 'vad', title: 'Voice activity model (Silero VAD)', features: ['transcription'], tier: 'all', license: 'MIT', homepage: 'https://huggingface.co/ggml-org/whisper-vad' },
  { id: 'whisper-gpu', title: 'Speech recognition program (whisper.cpp, NVIDIA GPU)', features: ['transcription'], tier: 'gpu', license: `MIT${NVIDIA_NOTE}`, homepage: 'https://github.com/ggml-org/whisper.cpp' },
  { id: 'whisper-cpu', title: 'Speech recognition program (whisper.cpp, CPU)', features: ['transcription'], tier: 'cpu', license: 'MIT', homepage: 'https://github.com/ggml-org/whisper.cpp' },
  { id: 'model-transcribe-gpu', title: 'Speech recognition model (Whisper large-v3)', features: ['transcription'], tier: 'gpu', license: 'MIT', homepage: 'https://huggingface.co/ggerganov/whisper.cpp' },
  { id: 'model-transcribe-cpu', title: 'Speech recognition model (Whisper large-v3-turbo, 5-bit)', features: ['transcription'], tier: 'cpu', license: 'MIT', homepage: 'https://huggingface.co/ggerganov/whisper.cpp' },
  { id: 'llama-gpu', title: 'Language model runtime (llama.cpp, NVIDIA GPU)', features: ['translation', 'summaries'], tier: 'gpu', license: `MIT${NVIDIA_NOTE}`, homepage: 'https://github.com/ggml-org/llama.cpp' },
  { id: 'llama-cpu', title: 'Language model runtime (llama.cpp, CPU)', features: ['translation', 'summaries'], tier: 'cpu', license: 'MIT', homepage: 'https://github.com/ggml-org/llama.cpp' },
  { id: 'model-translate-gpu', title: 'Translation model (Hy-MT2 7B)', features: ['translation'], tier: 'gpu', license: 'Apache-2.0', homepage: 'https://huggingface.co/tencent/Hy-MT2-7B-GGUF' },
  { id: 'model-translate-cpu', title: 'Translation model (Hy-MT2 1.8B)', features: ['translation'], tier: 'cpu', license: 'Apache-2.0', homepage: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF' },
  { id: 'model-general-gpu', title: 'Summary model (Qwen3 8B)', features: ['summaries'], tier: 'gpu', license: 'Apache-2.0', homepage: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF' },
  { id: 'model-general-cpu', title: 'Summary model (Qwen3 4B)', features: ['summaries'], tier: 'cpu', license: 'Apache-2.0', homepage: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF' },
];
