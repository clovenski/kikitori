import { describe, expect, it } from 'vitest';
import { createHandlers } from '../../src/app/main/handlers';
import { JobQueue } from '../../src/app/main/queue';
import { SubmissionStore } from '../../src/core/db/submission-repo';
import { BgtError } from '../../src/core/errors';
import { Database } from '../../src/core/db/sqlite';
import { migrate } from '../../src/core/db/schema';
import { memoryRepos, seedJob } from '../helpers/fakes';

function setup(over: { speed?: number | null; probe?: () => Promise<{ title: string | null; durationMs: number }> } = {}) {
  const { repo, stages } = memoryRepos();
  const db = new Database(':memory:');
  migrate(db);
  const store = new SubmissionStore(db);
  const queue = new JobQueue({ store, run: async () => {}, emitChanged: () => {}, emitProgress: () => {} });
  const opened: string[] = [];
  const handlers = createHandlers({
    repo,
    stages,
    queue,
    probe: over.probe ?? (async () => ({ title: 'T', durationMs: 600_000 })),
    speedFactor: () => (over.speed === undefined ? 10 : over.speed),
    pickFile: async (kind) => (kind === 'media' ? 'C:/a.wav' : null),
    openFolder: async (dir) => {
      opened.push(dir);
    },
    outDir: 'C:/out',
  });
  return { handlers, repo, stages, queue, opened };
}

const options = { translate: false, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3' };

describe('handlers', () => {
  it('library:list and job:get wrap the library service', async () => {
    const t = setup();
    const job = seedJob(t.repo, ['あ']);
    const list = await t.handlers['library:list']();
    expect(list).toMatchObject({ ok: true, value: [{ jobId: job.id }] });
    const detail = await t.handlers['job:get'](job.id);
    expect(detail).toMatchObject({ ok: true, value: { item: { jobId: job.id } } });
    expect(await t.handlers['job:get'](999)).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['job:get']('x')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
  });

  it('queue:submit validates, queues and returns the submission', async () => {
    const t = setup();
    const ok = await t.handlers['queue:submit']({ source: 'C:/a.wav', startMs: 0, endMs: null, options });
    expect(ok).toMatchObject({ ok: true, value: { id: 1, source: 'C:/a.wav' } });
    const bad = await t.handlers['queue:submit']({ source: '', startMs: 0, endMs: null, options });
    expect(bad).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(t.queue.list()).toHaveLength(1);
  });

  it('queue:cancel and queue:resume validate ids', async () => {
    const t = setup();
    expect(await t.handlers['queue:cancel'](0)).toMatchObject({ ok: false });
    expect(await t.handlers['queue:resume'](1)).toEqual({ ok: true, value: null });
  });

  it('source:probe returns the probe result or a typed error', async () => {
    const good = setup();
    expect(await good.handlers['source:probe']('https://x')).toEqual({ ok: true, value: { title: 'T', durationMs: 600_000 } });
    const failing = setup({
      probe: async () => {
        throw new BgtError('DownloadFailed', 'blocked');
      },
    });
    expect(await failing.handlers['source:probe']('https://x')).toEqual({
      ok: false,
      error: { code: 'DownloadFailed', message: 'blocked' },
    });
    expect(await good.handlers['source:probe']('  ')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
  });

  it('source:estimate divides the range by the measured speed, or answers null', async () => {
    const t = setup({ speed: 10 });
    expect(await t.handlers['source:estimate']({ durationMs: 600_000, startMs: 0, endMs: null })).toEqual({ ok: true, value: 60 });
    expect(await t.handlers['source:estimate']({ durationMs: 600_000, startMs: 300_000, endMs: 600_000 })).toEqual({ ok: true, value: 30 });
    const unknown = setup({ speed: null });
    expect(await unknown.handlers['source:estimate']({ durationMs: 600_000, startMs: 0, endMs: null })).toEqual({ ok: true, value: null });
  });

  it('dialogs and open-folder delegate to the injected functions', async () => {
    const t = setup();
    expect(await t.handlers['dialog:pickMedia']()).toEqual({ ok: true, value: 'C:/a.wav' });
    expect(await t.handlers['dialog:pickGlossary']()).toEqual({ ok: true, value: null });
    seedJob(t.repo, ['あ']);
    expect(await t.handlers['job:openOutputFolder'](1)).toEqual({ ok: true, value: null });
    expect(t.opened).toEqual(['C:/out']);
  });
});
