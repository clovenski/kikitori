import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/core/db/schema';
import { Repo } from '../../src/core/db/repo';
import type { Segment } from '../../src/core/types';

const settings = { model: 'large-v3', language: 'ja', maxMinutes: 30 };
const seg = (text: string, startMs: number, endMs: number): Segment => ({
  startMs,
  endMs,
  text,
  lang: 'ja',
  avgLogprob: -0.4,
});

let db: Database.Database;
let repo: Repo;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
});

describe('migrate', () => {
  it('is idempotent and sets user_version', () => {
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
  });
});

describe('jobs', () => {
  it('creates and reads back a job', () => {
    const job = repo.createJob({ source: 'https://y/1', rangeStartMs: 0, rangeEndMs: 1000, settings });
    expect(job).toMatchObject({ source: 'https://y/1', rangeEndMs: 1000, status: 'pending', settings });
    expect(repo.getJob(job.id)).toEqual(job);
  });

  it('finds an unfinished job with the same source, range and model only', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    expect(repo.findResumableJob('s', 0, 1000, 'large-v3')?.id).toBe(job.id);
    expect(repo.findResumableJob('s', 0, 1000, 'small')).toBeUndefined();
    expect(repo.findResumableJob('s', 0, 2000, 'large-v3')).toBeUndefined();
    repo.setJobStatus(job.id, 'done');
    expect(repo.findResumableJob('s', 0, 1000, 'large-v3')).toBeUndefined();
  });
});

describe('chunks', () => {
  it('inserts, lists in order, and tracks attempts', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [
      { idx: 1, startMs: 500, endMs: 1000 },
      { idx: 0, startMs: 0, endMs: 500 },
    ]);
    expect(repo.listChunks(job.id).map((c) => c.idx)).toEqual([0, 1]);
    repo.markChunkRunning(job.id, 0);
    repo.markChunkRunning(job.id, 0);
    expect(repo.listChunks(job.id)[0]).toMatchObject({ status: 'running', attempts: 2 });
  });

  it('resetUnfinishedChunks: running -> pending (keeps attempts), failed -> pending (resets)', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [
      { idx: 0, startMs: 0, endMs: 100 },
      { idx: 1, startMs: 100, endMs: 200 },
      { idx: 2, startMs: 200, endMs: 300 },
    ]);
    repo.markChunkRunning(job.id, 0);
    repo.markChunkRunning(job.id, 1);
    repo.markChunkFailed(job.id, 1, 'boom');
    repo.completeChunk(job.id, 2, []);
    repo.resetUnfinishedChunks(job.id);
    const chunks = repo.listChunks(job.id);
    expect(chunks[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(chunks[1]).toMatchObject({ status: 'pending', attempts: 0, error: null });
    expect(chunks[2].status).toBe('done');
  });
});

describe('segments', () => {
  it('listSegmentsWithId returns ids in time order', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [{ idx: 0, startMs: 0, endMs: 1000 }]);
    repo.completeChunk(job.id, 0, [seg('b', 500, 600), seg('a', 100, 200)]);
    const rows = repo.listSegmentsWithId(job.id);
    expect(rows.map((r) => r.text)).toEqual(['a', 'b']);
    expect(rows.every((r) => Number.isInteger(r.id))).toBe(true);
  });

  it('completeChunk stores segments and marks the chunk done', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [{ idx: 0, startMs: 0, endMs: 1000 }]);
    repo.completeChunk(job.id, 0, [seg('b', 500, 600), seg('a', 100, 200)]);
    expect(repo.listChunks(job.id)[0].status).toBe('done');
    expect(repo.listSegments(job.id).map((s) => s.text)).toEqual(['a', 'b']);
    expect(repo.listSegments(job.id)[0]).toMatchObject({ lang: 'ja', avgLogprob: -0.4 });
  });

  it('completeChunk replaces earlier segments of the same chunk (no duplicates after a retry)', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [{ idx: 0, startMs: 0, endMs: 1000 }]);
    repo.completeChunk(job.id, 0, [seg('old', 0, 100)]);
    repo.completeChunk(job.id, 0, [seg('new', 0, 100)]);
    expect(repo.listSegments(job.id).map((s) => s.text)).toEqual(['new']);
  });

  it('maxSegmentEndBefore only considers earlier chunks', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [
      { idx: 0, startMs: 0, endMs: 500 },
      { idx: 1, startMs: 500, endMs: 1000 },
      { idx: 2, startMs: 1000, endMs: 1500 },
    ]);
    repo.completeChunk(job.id, 0, [seg('a', 0, 400)]);
    repo.completeChunk(job.id, 2, [seg('c', 1100, 1400)]);
    expect(repo.maxSegmentEndBefore(job.id, 0)).toBeNull();
    expect(repo.maxSegmentEndBefore(job.id, 1)).toBe(400);
    expect(repo.maxSegmentEndBefore(job.id, 2)).toBe(400);
  });
});
