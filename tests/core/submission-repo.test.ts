import { beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/db/sqlite';
import { migrate } from '../../src/core/db/schema';
import { Repo } from '../../src/core/db/repo';
import { SubmissionStore } from '../../src/core/db/submission-repo';

const options = { translate: true, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3' };
let db: Database;
let store: SubmissionStore;
let tick = 0;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  tick = 0;
  store = new SubmissionStore(db, () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}Z`);
});

describe('SubmissionStore', () => {
  it('creates queued submissions with options and reads them back', () => {
    const s = store.create({ source: 'https://y/1', startMs: 0, endMs: 60_000, options });
    expect(s).toMatchObject({ id: 1, state: 'queued', jobId: null, error: null, endMs: 60_000, options });
    expect(store.get(1)).toEqual(s);
    expect(store.get(99)).toBeUndefined();
  });

  it('serves the lowest queued id next and skips other states', () => {
    const a = store.create({ source: 'a', startMs: 0, endMs: null, options });
    const b = store.create({ source: 'b', startMs: 0, endMs: null, options });
    store.setState(a.id, 'running');
    expect(store.nextQueued()?.id).toBe(b.id);
    store.setState(b.id, 'done');
    expect(store.nextQueued()).toBeUndefined();
  });

  it('records errors, job links and updates the timestamp', () => {
    const jobId = new Repo(db).createJob({
      source: 'a',
      rangeStartMs: 0,
      rangeEndMs: 1,
      settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 },
    }).id;
    const s = store.create({ source: 'a', startMs: 0, endMs: null, options });
    store.setJob(s.id, jobId);
    store.setState(s.id, 'failed', 'DownloadFailed: nope');
    const after = store.get(s.id);
    expect(after).toMatchObject({ jobId, state: 'failed', error: 'DownloadFailed: nope' });
    expect((after?.updatedAt ?? '') > s.updatedAt).toBe(true);
    store.setState(s.id, 'queued', null);
    expect(store.get(s.id)?.error).toBeNull();
  });

  it('recovers running submissions as interrupted and returns how many', () => {
    const a = store.create({ source: 'a', startMs: 0, endMs: null, options });
    store.create({ source: 'b', startMs: 0, endMs: null, options });
    store.setState(a.id, 'running');
    expect(store.recoverInterrupted()).toBe(1);
    expect(store.list().map((s) => s.state)).toEqual(['interrupted', 'queued']);
  });
});
