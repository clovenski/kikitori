import { describe, expect, it } from 'vitest';
import { buildDownloadArgs, buildProbeArgs } from '../../src/core/tools/ytdlp';

const url = 'https://www.youtube.com/watch?v=abc123&list=PLxyz&index=4';

describe('buildProbeArgs', () => {
  it('never expands a playlist and prints the duration then the title as UTF-8', () => {
    const args = buildProbeArgs(url);
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--skip-download');
    expect(args[args.indexOf('--encoding') + 1]).toBe('utf-8');
    const prints = args.flatMap((a, i) => (a === '--print' ? [args[i + 1]] : []));
    expect(prints).toEqual(['duration', 'title']);
    expect(args[args.length - 1]).toBe(url);
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
