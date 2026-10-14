import { describe, expect, it } from 'vitest';
import { BgtError } from '../../src/core/errors';
import { runSummarizeStage } from '../../src/core/pipeline/summarize-job';
import { scriptedChat } from '../helpers/llm-fakes';
import { memoryRepos, seedJob } from '../helpers/fakes';

// 3 segments per 5-minute window: stepMs 100_000 puts segments 0..2 in window 0, 3..5 in window 1, ...
const STEP = 100_000;
const kind = (content: string) =>
  content.includes('Merge the following') ? 'section' : content.includes('overview in English') ? 'overview' : 'window';
const answer = (m: { content: string }[]) => {
  const content = m[m.length - 1].content;
  return `${kind(content)} summary`;
};

const run = async (texts: string[], over: Partial<Parameters<typeof runSummarizeStage>[0]> = {}) => {
  const { repo, stages } = memoryRepos();
  const job = seedJob(repo, texts, { stepMs: STEP, rangeStartMs: 3_600_000 });
  const llm = scriptedChat(answer);
  await runSummarizeStage({ repo, stages, llm, jobId: job.id, rangeStartMs: job.rangeStartMs, log: () => {}, ...over });
  return { repo, stages, job, llm };
};

describe('runSummarizeStage', () => {
  it('writes window summaries with absolute times and an overview', async () => {
    const { stages, job, llm } = await run(['a', 'b', 'c', 'd', 'e', 'f']);
    const windows = stages.listSummaries(job.id, 'window');
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ idx: 0, startMs: 3_600_000, text: 'window summary' });
    expect(stages.listSummaries(job.id, 'section')).toHaveLength(0);
    expect(stages.listSummaries(job.id, 'overview')).toMatchObject([
      { idx: 0, startMs: 3_600_000, text: 'overview summary' },
    ]);
    expect(llm.calls).toHaveLength(3);
    expect(stages.getStage(job.id, 'summarize')).toBe('done');
  });

  it('adds a section level only above 12 windows', async () => {
    const texts = Array.from({ length: 13 * 3 }, (_, i) => `t${i}`);
    const { stages, job } = await run(texts);
    expect(stages.listSummaries(job.id, 'window')).toHaveLength(13);
    expect(stages.listSummaries(job.id, 'section')).toHaveLength(3); // 6 + 6 + 1
    expect(stages.listSummaries(job.id, 'overview')).toHaveLength(1);
  });

  it('reports progress per window', async () => {
    const events: [number, number][] = [];
    await run(['a', 'b', 'c', 'd', 'e', 'f'], { progress: (e) => events.push([e.done, e.total]) });
    expect(events).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('summarizes the English translation when the translate stage is done, else the Japanese text', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['こんにちは']);
    const [seg] = repo.listSegmentsWithId(job.id);
    stages.saveTranslations(job.id, 0, [{ segmentId: seg.id, text: 'Hello there' }]);
    stages.setStage(job.id, 'translate', 'done');
    const llm = scriptedChat(answer);
    await runSummarizeStage({ repo, stages, llm, jobId: job.id, rangeStartMs: 0, log: () => {} });
    expect(llm.calls[0][0].content).toContain('translated into English');
    expect(llm.calls[0][0].content).toContain('Hello there');

    const other = memoryRepos();
    const job2 = seedJob(other.repo, ['こんにちは']);
    const llm2 = scriptedChat(answer);
    await runSummarizeStage({ repo: other.repo, stages: other.stages, llm: llm2, jobId: job2.id, rangeStartMs: 0, log: () => {} });
    expect(llm2.calls[0][0].content).toContain('in Japanese');
    expect(llm2.calls[0][0].content).toContain('こんにちは');
  });

  it('falls back to the Japanese text for a line whose translation is empty', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['こんにちは']);
    const [seg] = repo.listSegmentsWithId(job.id);
    stages.saveTranslations(job.id, 0, [{ segmentId: seg.id, text: '' }]);
    stages.setStage(job.id, 'translate', 'done');
    const llm = scriptedChat(answer);
    await runSummarizeStage({ repo, stages, llm, jobId: job.id, rangeStartMs: 0, log: () => {} });
    expect(llm.calls[0][0].content).toContain('こんにちは');
  });

  it('resumes: finished windows are not summarized again', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['a', 'b', 'c', 'd', 'e', 'f'], { stepMs: STEP });
    const controller = new AbortController();
    const first = scriptedChat((m, call) => {
      if (call === 2) {
        controller.abort();
        return 'x';
      }
      return answer(m);
    });
    await expect(
      runSummarizeStage({ repo, stages, llm: first, jobId: job.id, rangeStartMs: 0, signal: controller.signal, log: () => {} }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(stages.listSummaries(job.id, 'window')).toHaveLength(1);

    const second = scriptedChat(answer);
    await runSummarizeStage({ repo, stages, llm: second, jobId: job.id, rangeStartMs: 0, log: () => {} });
    expect(second.calls).toHaveLength(2); // window 1 + overview
    expect(stages.listSummaries(job.id, 'window')).toHaveLength(2);
  });

  it('skips a failed window, and does nothing for an empty job', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['a']);
    const logs: string[] = [];
    await runSummarizeStage({
      repo,
      stages,
      llm: scriptedChat(() => new BgtError('LlmFailed', 'down')),
      jobId: job.id,
      rangeStartMs: 0,
      log: (m) => logs.push(m),
    });
    expect(stages.listSummaries(job.id)).toEqual([]);
    expect(logs.join('\n')).toContain('down');

    const empty = memoryRepos();
    const job2 = seedJob(empty.repo, []);
    const llm = scriptedChat(answer);
    await runSummarizeStage({ repo: empty.repo, stages: empty.stages, llm, jobId: job2.id, rangeStartMs: 0, log: () => {} });
    expect(llm.calls).toHaveLength(0);
    expect(empty.stages.getStage(job2.id, 'summarize')).toBe('done');
  });

  it('leaves the stage failed when a window fails, then fills the gap and writes the overview on re-run', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['a', 'b', 'c', 'd', 'e', 'f'], { stepMs: STEP });
    const first = scriptedChat((m, call) => (call === 2 ? new BgtError('LlmFailed', 'down') : answer(m)));
    await runSummarizeStage({ repo, stages, llm: first, jobId: job.id, rangeStartMs: 0, log: () => {} });
    expect(stages.listSummaries(job.id, 'window')).toHaveLength(1);
    expect(stages.listSummaries(job.id, 'overview')).toHaveLength(0); // not built from a partial set
    expect(stages.getStage(job.id, 'summarize')).toBe('failed');

    const second = scriptedChat(answer);
    await runSummarizeStage({ repo, stages, llm: second, jobId: job.id, rangeStartMs: 0, log: () => {} });
    expect(second.calls).toHaveLength(2); // the missing window + the overview
    expect(stages.listSummaries(job.id, 'window')).toHaveLength(2);
    expect(stages.listSummaries(job.id, 'overview')).toHaveLength(1);
    expect(stages.getStage(job.id, 'summarize')).toBe('done');
  });
});
