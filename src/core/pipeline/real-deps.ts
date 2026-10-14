import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { WhisperCppTranscriber } from '../backends/transcribe/whispercpp';
import { openDb } from '../db';
import { Repo } from '../db/repo';
import { BgtError } from '../errors';
import { cutWav, detectSilences, probeDurationMs, toWav16kMono } from '../tools/ffmpeg';
import { findVadModel, modelPath, resolveTool } from '../tools/paths';
import { downloadAudio, getDurationMs } from '../tools/ytdlp';
import { createPerfStore } from './estimate';
import type { PipelineDeps } from './run';

export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

export function createRealDeps(a: {
  dataDir: string;
  model: string;
  log: (message: string) => void;
}): { deps: PipelineDeps; workRoot: string; close(): void } {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(a.model)) {
    throw new BgtError('InvalidInput', `Invalid model name "${a.model}".`);
  }
  const db = openDb(path.join(a.dataDir, 'bgt.sqlite'));
  const ffmpegPath = resolveTool('ffmpeg');

  const deps: PipelineDeps = {
    repo: new Repo(db),
    log: a.log,
    perf: createPerfStore(path.join(a.dataDir, 'perf.json')),
    transcriber: new WhisperCppTranscriber({
      whisperPath: resolveTool('whisper-cli'),
      modelPath: modelPath(`ggml-${a.model}.bin`),
      vadModelPath: findVadModel(),
    }),

    async probeDurationMs(source, signal) {
      if (isUrl(source)) {
        return getDurationMs({ ytdlpPath: resolveTool('yt-dlp'), url: source, signal });
      }
      if (!existsSync(source) || !statSync(source).isFile()) {
        throw new BgtError('InvalidInput', `File not found: ${source}`);
      }
      return probeDurationMs({ ffmpegPath, file: source, signal });
    },

    async fetchAudio(f) {
      if (isUrl(f.source)) {
        const section =
          f.startMs > 0 || f.endMs < f.fullDurationMs ? { startMs: f.startMs, endMs: f.endMs } : null;
        const downloaded = await downloadAudio({
          ytdlpPath: resolveTool('yt-dlp'),
          ffmpegPath,
          url: f.source,
          workDir: f.workDir,
          section,
          signal: f.signal,
        });
        await toWav16kMono({ ffmpegPath, input: downloaded, output: f.outWavPath, signal: f.signal });
      } else {
        await toWav16kMono({
          ffmpegPath,
          input: f.source,
          output: f.outWavPath,
          startMs: f.startMs,
          endMs: f.endMs,
          signal: f.signal,
        });
      }
    },

    detectSilences: (wavPath, totalMs, signal) =>
      detectSilences({ ffmpegPath, wavPath, totalMs, signal }),

    cutWav: (c) => cutWav({ ffmpegPath, ...c }),
  };

  return { deps, workRoot: path.join(a.dataDir, 'work'), close: () => db.close() };
}
