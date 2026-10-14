import path from 'node:path';
import { BgtError } from '../core/errors';
import { createRealDeps } from '../core/pipeline/real-deps';
import { runJob } from '../core/pipeline/run';
import { dataDir } from '../core/tools/paths';
import { parseTimestamp } from '../core/time';

export interface RunCliOptions {
  start?: string;
  end?: string;
  model: string;
  out: string;
  maxMinutes: string;
  keepWork?: boolean;
}

export async function runCommand(source: string, opts: RunCliOptions): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => {
    console.log('\nStopping... run the same command again to resume.');
    controller.abort();
  };
  process.once('SIGINT', onSigint);

  let closeDeps: (() => void) | undefined;
  try {
    const maxMinutes = Number(opts.maxMinutes);
    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
      throw new BgtError('InvalidInput', `--max-minutes must be a positive number, got "${opts.maxMinutes}".`);
    }
    const startMs = opts.start ? parseTimestamp(opts.start) : 0;
    const endMs = opts.end ? parseTimestamp(opts.end) : null;

    const { deps, workRoot, close } = createRealDeps({
      dataDir: dataDir(),
      model: opts.model,
      log: (m) => console.log(m),
    });
    closeDeps = close;

    const result = await runJob(deps, {
      source,
      startMs,
      endMs,
      maxMinutes,
      model: opts.model,
      language: 'ja',
      workRoot,
      outDir: path.resolve(opts.out),
      keepWork: Boolean(opts.keepWork),
      signal: controller.signal,
    });

    console.log(`\nSubtitles: ${result.srtPath}`);
    console.log(`Raw data:  ${result.jsonPath}`);
    if (result.status !== 'done') process.exitCode = 2;
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
    closeDeps?.();
  }
}
