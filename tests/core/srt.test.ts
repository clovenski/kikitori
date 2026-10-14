import { describe, expect, it } from 'vitest';
import { toSrt } from '../../src/core/subtitles/srt';

describe('toSrt', () => {
  it('numbers cues and formats HH:MM:SS,mmm', () => {
    const out = toSrt([
      { startMs: 1_000, endMs: 3_500, text: 'こんにちは' },
      { startMs: 3_723_004, endMs: 3_725_000, text: 'もう一度' },
    ]);
    expect(out).toBe(
      '1\n00:00:01,000 --> 00:00:03,500\nこんにちは\n\n2\n01:02:03,004 --> 01:02:05,000\nもう一度\n',
    );
  });

  it('returns an empty string for no segments', () => {
    expect(toSrt([])).toBe('');
  });

  it('trims text and collapses blank lines that would end a cue early', () => {
    const out = toSrt([{ startMs: 0, endMs: 1000, text: '  one\n\n\ntwo  ' }]);
    expect(out).toBe('1\n00:00:00,000 --> 00:00:01,000\none\ntwo\n');
  });
});
