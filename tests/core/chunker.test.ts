import { describe, expect, it } from 'vitest';
import { planChunks, type ChunkPlanOptions } from '../../src/core/pipeline/chunker';

const opts: ChunkPlanOptions = {
  targetMs: 900_000,
  overlapMs: 2_000,
  searchMs: 180_000,
  minTailMs: 180_000,
};

describe('planChunks', () => {
  it('returns a single chunk for short audio', () => {
    expect(planChunks(600_000, [], opts)).toEqual([{ idx: 0, startMs: 0, endMs: 600_000 }]);
  });

  it('does not leave a tiny final chunk', () => {
    // 17 min: remaining after 15 min would be 2 min < minTail, so no split
    expect(planChunks(1_020_000, [], opts)).toHaveLength(1);
  });

  it('cuts at the midpoint of the silence nearest the target', () => {
    const chunks = planChunks(1_800_000, [{ startMs: 870_000, endMs: 880_000 }], opts);
    expect(chunks).toEqual([
      { idx: 0, startMs: 0, endMs: 875_000 },
      { idx: 1, startMs: 873_000, endMs: 1_800_000 },
    ]);
  });

  it('prefers the closest of several silences', () => {
    const chunks = planChunks(
      1_800_000,
      [
        { startMs: 780_000, endMs: 790_000 }, // 115s from target
        { startMs: 895_000, endMs: 905_000 }, // 0s from target
      ],
      opts,
    );
    expect(chunks[0]).toEqual({ idx: 0, startMs: 0, endMs: 900_000 });
  });

  it('ignores silences outside the search window and cuts at the target', () => {
    const chunks = planChunks(1_800_000, [{ startMs: 100_000, endMs: 110_000 }], opts);
    expect(chunks[0].endMs).toBe(900_000);
    expect(chunks[1].startMs).toBe(898_000);
  });

  it('plans several chunks for long audio and covers the whole range', () => {
    const chunks = planChunks(2_400_000, [{ startMs: 870_000, endMs: 880_000 }], opts);
    expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 875_000],
      [873_000, 1_775_000],
      [1_773_000, 2_400_000],
    ]);
  });

  it('never starts a later chunk before zero', () => {
    const chunks = planChunks(1_800_000, [], { ...opts, overlapMs: 5_000_000, targetMs: 900_000 });
    expect(chunks[1].startMs).toBe(0);
  });

  it('rejects an impossible search window', () => {
    expect(() => planChunks(1_000, [], { ...opts, searchMs: 900_000 })).toThrow(/searchMs/);
  });
});
