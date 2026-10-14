import { Database } from '../../src/core/db/sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../../src/core/db/repo';
import { migrate } from '../../src/core/db/schema';
import { StageRepo } from '../../src/core/db/stage-repo';
import type { Segment } from '../../src/core/types';

const seg = (text: string, startMs: number, endMs: number): Segment => ({ startMs, endMs, text, lang: 'ja' });
const settings = { model: 'large-v3', language: 'ja', maxMinutes: 30 };

let repo: Repo;
let stages: StageRepo;
let jobId: number;
beforeEach(() => {
  const db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  stages = new StageRepo(db);
  jobId = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 10_000, settings }).id;
  repo.insertChunks(jobId, [
    { idx: 0, startMs: 0, endMs: 5000 },
    { idx: 1, startMs: 4000, endMs: 10_000 },
  ]);
});

describe('glossary', () => {
  it('auto entries never overwrite; user entries always win', () => {
    stages.upsertGlossary(jobId, [{ ja: 'ゆりまる', en: 'Yurimaru', source: 'auto' }]);
    stages.upsertGlossary(jobId, [{ ja: 'ゆりまる', en: 'Yuri-maru', source: 'auto' }]);
    expect(stages.listGlossary(jobId)).toEqual([{ ja: 'ゆりまる', en: 'Yurimaru', source: 'auto' }]);
    stages.upsertGlossary(jobId, [{ ja: 'ゆりまる', en: 'Yurimaru-chan', source: 'user' }]);
    stages.upsertGlossary(jobId, [{ ja: 'ゆりまる', en: 'again', source: 'auto' }]);
    expect(stages.listGlossary(jobId)).toEqual([{ ja: 'ゆりまる', en: 'Yurimaru-chan', source: 'user' }]);
  });
});

describe('translations', () => {
  it('saves, replaces and lists by segment id', () => {
    repo.completeChunk(jobId, 0, [seg('a', 0, 1000), seg('b', 1000, 2000)]);
    const [a, b] = repo.listSegmentsWithId(jobId);
    stages.saveTranslations(jobId, 0, [{ segmentId: a.id, text: 'A' }, { segmentId: b.id, text: 'B' }]);
    stages.saveTranslations(jobId, 1, [{ segmentId: b.id, text: 'B2' }]);
    expect(stages.listTranslations(jobId)).toEqual(new Map([[a.id, 'A'], [b.id, 'B2']]));
  });

  it('are dropped when their chunk is re-transcribed', () => {
    repo.completeChunk(jobId, 0, [seg('a', 0, 1000)]);
    const [a] = repo.listSegmentsWithId(jobId);
    stages.saveTranslations(jobId, 0, [{ segmentId: a.id, text: 'A' }]);
    repo.completeChunk(jobId, 0, [seg('a2', 0, 1000)]);
    expect(stages.listTranslations(jobId).size).toBe(0);
  });

  it('are dropped for later-chunk segments trimmed as overlap by an earlier chunk', () => {
    repo.completeChunk(jobId, 1, [seg('dup', 4200, 4800), seg('keep', 6000, 7000)]);
    const [dup, keep] = repo.listSegmentsWithId(jobId);
    stages.saveTranslations(jobId, 0, [
      { segmentId: dup.id, text: 'DUP' },
      { segmentId: keep.id, text: 'KEEP' },
    ]);
    repo.completeChunk(jobId, 0, [seg('first', 0, 5000)]);
    expect(repo.listSegments(jobId).map((s) => s.text)).toEqual(['first', 'keep']);
    expect([...stages.listTranslations(jobId).values()]).toEqual(['KEEP']);
  });
});

describe('summaries and stages', () => {
  it('lists summaries ordered by level then index and replaces on re-save', () => {
    stages.saveSummary(jobId, { level: 'overview', idx: 0, startMs: 0, endMs: 9, text: 'O' });
    stages.saveSummary(jobId, { level: 'window', idx: 1, startMs: 5, endMs: 9, text: 'W1' });
    stages.saveSummary(jobId, { level: 'window', idx: 0, startMs: 0, endMs: 5, text: 'W0' });
    stages.saveSummary(jobId, { level: 'window', idx: 0, startMs: 0, endMs: 5, text: 'W0b' });
    expect(stages.listSummaries(jobId).map((s) => s.text)).toEqual(['W0b', 'W1', 'O']);
    expect(stages.listSummaries(jobId, 'overview')).toHaveLength(1);
  });

  it('tracks stage status', () => {
    expect(stages.getStage(jobId, 'translate')).toBeUndefined();
    stages.setStage(jobId, 'translate', 'running');
    stages.setStage(jobId, 'translate', 'done');
    expect(stages.getStage(jobId, 'translate')).toBe('done');
  });
});
