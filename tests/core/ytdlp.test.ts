import { describe, expect, it } from 'vitest';
import { BgtError } from '../../src/core/errors';
import type { RunResult } from '../../src/core/tools/process';
import { buildDownloadArgs, buildProbeArgs, probeVideo } from '../../src/core/tools/ytdlp';

const url = 'https://www.youtube.com/watch?v=abc123&list=PLxyz&index=4';

describe('buildProbeArgs', () => {
  it('never expands a playlist and prints the live status, then the duration, then the title as UTF-8', () => {
    const args = buildProbeArgs(url);
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--skip-download');
    expect(args[args.indexOf('--encoding') + 1]).toBe('utf-8');
    const prints = args.flatMap((a, i) => (a === '--print' ? [args[i + 1]] : []));
    expect(prints).toEqual(['live_status', 'duration', 'title']);
    expect(args[args.length - 1]).toBe(url);
  });
});

describe('probeVideo', () => {
  const probe = (stdout: string, code = 0, stderr = '') =>
    probeVideo({
      ytdlpPath: 'yt-dlp',
      url,
      run: async (): Promise<RunResult> => ({ code, stdout, stderr }),
    });

  it('returns the duration and title of a finished video', async () => {
    await expect(probe('not_live\n268\nSome title\n')).resolves.toEqual({
      durationMs: 268_000,
      title: 'Some title',
    });
  });

  it('treats a stream that has ended as a normal video once YouTube has processed it', async () => {
    await expect(probe('was_live\n4662\nTitle\n')).resolves.toMatchObject({ durationMs: 4_662_000 });
  });

  it('explains that a stream YouTube is still processing cannot be downloaded yet', async () => {
    // yt-dlp reports a real duration here, but every audio fragment answers HTTP 500.
    const err = await probe('post_live\n4662\nTitle\n').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BgtError);
    expect((err as BgtError).code).toBe('DownloadFailed');
    expect((err as BgtError).message).toMatch(/still processing/i);
    expect((err as BgtError).message).toMatch(/try again later/i);
  });

  it('keeps refusing a stream that is live right now', async () => {
    await expect(probe('is_live\nNA\nTitle\n')).rejects.toThrow(/live streams are not supported/i);
  });

  it('keeps refusing a stream that has not started yet', async () => {
    await expect(probe('is_upcoming\nNA\nTitle\n')).rejects.toThrow(/not started/i);
  });

  it('still reports a yt-dlp failure with its last stderr line', async () => {
    await expect(probe('', 1, 'WARNING: x\nERROR: Video unavailable\n')).rejects.toThrow(/Video unavailable/);
  });
});

describe('buildDownloadArgs', () => {
  const base = { url, outTemplate: 'work/1/source.%(ext)s', ffmpegPath: 'C:/tools/ffmpeg.exe' };

  it('never expands a playlist, picks audio, and points at ffmpeg', () => {
    const args = buildDownloadArgs({ ...base, section: null });
    expect(args).toContain('--no-playlist');
    expect(args).toContain('-f');
    // Prefer the Japanese track: some videos carry an auto-dubbed English track as well.
    expect(args[args.indexOf('-f') + 1]).toBe('ba[language^=ja]/ba/b');
    expect(args[args.indexOf('--js-runtimes') + 1]).toBe('node');
    expect(args[args.indexOf('--extractor-args') + 1]).toBe('youtube:player_client=default,-ios');
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('C:/tools/ffmpeg.exe');
    expect(args[args.indexOf('-o') + 1]).toBe('work/1/source.%(ext)s');
    expect(args[args.length - 1]).toBe(url);
    expect(args).not.toContain('--download-sections');
  });

  it('adds an exact section with forced cuts when a range is requested', () => {
    const args = buildDownloadArgs({ ...base, section: { startMs: 4_800_000, endMs: 6_600_000 } });
    expect(args[args.indexOf('--download-sections') + 1]).toBe('*1:20:00.000-1:50:00.000');
    expect(args).toContain('--force-keyframes-at-cuts');
  });
});
