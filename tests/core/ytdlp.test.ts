import { describe, expect, it } from 'vitest';
import { buildDownloadArgs, buildProbeArgs } from '../../src/core/tools/ytdlp';

const url = 'https://www.youtube.com/watch?v=abc123&list=PLxyz&index=4';

describe('buildProbeArgs', () => {
  it('never expands a playlist and only prints the duration', () => {
    const args = buildProbeArgs(url);
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--skip-download');
    expect(args.slice(args.indexOf('--print'), args.indexOf('--print') + 2)).toEqual(['--print', 'duration']);
    expect(args[args.length - 1]).toBe(url);
  });
});

describe('buildDownloadArgs', () => {
  const base = { url, outTemplate: 'work/1/source.%(ext)s', ffmpegPath: 'C:/tools/ffmpeg.exe' };

  it('never expands a playlist, picks audio, and points at ffmpeg', () => {
    const args = buildDownloadArgs({ ...base, section: null });
    expect(args).toContain('--no-playlist');
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('bestaudio/best');
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
