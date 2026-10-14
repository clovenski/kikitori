import { BgtError } from '../errors';
import type { SilenceInterval } from '../pipeline/chunker';
import { runProcess } from './process';

const seconds = (ms: number) => (ms / 1000).toFixed(3);
const COMMON = ['-hide_banner', '-nostdin', '-y'];

const tail = (text: string, lines = 5) => text.trim().split(/\r?\n/).slice(-lines).join('\n');

export function parseFfmpegDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

export function parseSilenceDetect(stderr: string, totalMs: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let openStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      openStart = Math.max(0, Math.round(Number(start[1]) * 1000));
    } else if (end && openStart !== null) {
      intervals.push({ startMs: openStart, endMs: Math.round(Number(end[1]) * 1000) });
      openStart = null;
    }
  }
  if (openStart !== null) intervals.push({ startMs: openStart, endMs: totalMs });
  return intervals;
}

export async function probeDurationMs(a: {
  ffmpegPath: string;
  file: string;
  signal?: AbortSignal;
}): Promise<number> {
  // ffmpeg exits non-zero without an output file, but still prints the input info.
  const r = await runProcess(a.ffmpegPath, ['-hide_banner', '-nostdin', '-i', a.file], {
    signal: a.signal,
  });
  const ms = parseFfmpegDuration(r.stderr);
  if (ms === null) {
    throw new BgtError(
      'InvalidInput',
      `Could not read a duration from "${a.file}". Is it a valid audio/video file?\n${tail(r.stderr, 3)}`,
    );
  }
  return ms;
}

export async function toWav16kMono(a: {
  ffmpegPath: string;
  input: string;
  output: string;
  startMs?: number;
  endMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const range: string[] = [];
  if (a.startMs !== undefined && a.startMs > 0) range.push('-ss', seconds(a.startMs));
  if (a.endMs !== undefined) range.push('-t', seconds(a.endMs - (a.startMs ?? 0)));
  const args = [
    ...COMMON,
    ...range,
    '-i',
    a.input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    a.output,
  ];
  const r = await runProcess(a.ffmpegPath, args, { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('InvalidInput', `ffmpeg could not convert "${a.input}":\n${tail(r.stderr)}`);
  }
}

export async function detectSilences(a: {
  ffmpegPath: string;
  wavPath: string;
  totalMs: number;
  signal?: AbortSignal;
}): Promise<SilenceInterval[]> {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i',
    a.wavPath,
    '-af',
    'silencedetect=noise=-35dB:d=0.4',
    '-f',
    'null',
    '-',
  ];
  const r = await runProcess(a.ffmpegPath, args, { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('InvalidInput', `ffmpeg silence detection failed:\n${tail(r.stderr)}`);
  }
  return parseSilenceDetect(r.stderr, a.totalMs);
}

export async function cutWav(a: {
  ffmpegPath: string;
  wavPath: string;
  startMs: number;
  endMs: number;
  outPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const args = [
    ...COMMON,
    '-ss',
    seconds(a.startMs),
    '-t',
    seconds(a.endMs - a.startMs),
    '-i',
    a.wavPath,
    '-c:a',
    'pcm_s16le',
    a.outPath,
  ];
  const r = await runProcess(a.ffmpegPath, args, { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('InvalidInput', `ffmpeg could not cut a chunk:\n${tail(r.stderr)}`);
  }
}
