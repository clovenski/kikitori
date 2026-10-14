export type SubtitleMode = 'en' | 'ja' | 'both';

/**
 * Index of the line active at `timeMs` (start inclusive, end exclusive), or -1.
 * `lines` must be sorted by start time. With equal starts the later line wins.
 */
export function findActiveIndex(lines: { startMs: number; endMs: number }[], timeMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= timeMs) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Walk back over overlapping lines that started earlier but are still on screen.
  for (let i = candidate; i >= 0; i--) {
    if (timeMs < lines[i].endMs) return i;
    if (candidate - i > 8) break;
  }
  return -1;
}

export function subtitleText(line: { ja: string; en: string | null }, mode: SubtitleMode): string[] {
  if (mode === 'ja') return [line.ja];
  if (mode === 'en') return [line.en ?? line.ja];
  return line.en ? [line.en, line.ja] : [line.ja];
}
