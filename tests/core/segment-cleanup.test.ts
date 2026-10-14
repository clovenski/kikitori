import { describe, expect, it } from 'vitest';
import { dropOverlapping, filterHallucinations } from '../../src/core/pipeline/segment-cleanup';
import type { Segment } from '../../src/core/types';

const seg = (text: string, startMs = 0, avgLogprob: number | null = -0.3): Segment => ({
  startMs,
  endMs: startMs + 1000,
  text,
  lang: 'ja',
  avgLogprob,
});

describe('dropOverlapping', () => {
  it('drops segments that start before the cutoff', () => {
    const kept = dropOverlapping([seg('a', 0), seg('b', 500), seg('c', 1000)], 1000);
    expect(kept.map((s) => s.text)).toEqual(['c']);
  });
});

describe('filterHallucinations', () => {
  it('drops empty and whitespace-only text', () => {
    expect(filterHallucinations([seg('  '), seg('はい')]).map((s) => s.text)).toEqual(['はい']);
  });

  it('drops very low confidence segments but keeps unknown confidence', () => {
    const out = filterHallucinations([seg('bad', 0, -2.2), seg('unknown', 1000, null), seg('ok', 2000)]);
    expect(out.map((s) => s.text)).toEqual(['unknown', 'ok']);
  });

  it('collapses a run longer than the limit to its first segment', () => {
    const run = [0, 1, 2, 3].map((i) => seg('ご視聴ありがとうございました', i * 1000));
    expect(filterHallucinations(run)).toHaveLength(1);
  });

  it('keeps a run at the limit', () => {
    const run = [0, 1, 2].map((i) => seg('はい', i * 1000));
    expect(filterHallucinations(run)).toHaveLength(3);
  });

  it('does not treat non-consecutive repeats as a run', () => {
    const input = [seg('はい', 0), seg('えっと', 1000), seg('はい', 2000), seg('えっと', 3000)];
    expect(filterHallucinations(input)).toHaveLength(4);
  });

  it('ignores punctuation differences when detecting repeats', () => {
    const run = ['はい。', 'はい', 'はい、', 'はい!'].map((t, i) => seg(t, i * 1000));
    expect(filterHallucinations(run)).toHaveLength(1);
  });
});
