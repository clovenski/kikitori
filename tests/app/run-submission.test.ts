import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSubmission, type RunSubmissionEnv } from '../../src/app/main/run-submission';
import type { RunContext } from '../../src/app/main/queue';
import type { Submission } from '../../src/core/db/submission-repo';
import type { LlmChat } from '../../src/core/llm/client';
import type { ModelPool, ModelRole } from '../../src/core/pipeline/stages';
import type { Segment } from '../../src/core/types';
import { echoTranslate, scriptedChat } from '../helpers/llm-fakes';
import { makeFakeDeps, memoryRepos, seedJob } from '../helpers/fakes';

const seg = (text: string, startMs: number, endMs: number): Segment => ({ startMs, endMs, text, lang: 'ja', avgLogprob: -0.3 });

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-runsub-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakePool(chats: Record<ModelRole, LlmChat>) {
  const used: ModelRole[] = [];
  const pool: ModelPool & { used: ModelRole[]; stopped: number } = {
    used,
    stopped: 0,
    async use(role) {
      used.push(role);
      return chats[role];
    },
    async stopAll() {
      pool.stopped++;
    },
  };
  return pool;
}

const generalAnswer = (m: { content: string }[]) => {
  const c = m[m.length - 1].content;
  if (c.includes('JSON array')) return '[]';
  if (c.includes('overview in English')) return 'Overview';
  return '- [0:00:00] Something';
};

function setup(over: { truth?: Segment[]; onTranscribe?: (f: string) => void } = {}) {
  const { repo, stages } = memoryRepos();
  const fakes = makeFakeDeps(repo, {
    durationMs: 600_000,
    truth: over.truth ?? [seg('あ', 1000, 2000), seg('い', 3000, 4000)],
    onTranscribe: over.onTranscribe,
  });
  const translate = scriptedChat(echoTranslate());
  const pool = fakePool({ general: scriptedChat(generalAnswer), translate });
  const env: RunSubmissionEnv = {
    repo,
    stages,
    makeDeps: () => fakes.deps,
    workRoot: path.join(root, 'work'),
    outDir: () => path.join(root, 'out'),
    defaultOutDir: path.join(root, 'default'),
    pool,
    log: () => {},
  };
  const events: string[] = [];
  const jobs: number[] = [];
  const ctx: RunContext = {
    signal: new AbortController().signal,
    progress: (e) => events.push(e.stage),
    onJob: (id) => jobs.push(id),
  };
  return { env, ctx, repo, stages, pool, translate, events, jobs, fakes };
}

