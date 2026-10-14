import path from 'node:path';
import { BgtError } from '../core/errors';
import { loadGlossaryFile } from '../core/llm/glossary-file';
import { createRealDeps } from '../core/pipeline/real-deps';
import { createRealModelPool } from '../core/pipeline/real-llm';
import { runLlmStages, type StageOptions } from '../core/pipeline/stages';
import { dataDir } from '../core/tools/paths';

export interface LlmCliOptions {
  translate?: boolean;
  summarize?: boolean;
  skim?: boolean;
  glossary?: string;
  out: string;
}

export function wantsLlm(o: LlmCliOptions): boolean {
  return Boolean(o.translate || o.summarize || o.skim);
}

export function validateLlmOptions(o: LlmCliOptions): void {
  if (o.skim && o.translate) {
    throw new BgtError('InvalidInput', '--skim skips full translation, so it cannot be combined with --translate.');
  }
}

function stageOptions(o: LlmCliOptions): StageOptions {
  return {
    translate: Boolean(o.translate),
    summarize: Boolean(o.summarize),
    skim: Boolean(o.skim),
    userGlossary: o.glossary ? loadGlossaryFile(o.glossary) : {},
  };
}

/** Validates the flags and loads the glossary file; call before any expensive work so mistakes fail fast. */
export function prepareLlmOptions(o: LlmCliOptions): StageOptions {
  validateLlmOptions(o);
  return stageOptions(o);
}

/** Runs the LLM stages on an already transcribed job and prints the output paths. */
export async function runStagesForJob(
  jobId: number,
  o: LlmCliOptions,
  signal?: AbortSignal,
  reuse?: ReturnType<typeof createRealDeps>,
): Promise<void> {
  const opts = prepareLlmOptions(o);
  const handle = reuse ?? createRealDeps({ dataDir: dataDir(), model: 'large-v3', log: console.log });
  try {
    const job = handle.deps.repo.getJob(jobId);
    if (!job) throw new BgtError('InvalidInput', `There is no job ${jobId}.`);
    if (job.status !== 'done') {
      throw new BgtError('InvalidInput', `Job ${jobId} has not finished transcribing. Re-run its "bgt run" command first.`);
    }
    const written = await runLlmStages(
      {
        repo: handle.deps.repo,
        stages: handle.stages,
        job,
        outDir: path.resolve(o.out),
        pool: createRealModelPool({ log: console.log }),
        log: console.log,
        signal,
      },
      opts,
    );
    for (const file of written) console.log(`Wrote ${file}`);
  } finally {
    if (!reuse) handle.close();
  }
}

export async function llmCommand(jobIdText: string, o: LlmCliOptions, mode: 'translate' | 'summarize'): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => {
    console.log('\nStopping... run the same command again to resume.');
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  try {
    const jobId = Number(jobIdText);
    if (!Number.isInteger(jobId) || jobId < 1) throw new BgtError('InvalidInput', `"${jobIdText}" is not a job id.`);
    await runStagesForJob(jobId, { ...o, translate: mode === 'translate' ? true : o.translate, summarize: mode === 'summarize' ? true : o.summarize }, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      process.exitCode = 130;
      return;
    }
    if (err instanceof BgtError) {
      console.error(`${err.code}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
