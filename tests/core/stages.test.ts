import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmChat } from '../../src/core/llm/client';
import { runLlmStages, type ModelPool, type ModelRole } from '../../src/core/pipeline/stages';
import { echoTranslate, scriptedChat } from '../helpers/llm-fakes';
import { memoryRepos, seedJob } from '../helpers/fakes';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-stages-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Fake model pool that mirrors the real pool's start/stop behaviour. */
function fakePool(chats: Record<ModelRole, LlmChat>) {
  const started: ModelRole[] = [];
  const pool: ModelPool & { started: ModelRole[]; stopped: number; uses: ModelRole[] } = {
    started,
    stopped: 0,
    uses: [],
    async use(role) {
      pool.uses.push(role);
      if (started[started.length - 1] !== role) started.push(role);
      return chats[role];
    },
    async stopAll() {
      pool.stopped++;
    },
  };
  return pool;
}

const generalAnswer = (messages: { content: string }[]) => {
  const content = messages[messages.length - 1].content;
  if (content.includes('JSON array')) return '[{"ja":"あ","en":"Ah"}]';
  if (content.includes('overview in English')) return 'Overview text';
  return '- [0:00:00] Something happens';
};

const opts = { translate: false, summarize: false, skim: false, userGlossary: {} };

describe('runLlmStages', () => {
  it('runs glossary, translate, summarize in order, swapping models between them', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い', 'う']);
    const translate = scriptedChat(echoTranslate());
    const pool = fakePool({ general: scriptedChat(generalAnswer), translate });
    const written = await runLlmStages(
      { repo, stages, job, outDir: dir, pool, log: () => {} },
      { ...opts, translate: true, summarize: true },
    );
    expect(pool.started).toEqual(['general', 'translate', 'general']);
    expect(pool.stopped).toBe(1);
    expect(written.map((p) => path.basename(p)).sort()).toEqual([
      `job-${job.id}.bi.srt`,
      `job-${job.id}.en.srt`,
      `job-${job.id}.summary.md`,
    ]);
    expect(stages.listGlossary(job.id)).toEqual([{ ja: 'あ', en: 'Ah', source: 'auto' }]);
    expect(translate.calls[0][0].content).toContain('あ translates to Ah');
    for (const stage of ['glossary', 'translate', 'summarize'] as const) {
      expect(stages.getStage(job.id, stage)).toBe('done');
    }
  });

  it('skim mode runs glossary and summarize on the general model only, with no translation', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い']);
    const translate = scriptedChat(echoTranslate());
    const pool = fakePool({ general: scriptedChat(generalAnswer), translate });
    const written = await runLlmStages({ repo, stages, job, outDir: dir, pool, log: () => {} }, { ...opts, skim: true });
    expect(pool.started).toEqual(['general']);
    expect(translate.calls).toHaveLength(0);
    expect(stages.getStage(job.id, 'translate')).toBeUndefined();
    expect(written.map((p) => path.basename(p))).toEqual([`job-${job.id}.summary.md`]);
  });

  it('does nothing and never starts a model for a job without segments', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, []);
    const pool = fakePool({ general: scriptedChat(generalAnswer), translate: scriptedChat(echoTranslate()) });
    const written = await runLlmStages(
      { repo, stages, job, outDir: dir, pool, log: () => {} },
      { ...opts, translate: true, summarize: true },
    );
    expect(written).toEqual([]);
    expect(pool.uses).toEqual([]);
  });

  it('resumes translation after an abort without redoing finished batches, and stops the models', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い', 'う', 'え']);
    const controller = new AbortController();
    const first = scriptedChat((m, call) => {
      if (call === 2) {
        controller.abort();
        return 'x';
      }
      return echoTranslate()(m);
    });
    const pool1 = fakePool({ general: scriptedChat(generalAnswer), translate: first });
    await expect(
      runLlmStages(
        { repo, stages, job, outDir: dir, pool: pool1, log: () => {}, signal: controller.signal },
        { ...opts, translate: true, batchSize: 2 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool1.stopped).toBe(1);
    expect(stages.getStage(job.id, 'translate')).toBe('running');
    expect(existsSync(path.join(dir, `job-${job.id}.en.srt`))).toBe(true); // written after batch 1

    const second = scriptedChat(echoTranslate());
    const pool2 = fakePool({ general: scriptedChat(generalAnswer), translate: second });
    await runLlmStages({ repo, stages, job, outDir: dir, pool: pool2, log: () => {} }, { ...opts, translate: true, batchSize: 2 });
    expect(second.calls).toHaveLength(1);
    expect(stages.listTranslations(job.id).size).toBe(4);
  });

  it('marks a failing stage failed and rethrows', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ']);
    const boom = new Error('boom');
    const pool = fakePool({
      general: scriptedChat(() => '[]'),
      translate: { chat: async () => { throw boom; } },
    });
    await expect(
      runLlmStages({ repo, stages, job, outDir: dir, pool, log: () => {} }, { ...opts, translate: true }),
    ).rejects.toBe(boom);
    expect(stages.getStage(job.id, 'translate')).toBe('failed');
    expect(pool.stopped).toBe(1);
  });
});
