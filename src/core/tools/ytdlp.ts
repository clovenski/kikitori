import { readdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { BgtError } from '../errors';
import { formatClockMs } from '../time';
import { runProcess } from './process';

export interface Section {
  startMs: number;
  endMs: number;
}

const tailLines = (text: string, n: number) =>
  text.trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' | ');
const lastLine = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';

export function buildProbeArgs(url: string): string[] {
  return [
    '--no-playlist',
    '--skip-download',
    '--no-warnings',
    '--encoding',
    'utf-8',
    '--print',
    'live_status',
    '--print',
    'duration',
    '--print',
    'title',
    url,
  ];
}

export function buildDownloadArgs(a: {
  url: string;
  outTemplate: string;
  ffmpegPath: string;
  section: Section | null;
}): string[] {
  const args = [
    '--no-playlist',
    '--no-progress',
    '-f',
    'ba[language^=ja]/ba/b',
    // YouTube extraction needs a JS runtime; node is already required to run this tool.
    '--js-runtimes',
    'node',
    // The default iOS client's audio URLs answer 403.
    '--extractor-args',
    'youtube:player_client=default,-ios',
    '--ffmpeg-location',
    a.ffmpegPath,
  ];
  if (a.section) {
    args.push(
      '--download-sections',
      `*${formatClockMs(a.section.startMs)}-${formatClockMs(a.section.endMs)}`,
      '--force-keyframes-at-cuts',
    );
  }
  args.push('-o', a.outTemplate, a.url);
  return args;
}

const HINT =
  'YouTube changes often: try "pnpm kikitori update-ytdlp", or download the audio yourself and pass the file path instead.';

export async function probeVideo(a: {
  ytdlpPath: string;
  url: string;
  signal?: AbortSignal;
  /** Injectable for tests. */
  run?: typeof runProcess;
}): Promise<{ durationMs: number; title: string | null }> {
  const run = a.run ?? runProcess;
  const r = await run(a.ytdlpPath, buildProbeArgs(a.url), { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('DownloadFailed', `yt-dlp could not read the video: ${lastLine(r.stderr)}. ${HINT}`);
  }
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim());
  const liveStatus = lines[0] ?? '';
  // A stream that just ended reports a real duration, but YouTube answers every audio fragment with
  // HTTP 500 until it has processed the recording, which surfaces as "The downloaded file is empty".
  if (liveStatus === 'post_live') {
    throw new BgtError(
      'DownloadFailed',
      'YouTube is still processing this stream, so its audio cannot be downloaded yet. Try again later (usually within a few hours of the stream ending).',
    );
  }
  if (liveStatus === 'is_upcoming') {
    throw new BgtError('InvalidInput', 'This stream has not started yet.');
  }
  const seconds = Number.parseFloat(lines[1] ?? '');
  if (liveStatus === 'is_live' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new BgtError(
      'InvalidInput',
      'The video has no known duration (live streams are not supported yet).',
    );
  }
  const title = lines.slice(2).join(' ').trim();
  return { durationMs: Math.round(seconds * 1000), title: title === '' || title === 'NA' ? null : title };
}

/** Failures that asking again cannot fix; they are reported at once instead of after three attempts. */
const PERMANENT =
  /Requested format is not available|No space left on device|Private video|members-only|Video unavailable|This video is (?:private|unavailable)|Sign in to confirm/i;

export async function downloadAudio(a: {
  ytdlpPath: string;
  ffmpegPath: string;
  url: string;
  workDir: string;
  section: Section | null;
  signal?: AbortSignal;
  /** Total tries; YouTube media URLs fail intermittently (ffmpeg gets a 403) and the next try works. */
  attempts?: number;
  backoffMs?: number;
  /** Injectable for tests. */
  run?: typeof runProcess;
}): Promise<string> {
  const attempts = a.attempts ?? 3;
  const run = a.run ?? runProcess;
  const args = buildDownloadArgs({
    url: a.url,
    outTemplate: path.join(a.workDir, 'source.%(ext)s'),
    ffmpegPath: a.ffmpegPath,
    section: a.section,
  });

  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Stale or partial files from an earlier attempt must not be mistaken for this download.
    for (const name of readdirSync(a.workDir)) {
      if (name.startsWith('source.')) rmSync(path.join(a.workDir, name), { force: true });
    }

    // An abort rejects here and is never retried.
    const r = await run(a.ytdlpPath, args, { signal: a.signal });
    if (r.code === 0) {
      const found = readdirSync(a.workDir).find(
        (n) => n.startsWith('source.') && !n.endsWith('.part') && !n.endsWith('.ytdl'),
      );
      if (found) return path.join(a.workDir, found);
      lastError = 'yt-dlp finished but produced no audio file';
    } else {
      lastError = tailLines(r.stderr, 3);
      if (PERMANENT.test(r.stderr)) {
        throw new BgtError('DownloadFailed', 'yt-dlp cannot download this video: ' + lastError + '. ' + HINT);
      }
    }
    if (attempt < attempts) await sleep((a.backoffMs ?? 2000) * attempt, undefined, { signal: a.signal });
  }
  throw new BgtError('DownloadFailed', `yt-dlp failed after ${attempts} attempts: ${lastError}. ${HINT}`);
}

export async function updateYtDlp(ytdlpPath: string): Promise<string> {
  const r = await runProcess(ytdlpPath, ['-U']);
  const output = `${r.stdout}${r.stderr}`.trim();
  if (r.code !== 0) throw new BgtError('DownloadFailed', `yt-dlp update failed:\n${output}`);
  return output;
}
