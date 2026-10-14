import { describe, expect, it } from 'vitest';
import { formatClock, formatClockMs, parseTimestamp, resolveRange } from '../../src/core/time';

describe('parseTimestamp', () => {
  it.each([
    ['90', 90_000],
    ['1:30', 90_000],
    ['80:00', 4_800_000],
    ['1:20:00', 4_800_000],
    ['0:00:01.5', 1_500],
    ['12.25', 12_250],
    ['  1:00  ', 60_000],
  ])('parses %s', (input, expected) => {
    expect(parseTimestamp(input)).toBe(expected);
  });

  it.each(['', 'abc', '1:2:3:4', '1:75', '1:20:99', '-5', '1.', '1.2345', '1..2', '1:00:00:00'])(
    'rejects %j',
    (input) => {
      expect(() => parseTimestamp(input)).toThrow(/Invalid time/);
    },
  );
});

describe('formatClock', () => {
  it('formats without and with milliseconds', () => {
    expect(formatClock(4_800_000)).toBe('1:20:00');
    expect(formatClock(61_005)).toBe('0:01:01');
    expect(formatClockMs(61_005)).toBe('0:01:01.005');
  });
});

describe('resolveRange', () => {
  const base = { durationMs: 3_600_000, maxMinutes: 30 };

  it('defaults the end to the video duration when it fits the cap', () => {
    expect(resolveRange({ ...base, durationMs: 600_000, startMs: 0, endMs: null })).toEqual({
      startMs: 0,
      endMs: 600_000,
    });
  });

  it('keeps an explicit range', () => {
    expect(resolveRange({ ...base, startMs: 60_000, endMs: 360_000 })).toEqual({
      startMs: 60_000,
      endMs: 360_000,
    });
  });

  it('clamps an end beyond the video to the duration', () => {
    expect(resolveRange({ ...base, durationMs: 600_000, startMs: 0, endMs: 9_999_000 }).endMs).toBe(
      600_000,
    );
  });

  it('rejects start at or beyond the duration', () => {
    expect(() => resolveRange({ ...base, startMs: 3_600_000, endMs: null })).toThrow(/start/i);
    expect(() => resolveRange({ ...base, startMs: 4_000_000, endMs: null })).toThrow(/start/i);
  });

  it('rejects end <= start', () => {
    expect(() => resolveRange({ ...base, startMs: 100_000, endMs: 100_000 })).toThrow(/end/i);
    expect(() => resolveRange({ ...base, startMs: 100_000, endMs: 50_000 })).toThrow(/end/i);
  });

  it('fails with OverCap when the range exceeds the cap, including an open-ended range', () => {
    expect(() => resolveRange({ ...base, startMs: 0, endMs: 1_801_000 })).toThrow(
      expect.objectContaining({ code: 'OverCap' }),
    );
    expect(() => resolveRange({ ...base, startMs: 0, endMs: null })).toThrow(
      expect.objectContaining({ code: 'OverCap' }),
    );
  });

  it('allows exactly the cap', () => {
    expect(resolveRange({ ...base, startMs: 0, endMs: 1_800_000 }).endMs).toBe(1_800_000);
  });
});