const sub = (options: Partial<Submission['options']> = {}): Submission => ({
  id: 1,
  source: '/tmp/clip.wav',
  startMs: 0,
  endMs: null,
  options: { translate: false, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3', ...options },
  state: 'running',
  jobId: null,
  error: null,
  createdAt: '',
  updatedAt: '',
});

describe('runSubmission', () => {
  it('transcribes only when no LLM option is set, reporting the job and progress, without using models', async () => {
    const t = setup();
    await runSubmission(t.env, sub(), t.ctx);
    expect(t.jobs).toEqual([1]);
    expect(t.events).toContain('fetch');
    expect(t.events).toContain('transcribe');
    expect(t.pool.used).toEqual([]);
    expect(t.repo.listSegments(1).map((s) => s.text)).toEqual(['あ', 'い']);
  });

  it('runs translate and summarize stages and always stops the model pool', async () => {
    const t = setup();
    await runSubmission(t.env, sub({ translate: true, summarize: true }), t.ctx);
    expect(t.pool.used).toEqual(['general', 'translate', 'general']);
    expect(t.pool.stopped).toBe(1);
    expect(t.stages.getStage(1, 'translate')).toBe('done');
    expect(t.stages.getStage(1, 'summarize')).toBe('done');
    expect(t.events).toEqual(expect.arrayContaining(['glossary', 'translate', 'summarize']));
  });

  it('skips the automatic name list when the summaries model is not installed', async () => {
    const t = setup();
    t.env.autoGlossary = () => false;
    await runSubmission(t.env, sub({ translate: true }), t.ctx);
    expect(t.pool.used).toEqual(['translate']);
    expect(t.stages.getStage(1, 'translate')).toBe('done');
  });

  it('skim summarizes without translating', async () => {
    const t = setup();
    await runSubmission(t.env, sub({ skim: true }), t.ctx);
    expect(t.pool.used).toEqual(['general', 'general']);
    expect(t.stages.getStage(1, 'translate')).toBeUndefined();
    expect(t.stages.getStage(1, 'summarize')).toBe('done');
  });

  it('fails with TranscribeFailed when a chunk fails and skips the LLM stages', async () => {
    const t = setup({
      onTranscribe: () => {
        throw new Error('whisper crashed');
      },
    });
    await expect(runSubmission(t.env, sub({ translate: true }), t.ctx)).rejects.toMatchObject({ code: 'TranscribeFailed' });
    expect(t.pool.used).toEqual([]);
  });

  it('loads the glossary file before doing any work and rejects a bad one', async () => {
    const t = setup();
    const file = path.join(root, 'g.json');
    writeFileSync(file, '{oops');
    await expect(runSubmission(t.env, sub({ translate: true, glossaryPath: file }), t.ctx)).rejects.toMatchObject({
      code: 'InvalidInput',
    });
    expect(t.jobs).toEqual([]);
  });

  it('continues an already transcribed job instead of transcribing it again', async () => {
    const t = setup();
    await runSubmission(t.env, sub(), t.ctx); // transcription only: job 1 is done
    expect(t.fakes.fetchCalls).toHaveLength(1);

    t.jobs.length = 0;
    await runSubmission(t.env, { ...sub({ translate: true, summarize: true }), jobId: 1 }, t.ctx);
    expect(t.fakes.fetchCalls).toHaveLength(1); // no second download
    expect(t.fakes.transcribed).toEqual(['chunk-000.wav']); // no second transcription
    expect(t.repo.listJobs()).toHaveLength(1); // no second job
    expect(t.jobs).toEqual([1]); // the queue is told which job this is
    expect(t.stages.getStage(1, 'translate')).toBe('done');
    expect(t.stages.getStage(1, 'summarize')).toBe('done');
  });

  it('writes into the current output folder and records it on the job', async () => {
    const t = setup();
    await runSubmission(t.env, sub(), t.ctx);
    expect(t.repo.getJob(1)?.outDir).toBe(path.join(root, 'out'));
    expect(existsSync(path.join(root, 'out', 'job-1.ja.srt'))).toBe(true);
  });

  it('keeps writing a job into the folder it started in, even after the output folder setting changed', async () => {
    const t = setup();
    await runSubmission(t.env, sub(), t.ctx);
    t.env.outDir = () => path.join(root, 'moved');
    await runSubmission(t.env, { ...sub({ translate: true }), jobId: 1 }, t.ctx);
    expect(existsSync(path.join(root, 'out', 'job-1.en.srt'))).toBe(true);
    expect(existsSync(path.join(root, 'moved'))).toBe(false);
  });

  it('a finished job from before folders were recorded continues in the default folder where its files are', async () => {
    const t = setup();
    const old = seedJob(t.repo, ['あ']); // done, with no recorded folder: what an older database looks like
    t.env.outDir = () => path.join(root, 'moved');
    await runSubmission(t.env, { ...sub({ translate: true }), jobId: old.id }, t.ctx);
    expect(existsSync(path.join(root, 'default', 'job-1.en.srt'))).toBe(true);
  });

  it('still transcribes when the linked job is not finished', async () => {
    const t = setup();
    t.repo.createJob({
      source: '/tmp/clip.wav',
      rangeStartMs: 0,
      rangeEndMs: 600_000,
      settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 },
    }); // pending, never finished
    await runSubmission(t.env, { ...sub(), jobId: 1 }, t.ctx);
    expect(t.fakes.fetchCalls).toHaveLength(1);
    expect(t.repo.getJob(1)?.status).toBe('done');
    expect(t.repo.listJobs()).toHaveLength(1); // resumed the same job, did not create another
  });

  it('passes a user glossary into the translation prompt', async () => {
    const t = setup({ truth: [seg('ゆりまるです', 1000, 2000)] });
    const file = path.join(root, 'g.json');
    writeFileSync(file, '{"ゆりまる":"Yurimaru"}');
    await runSubmission(t.env, sub({ translate: true, glossaryPath: file }), t.ctx);
    expect(t.translate.calls[0][0].content).toContain('ゆりまる translates to Yurimaru');
  });
});
