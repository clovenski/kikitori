import { describe, expect, it } from 'vitest';
import { renderWindow, splitWindows } from '../../src/core/llm/windows';

const s = (startMs: number, text: string) => ({ startMs, endMs: startMs + 1000, text });

describe('splitWindows', () => {
  it('groups by window, skips empty windows and renumbers', () => {
    const windows = splitWindows(
      [s(1000, 'a'), s(299_000, 'b'), s(300_000, 'c'), s(1_000_000, 'd')],
      300_000,
    );
    expect(windows.map((w) => w.segments.map((x) => x.text))).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(windows.map((w) => w.idx)).toEqual([0, 1, 2]);
    expect(windows[0]).toMatchObject({ startMs: 1000, endMs: 300_000 });
  });

  it('returns nothing for no segments', () => {
    expect(splitWindows([])).toEqual([]);
  });
});

describe('renderWindow', () => {
  it('prefixes each line with its absolute video time', () => {
    const [w] = splitWindows([s(1000, 'a'), s(65_000, 'b')]);
    expect(renderWindow(w, 3_600_000)).toBe('[1:00:01] a\n[1:01:05] b');
  });
});
