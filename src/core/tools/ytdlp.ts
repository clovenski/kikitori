import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../errors';
import { formatClockMs } from '../time';
import { runProcess } from './process';

export interface Section {
  startMs: number;
  endMs: number;
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';

export function buildProbeArgs(url: string): string[] {
  return ['--no-playlist', '--skip-download', '--no-warnings', '--print', 'duration', url];
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
    'bestaudio/best',
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
  'YouTube changes often: try "pnpm bgt update-ytdlp", or download the audio yourself and pass the file path instead.';

export async function getDurationMs(a: {
  ytdlpPath: string;
  url: string;
  signal?: AbortSignal;
}): Promise<number> {
  const r = await runProcess(a.ytdlpPath, buildProbeArgs(a.url), { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('DownloadFailed', `yt-dlp could not read the video: ${lastLine(r.stderr)}. ${HINT}`);
  }
  const seconds = Number.parseFloat(lastLine(r.stdout));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new BgtError(
      'InvalidInput',
      'The video has no known duration (live streams are not supported yet).',
    );
  }
  return Math.round(seconds * 1000);
}

export async function downloadAudio(a: {
  ytdlpPath: string;
  ffmpegPath: string;
  url: string;
  workDir: string;
  section: Section | null;
  signal?: AbortSignal;
}): Promise<string> {
  // Stale files from an interrupted earlier attempt must not be mistaken for this download.
  for (const name of readdirSync(a.workDir)) {
    if (name.startsWith('source.')) rmSync(path.join(a.workDir, name), { force: true });
  }

  const args = buildDownloadArgs({
    url: a.url,
    outTemplate: path.join(a.workDir, 'source.%(ext)s'),
    ffmpegPath: a.ffmpegPath,
    section: a.section,
  });
  const r = await runProcess(a.ytdlpPath, args, { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('DownloadFailed', `yt-dlp failed: ${lastLine(r.stderr)}. ${HINT}`);
  }

  const found = readdirSync(a.workDir).find(
    (n) => n.startsWith('source.') && !n.endsWith('.part') && !n.endsWith('.ytdl'),
  );
  if (!found) throw new BgtError('DownloadFailed', 'yt-dlp finished but produced no audio file.');
  return path.join(a.workDir, found);
}

export async function updateYtDlp(ytdlpPath: string): Promise<string> {
  const r = await runProcess(ytdlpPath, ['-U']);
  const output = `${r.stdout}${r.stderr}`.trim();
  if (r.code !== 0) throw new BgtError('DownloadFailed', `yt-dlp update failed:\n${output}`);
  return output;
}
