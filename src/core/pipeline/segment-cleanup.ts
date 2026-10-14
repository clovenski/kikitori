import type { Segment } from '../types';

/** Keep only segments that start at or after the cutoff (earlier chunk wins on overlap). */
export function dropOverlapping(segments: Segment[], cutoffMs: number): Segment[] {
  return segments.filter((s) => s.startMs >= cutoffMs);
}

export interface FilterOptions {
  minAvgLogprob: number;
  maxConsecutiveRepeats: number;
}

/** Starting values; tune against real stream audio. */
export const FILTER_DEFAULTS: FilterOptions = {
  minAvgLogprob: -1.5,
  maxConsecutiveRepeats: 3,
};

const normalize = (text: string) => text.replace(/[\s、。,.!?！？…・]+/g, '').toLowerCase();

export function filterHallucinations(
  segments: Segment[],
  opts: FilterOptions = FILTER_DEFAULTS,
): Segment[] {
  const out: Segment[] = [];
  let run: Segment[] = [];

  const flush = () => {
    if (run.length <= opts.maxConsecutiveRepeats) out.push(...run);
    else out.push(run[0]);
    run = [];
  };

  for (const segment of segments) {
    const key = normalize(segment.text);
    if (key === '') continue;
    if (segment.avgLogprob != null && segment.avgLogprob < opts.minAvgLogprob) continue;
    if (run.length > 0 && normalize(run[0].text) === key) {
      run.push(segment);
    } else {
      flush();
      run = [segment];
    }
  }
  flush();
  return out;
}
