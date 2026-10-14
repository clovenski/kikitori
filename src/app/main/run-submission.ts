import type { Repo } from '../../core/db/repo';
import type { StageRepo } from '../../core/db/stage-repo';
import type { Submission } from '../../core/db/submission-repo';
import { BgtError } from '../../core/errors';
import { loadGlossaryFile } from '../../core/llm/glossary-file';
import { runJob, type PipelineDeps } from '../../core/pipeline/run';
import { runLlmStages, type ModelPool } from '../../core/pipeline/stages';
import type { RunContext } from './queue';

export interface RunSubmissionEnv {
  repo: Repo;
  stages: StageRepo;
  /** Builds pipeline dependencies for the submission's model (shares the app's database). */
  makeDeps(sub: Submission): PipelineDeps;
  workRoot: string;
  outDir: string;
  pool: ModelPool;
  log(message: string): void;
}

export async function runSubmission(env: RunSubmissionEnv, sub: Submission, ctx: RunContext): Promise<void> {
  const { options } = sub;
  // A bad glossary file should fail now, not after the transcription.
  const userGlossary = options.glossaryPath ? loadGlossaryFile(options.glossaryPath) : {};

  const deps: PipelineDeps = { ...env.makeDeps(sub), log: env.log, progress: ctx.progress };
  const result = await runJob(deps, {
    source: sub.source,
    startMs: sub.startMs,
    endMs: sub.endMs,
    maxMinutes: options.maxMinutes,
    model: options.model,
    language: 'ja',
    workRoot: env.workRoot,
    outDir: env.outDir,
    keepWork: false,
    signal: ctx.signal,
    onJob: (job) => ctx.onJob(job.id),
  });
  if (result.status !== 'done') {
    throw new BgtError(
      'TranscribeFailed',
      `${result.failedChunks.length} chunk(s) could not be transcribed. Resume the job to retry them.`,
    );
  }

  if (!options.translate && !options.summarize && !options.skim) return;
  const job = env.repo.getJob(result.jobId);
  if (!job) throw new BgtError('InvalidInput', `Job ${result.jobId} disappeared.`);
  await runLlmStages(
    {
      repo: env.repo,
      stages: env.stages,
      job,
      outDir: env.outDir,
      pool: env.pool,
      log: env.log,
      signal: ctx.signal,
      progress: ctx.progress,
    },
    { translate: options.translate, summarize: options.summarize, skim: options.skim, userGlossary },
  );
}
