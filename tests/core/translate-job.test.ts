import { describe, expect, it } from 'vitest';
import { HyMtTranslator } from '../../src/core/backends/translate/hymt';
import { runTranslateStage } from '../../src/core/pipeline/translate-job';
import { echoTranslate, scriptedChat } from '../helpers/llm-fakes';
import { memoryRepos, seedJob } from '../helpers/fakes';

const texts = ['あ', 'い', 'う', 'え', 'お'];

describe('runTranslateStage', () => {
  it('translates every segment in batches and records the translations', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, texts);
    const llm = scriptedChat(echoTranslate());
    const batches: number[] = [];
    await runTranslateStage({
      repo,
      stages,
      translator: new HyMtTranslator(llm),
      jobId: job.id,
      batchSize: 2,
      log: () => {},
      onBatch: () => batches.push(stages.listTranslations(job.id).size),
    });
    const byText = repo.listSegmentsWithId(job.id).map((s) => stages.listTranslations(job.id).get(s.id));
    expect(byText).toEqual(['EN:あ', 'EN:い', 'EN:う', 'EN:え', 'EN:お']);
    expect(batches).toEqual([2, 4, 5]);
    expect(stages.getStage(job.id, 'translate')).toBe('done');
  });

  it('resumes after an abort without re-translating finished batches', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, texts);
    const controller = new AbortController();
    const first = scriptedChat((m, call) => {
      if (call === 2) {
        controller.abort();
        return 'ignored';
      }
      return echoTranslate()(m);
    });
    await expect(
      runTranslateStage({
        repo,
        stages,
        translator: new HyMtTranslator(first),
        jobId: job.id,
        batchSize: 2,
        signal: controller.signal,
        log: () => {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(stages.listTranslations(job.id).size).toBe(2);
    expect(stages.getStage(job.id, 'translate')).toBe('running');

    const second = scriptedChat(echoTranslate());
    await runTranslateStage({
      repo,
      stages,
      translator: new HyMtTranslator(second),
      jobId: job.id,
      batchSize: 2,
      log: () => {},
    });
    expect(second.calls).toHaveLength(2); // 3 remaining segments = 2 batches, not 3
    expect(stages.listTranslations(job.id).size).toBe(5);
    expect(second.calls[0][0].content).toContain('EN:い'); // context from the finished batch
  });

  it('stores empty strings for untranslatable lines, logs them, and still completes', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ']);
    const logs: string[] = [];
    await runTranslateStage({
      repo,
      stages,
      translator: { translateBatch: async (lines) => lines.map(() => '') },
      jobId: job.id,
      log: (m) => logs.push(m),
    });
    expect([...stages.listTranslations(job.id).values()]).toEqual(['']);
    expect(logs.join('\n')).toMatch(/1 line/);
    expect(stages.getStage(job.id, 'translate')).toBe('failed');
  });

  it('re-translates blank lines on the next run and then completes', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い']);
    await runTranslateStage({
      repo,
      stages,
      translator: { translateBatch: async (lines) => lines.map((l) => (l === 'い' ? '' : 'EN:' + l)) },
      jobId: job.id,
      log: () => {},
    });
    expect(stages.getStage(job.id, 'translate')).toBe('failed');

    const llm = scriptedChat(echoTranslate());
    await runTranslateStage({ repo, stages, translator: new HyMtTranslator(llm), jobId: job.id, log: () => {} });
    expect(llm.calls).toHaveLength(1); // only the blank line is sent again
    expect(llm.calls[0][0].content).toContain('[1] い');
    const byText = repo.listSegmentsWithId(job.id).map((s) => stages.listTranslations(job.id).get(s.id));
    expect(byText).toEqual(['EN:あ', 'EN:い']);
    expect(stages.getStage(job.id, 'translate')).toBe('done');
  });

  it('does nothing for a job without segments', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, []);
    const llm = scriptedChat(echoTranslate());
    await runTranslateStage({ repo, stages, translator: new HyMtTranslator(llm), jobId: job.id, log: () => {} });
    expect(llm.calls).toHaveLength(0);
    expect(stages.getStage(job.id, 'translate')).toBe('done');
  });

  it('skips a stage that is already done', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, texts);
    stages.setStage(job.id, 'translate', 'done');
    const llm = scriptedChat(echoTranslate());
    await runTranslateStage({ repo, stages, translator: new HyMtTranslator(llm), jobId: job.id, log: () => {} });
    expect(llm.calls).toHaveLength(0);
  });
});
