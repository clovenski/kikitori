import { BgtError } from '../errors';

export interface SilenceInterval {
  startMs: number;
  endMs: number;
}

export interface PlannedChunk {
  idx: number;
  startMs: number;
  endMs: number;
}

export interface ChunkPlanOptions {
  targetMs: number;
  overlapMs: number;
  searchMs: number;
  minTailMs: number;
}

export const CHUNK_DEFAULTS: ChunkPlanOptions = {
  targetMs: 15 * 60_000,
  overlapMs: 2_000,
  searchMs: 3 * 60_000,
  minTailMs: 3 * 60_000,
};

export function planChunks(
  totalMs: number,
  silences: SilenceInterval[],
  opts: ChunkPlanOptions = CHUNK_DEFAULTS,
): PlannedChunk[] {
  if (opts.searchMs >= opts.targetMs) {
    throw new BgtError('InvalidInput', 'searchMs must be smaller than targetMs');
  }

  const boundaries = [0];
  let cursor = 0;
  while (totalMs - cursor > opts.targetMs + opts.minTailMs) {
    const ideal = cursor + opts.targetMs;
    let cut = ideal;
    let bestDistance = Infinity;
    for (const silence of silences) {
      const mid = Math.round((silence.startMs + silence.endMs) / 2);
      const distance = Math.abs(mid - ideal);
      if (distance <= opts.searchMs && distance < bestDistance) {
        cut = mid;
        bestDistance = distance;
      }
    }
    boundaries.push(cut);
    cursor = cut;
  }
  boundaries.push(totalMs);

  return boundaries.slice(0, -1).map((boundary, idx) => ({
    idx,
    startMs: idx === 0 ? 0 : Math.max(0, boundary - opts.overlapMs),
    endMs: boundaries[idx + 1],
  }));
}
