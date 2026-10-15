import { beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../../src/core/db/repo';
import { migrate } from '../../src/core/db/schema';
import { Database } from '../../src/core/db/sqlite';
import { SubmissionStore, type Submission } from '../../src/core/db/submission-repo';
import { BgtError } from '../../src/core/errors';
import { JobQueue, type RunContext } from '../../src/app/main/queue';

const options = { translate: false, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3' };
const req = (source: string) => ({ source, startMs: 0, endMs: null, options });

interface Harness {
  db: Database;
  store: SubmissionStore;
  queue: JobQueue;
  started: string[];
  progress: { submissionId: number; stage: string }[];
  changed: number;
  /** resolve/reject the currently running submission's `run` */
  finish: (source: string, err?: unknown) => void;
  contexts: Map<string, RunContext>;
}

function harness(): Harness {
  const db = new Database(':memory:');
  migrate(db);
  const store = new SubmissionStore(db);
  const pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
  const contexts = new Map<string, RunContext>();
  const h = { started: [] as string[], progress: [] as { submissionId: number; stage: string }[], changed: 0 } as Harness;
  const queue = new JobQueue({
    store,
    run: (sub: Submission, ctx: RunContext) =>
      new Promise<void>((resolve, reject) => {
        h.started.push(sub.source);
        contexts.set(sub.source, ctx);
        pending.set(sub.source, { resolve, reject });
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason ?? new Error('aborted')));
      }),
    emitChanged: () => {
      h.changed++;
    },
    emitProgress: (p) => h.progress.push({ submissionId: p.submissionId, stage: p.event.stage }),
  });
  h.db = db;
  h.store = store;
  h.queue = queue;
  h.contexts = contexts;
  h.finish = (source, err) => (err ? pending.get(source)?.reject(err) : pending.get(source)?.resolve());
  return h;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('JobQueue', () => {
  it('runs one submission at a time, in order', async () => {
    h.queue.submit(req('a'));
    h.queue.submit(req('b'));
    await tick();
    expect(h.started).toEqual(['a']);
    h.finish('a');
    await tick();
    expect(h.started).toEqual(['a', 'b']);
    h.finish('b');
    await h.queue.whenIdle();
    expect(h.queue.list().map((s) => s.state)).toEqual(['done', 'done']);
  });

  it('records a BgtError as "code: message" and moves on to the next submission', async () => {
    h.queue.submit(req('a'));
    h.queue.submit(req('b'));
    await tick();
    h.finish('a', new BgtError('DownloadFailed', 'nope'));
    await tick();
    expect(h.queue.list()[0]).toMatchObject({ state: 'failed', error: 'DownloadFailed: nope' });
    expect(h.started).toEqual(['a', 'b']);
  });

  it('records a plain error message', async () => {
    h.queue.submit(req('a'));
    await tick();
    h.finish('a', new Error('kaput'));
    await h.queue.whenIdle();
    expect(h.queue.list()[0]).toMatchObject({ state: 'failed', error: 'kaput' });
  });

  it('cancels the running submission, aborting its signal, then starts the next', async () => {
    const a = h.queue.submit(req('a'));
    h.queue.submit(req('b'));
    await tick();
    h.queue.cancel(a.id);
    await tick();
    expect(h.contexts.get('a')?.signal.aborted).toBe(true);
    expect(h.queue.list()[0].state).toBe('cancelled');
    expect(h.started).toEqual(['a', 'b']);
  });

  it('cancels a queued submission without ever running it', async () => {
    h.queue.submit(req('a'));
    const b = h.queue.submit(req('b'));
    await tick();
    h.queue.cancel(b.id);
    h.finish('a');
    await h.queue.whenIdle();
    expect(h.started).toEqual(['a']);
    expect(h.queue.list()[1].state).toBe('cancelled');
  });

  it('resume re-queues failed, cancelled and interrupted submissions only', async () => {
    const a = h.queue.submit(req('a'));
    await tick();
    h.finish('a', new Error('x'));
    await h.queue.whenIdle();
    h.queue.resume(a.id);
    await tick();
    expect(h.started).toEqual(['a', 'a']);
    expect(h.queue.list()[0]).toMatchObject({ state: 'running', error: null });
    h.queue.resume(a.id); // running: ignored
    expect(h.started).toEqual(['a', 'a']);
    h.finish('a');
    await h.queue.whenIdle();
    h.queue.resume(a.id); // done: ignored
    await tick();
    expect(h.started).toEqual(['a', 'a']);
  });

  it('start() turns leftover running submissions into interrupted and does not run them', async () => {
    const a = h.store.create(req('a'));
    h.store.setState(a.id, 'running');
    const queued = h.store.create(req('b'));
    h.queue.start();
    await tick();
    expect(h.store.get(a.id)?.state).toBe('interrupted');
    expect(h.started).toEqual(['b']);
    expect(h.store.get(queued.id)?.state).toBe('running');
  });

  it('shutdown aborts the running job, marks it interrupted and starts nothing else', async () => {
    const a = h.queue.submit(req('a'));
    h.queue.submit(req('b'));
    await tick();
    await h.queue.shutdown();
    expect(h.contexts.get('a')?.signal.aborted).toBe(true);
    expect(h.store.get(a.id)?.state).toBe('interrupted');
    expect(h.started).toEqual(['a']);
    h.queue.submit(req('c'));
    await tick();
    expect(h.started).toEqual(['a']);
  });

  it('links the job and forwards progress with the submission id', async () => {
    const a = h.queue.submit(req('a'));
    await tick();
    const ctx = h.contexts.get('a') as RunContext;
    const jobId = new Repo(h.db).createJob({
      source: 'a',
      rangeStartMs: 0,
      rangeEndMs: 1,
      settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 },
    }).id;
    ctx.onJob(jobId);
    ctx.progress({ stage: 'transcribe', done: 1, total: 3, message: 'x' });
    expect(h.store.get(a.id)?.jobId).toBe(jobId);
    expect(h.progress).toEqual([{ submissionId: a.id, stage: 'transcribe' }]);
    h.finish('a');
    await h.queue.whenIdle();
  });
});

describe('removeJob', () => {
  it('drops the submissions linked to a job and announces the change', () => {
    const h = harness();
    const repo = new Repo(h.db);
    const job = repo.createJob({ source: 'a', rangeStartMs: 0, rangeEndMs: 1, settings: { model: 'm', language: 'ja', maxMinutes: 30 } });
    const sub = h.store.create(req('a'));
    h.store.setJob(sub.id, job.id);
    h.store.setState(sub.id, 'failed', 'x');
    const before = h.changed;
    h.queue.removeJob(job.id);
    expect(h.store.get(sub.id)).toBeUndefined();
    expect(h.changed).toBeGreaterThan(before);
  });

  it('refuses while the job is being processed', () => {
    const h = harness();
    const repo = new Repo(h.db);
    const job = repo.createJob({ source: 'a', rangeStartMs: 0, rangeEndMs: 1, settings: { model: 'm', language: 'ja', maxMinutes: 30 } });
    const sub = h.store.create(req('a'));
    h.store.setJob(sub.id, job.id);
    h.store.setState(sub.id, 'running');
    expect(() => h.queue.removeJob(job.id)).toThrow(BgtError);
    expect(h.store.get(sub.id)).toBeDefined();
  });
});
