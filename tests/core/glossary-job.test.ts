import { describe, expect, it } from 'vitest';
import { BgtError } from '../../src/core/errors';
import { runGlossaryStage } from '../../src/core/pipeline/glossary-job';
import { scriptedChat } from '../helpers/llm-fakes';
import { memoryRepos, seedJob } from '../helpers/fakes';

const base = (llm: ReturnType<typeof scriptedChat>) => {
  const { repo, stages } = memoryRepos();
  const job = seedJob(repo, ['ゆりまるです', '運動会の話']);
  return { repo, stages, job, llm, log: () => {} };
};

describe('runGlossaryStage', () => {
  it('merges model proposals; user entries override and are applied first', async () => {
    const llm = scriptedChat(() => '[{"ja":"ゆりまる","en":"Yurimaru"},{"ja":"運動会","en":"sports meet"}]');
    const ctx = base(llm);
    await runGlossaryStage({
      repo: ctx.repo,
      stages: ctx.stages,
      llm,
      jobId: ctx.job.id,
      userGlossary: { 運動会: 'sports day' },
      log: ctx.log,
    });
    const glossary = Object.fromEntries(ctx.stages.listGlossary(ctx.job.id).map((g) => [g.ja, g.en]));
    expect(glossary).toEqual({ ゆりまる: 'Yurimaru', 運動会: 'sports day' });
    expect(ctx.stages.getStage(ctx.job.id, 'glossary')).toBe('done');
  });

  it('skips a window whose reply is unusable and still finishes', async () => {
    const llm = scriptedChat(() => 'I cannot help with that.');
    const ctx = base(llm);
    await runGlossaryStage({ repo: ctx.repo, stages: ctx.stages, llm, jobId: ctx.job.id, userGlossary: {}, log: ctx.log });
    expect(ctx.stages.listGlossary(ctx.job.id)).toEqual([]);
    expect(ctx.stages.getStage(ctx.job.id, 'glossary')).toBe('done');
  });

  it('logs and continues when a request fails', async () => {
    const llm = scriptedChat(() => new BgtError('LlmFailed', 'down'));
    const ctx = base(llm);
    const logs: string[] = [];
    await runGlossaryStage({ repo: ctx.repo, stages: ctx.stages, llm, jobId: ctx.job.id, userGlossary: {}, log: (m) => logs.push(m) });
    expect(logs.join('\n')).toContain('down');
  });

  it('does not call the model again when already done, but still applies new user entries', async () => {
    const llm = scriptedChat(() => '[]');
    const ctx = base(llm);
    const args = { repo: ctx.repo, stages: ctx.stages, llm, jobId: ctx.job.id, log: ctx.log };
    await runGlossaryStage({ ...args, userGlossary: {} });
    await runGlossaryStage({ ...args, userGlossary: { 新: 'new' } });
    expect(llm.calls).toHaveLength(1);
    expect(ctx.stages.listGlossary(ctx.job.id)).toEqual([{ ja: '新', en: 'new', source: 'user' }]);
  });

  it('rethrows an abort', async () => {
    const controller = new AbortController();
    const llm = scriptedChat(() => {
      controller.abort();
      return '[]';
    });
    const ctx = base(llm);
    await expect(
      runGlossaryStage({ repo: ctx.repo, stages: ctx.stages, llm, jobId: ctx.job.id, userGlossary: {}, signal: controller.signal, log: ctx.log }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
