import { HyMtTranslator } from '../backends/translate/hymt';
import type { JobRow, Repo } from '../db/repo';
import type { StageName, StageRepo } from '../db/stage-repo';
import type { LlmChat } from '../llm/client';
import type { ProgressEvent } from '../progress';
import { runGlossaryStage } from './glossary-job';
import { writeLlmOutputs } from './llm-outputs';
import { runSummarizeStage } from './summarize-job';
import { runTranslateStage } from './translate-job';

export type ModelRole = 'general' | 'translate';

export interface ModelPool {
  /** Returns a chat client for the role, stopping any other loaded model first. */
  use(role: ModelRole, signal?: AbortSignal): Promise<LlmChat>;
  stopAll(): Promise<void>;
}

export interface StageOptions {
  translate: boolean;
  summarize: boolean;
  skim: boolean;
  userGlossary: Record<string, string>;
  batchSize?: number;
}

export interface StageContext {
  repo: Repo;
  stages: StageRepo;
  job: JobRow;
  outDir: string;
  pool: ModelPool;
  log: (message: string) => void;
  signal?: AbortSignal;
  progress?: (e: ProgressEvent) => void;
}

export async function runLlmStages(ctx: StageContext, opts: StageOptions): Promise<string[]> {
  const { repo, stages, job, pool, log, signal } = ctx;
  if (repo.listSegments(job.id).length === 0) {
    log('No speech was transcribed, so there is nothing to translate or summarize.');
    return [];
  }

  const wantGlossary = opts.translate || opts.skim;
  const wantSummary = opts.summarize || opts.skim;

  const guard = async (stage: StageName, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      if (!signal?.aborted) stages.setStage(job.id, stage, 'failed');
      throw err;
    }
  };

  try {
    if (wantGlossary) {
      await guard('glossary', async () => {
        log('Extracting names and terms...');
        const llm = await pool.use('general', signal);
        await runGlossaryStage({ repo, stages, llm, jobId: job.id, userGlossary: opts.userGlossary, signal, log, progress: ctx.progress });
      });
    }
    if (opts.translate) {
      await guard('translate', async () => {
        log('Translating...');
        const llm = await pool.use('translate', signal);
        await runTranslateStage({
          repo,
          stages,
          translator: new HyMtTranslator(llm),
          jobId: job.id,
          batchSize: opts.batchSize,
          signal,
          log,
          progress: ctx.progress,
          onBatch: () => writeLlmOutputs(repo, stages, job, ctx.outDir),
        });
      });
    }
    if (wantSummary) {
      await guard('summarize', async () => {
        log('Summarizing...');
        const llm = await pool.use('general', signal);
        await runSummarizeStage({ repo, stages, llm, jobId: job.id, rangeStartMs: job.rangeStartMs, signal, log, progress: ctx.progress });
      });
    }
  } finally {
    await pool.stopAll();
  }
  return writeLlmOutputs(repo, stages, job, ctx.outDir);
}
