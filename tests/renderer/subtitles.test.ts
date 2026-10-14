import { describe, expect, it } from 'vitest';
import { findActiveIndex, subtitleText } from '../../src/app/renderer/lib/subtitles';

const L = (startMs: number, endMs: number) => ({ startMs, endMs });

describe('findActiveIndex', () => {
  const lines = [L(1000, 2000), L(2500, 4000), L(4000, 5000), L(9000, 9500)];

  it('returns -1 for an empty list', () => {
    expect(findActiveIndex([], 1500)).toBe(-1);
  });

  it('returns -1 before the first line and after the last one has ended', () => {
    expect(findActiveIndex(lines, 0)).toBe(-1);
    expect(findActiveIndex(lines, 999)).toBe(-1);
    expect(findActiveIndex(lines, 9500)).toBe(-1);
    expect(findActiveIndex(lines, 60_000)).toBe(-1);
  });

  it('finds the line containing the time (start inclusive, end exclusive)', () => {
    expect(findActiveIndex(lines, 1000)).toBe(0);
    expect(findActiveIndex(lines, 1999)).toBe(0);
    expect(findActiveIndex(lines, 2500)).toBe(1);
    expect(findActiveIndex(lines, 4000)).toBe(2);
    expect(findActiveIndex(lines, 9499)).toBe(3);
  });

  it('returns -1 in a gap between lines', () => {
    expect(findActiveIndex(lines, 2000)).toBe(-1);
    expect(findActiveIndex(lines, 2499)).toBe(-1);
    expect(findActiveIndex(lines, 6000)).toBe(-1);
  });

  it('prefers the later line when two start at the same time', () => {
    expect(findActiveIndex([L(1000, 3000), L(1000, 3000)], 1500)).toBe(1);
  });

  it('keeps the earlier line active while a later overlapping one has not started', () => {
    expect(findActiveIndex([L(1000, 5000), L(3000, 4000)], 2000)).toBe(0);
    expect(findActiveIndex([L(1000, 5000), L(3000, 4000)], 3500)).toBe(1);
  });
});

describe('subtitleText', () => {
  it('returns English, Japanese or both, falling back to Japanese when English is missing', () => {
    expect(subtitleText({ ja: 'こんにちは', en: 'Hello' }, 'en')).toEqual(['Hello']);
    expect(subtitleText({ ja: 'こんにちは', en: 'Hello' }, 'ja')).toEqual(['こんにちは']);
    expect(subtitleText({ ja: 'こんにちは', en: 'Hello' }, 'both')).toEqual(['Hello', 'こんにちは']);
    expect(subtitleText({ ja: 'えっと', en: null }, 'en')).toEqual(['えっと']);
    expect(subtitleText({ ja: 'えっと', en: null }, 'both')).toEqual(['えっと']);
  });
});
