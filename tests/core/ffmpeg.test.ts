import { describe, expect, it } from 'vitest';
import { parseFfmpegDuration, parseSilenceDetect } from '../../src/core/tools/ffmpeg';

describe('parseFfmpegDuration', () => {
  it('reads Duration from ffmpeg stderr', () => {
    const stderr = 'Input #0, wav, from x.wav:\n  Duration: 00:10:00.05, bitrate: 256 kb/s\n';
    expect(parseFfmpegDuration(stderr)).toBe(600_050);
    expect(parseFfmpegDuration('  Duration: 1:02:03.5, start')).toBe(3_723_500);
  });

  it('returns null when the duration is unknown', () => {
    expect(parseFfmpegDuration('  Duration: N/A, bitrate: N/A')).toBeNull();
    expect(parseFfmpegDuration('nothing here')).toBeNull();
  });
});

describe('parseSilenceDetect', () => {
  it('pairs silence_start/silence_end into intervals', () => {
    const stderr = [
      '[silencedetect @ 0000] silence_start: 12.5',
      '[silencedetect @ 0000] silence_end: 15.25 | silence_duration: 2.75',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 600_000)).toEqual([{ startMs: 12_500, endMs: 15_250 }]);
  });

  it('closes a trailing silence at the end of the audio and clamps negative starts', () => {
    const stderr = [
      '[silencedetect @ 0000] silence_start: -0.001',
      '[silencedetect @ 0000] silence_end: 1.0 | silence_duration: 1.0',
      '[silencedetect @ 0000] silence_start: 598.4',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 600_000)).toEqual([
      { startMs: 0, endMs: 1_000 },
      { startMs: 598_400, endMs: 600_000 },
    ]);
  });

  it('returns an empty list when no silence was found', () => {
    expect(parseSilenceDetect('size=N/A time=00:00:05', 5_000)).toEqual([]);
  });
});
