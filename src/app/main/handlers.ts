import { existsSync } from 'node:fs';
import type { Repo } from '../../core/db/repo';
import type { StageRepo } from '../../core/db/stage-repo';
import { BgtError } from '../../core/errors';
import { loadGlossaryFile } from '../../core/llm/glossary-file';
import { estimateSeconds } from '../../core/pipeline/estimate';
import { isUrl } from '../../core/pipeline/real-deps';
import { CHANNELS, type ProbeResult, type Result } from '../shared/ipc';
import { getJobDetail, listLibrary } from './library-service';
import type { JobQueue } from './queue';
import { parseEstimateArgs, parseId, parseSource, parseSubmitRequest } from './validate';

export interface HandlerDeps {
  repo: Repo;
  stages: StageRepo;
  queue: JobQueue;
  probe(source: string): Promise<ProbeResult>;
  speedFactor(): number | null;
  pickFile(kind: 'media' | 'glossary'): Promise<string | null>;
  openFolder(dir: string): Promise<void>;
  outDir: string;
  /** Injectable for tests; defaults to the real file system. */
  fileExists?(path: string): boolean;
}

type Handler = (arg?: unknown) => Promise<Result<unknown>>;

async function wrap<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof BgtError) return { ok: false, error: { code: err.code, message: err.message } };
    return { ok: false, error: { code: 'Error', message: err instanceof Error ? err.message : String(err) } };
  }
}

export function createHandlers(d: HandlerDeps) {
  const handlers = {
    [CHANNELS.libraryList]: () => wrap(() => listLibrary(d.repo, d.stages)),
    [CHANNELS.jobGet]: (arg?: unknown) =>
      wrap(() => {
        const id = parseId(arg, 'job id');
        const detail = getJobDetail(d.repo, d.stages, id);
        if (!detail) throw new BgtError('InvalidInput', `There is no job ${id}.`);
        return detail;
      }),
    [CHANNELS.jobOpenOutputFolder]: (arg?: unknown) =>
      wrap(async () => {
        const id = parseId(arg, 'job id');
        if (!d.repo.getJob(id)) throw new BgtError('InvalidInput', `There is no job ${id}.`);
        await d.openFolder(d.outDir);
        return null;
      }),
    [CHANNELS.queueList]: () => wrap(() => d.queue.list()),
    [CHANNELS.queueSubmit]: (arg?: unknown) =>
      wrap(() => {
        const request = parseSubmitRequest(arg);
        // Fail now, not minutes later when the job starts: a missing file or an unreadable glossary
        // can never succeed, so it must not be queued.
        if (!isUrl(request.source) && !(d.fileExists ?? existsSync)(request.source)) {
          throw new BgtError('InvalidInput', `File not found: ${request.source}`);
        }
        if (request.options.glossaryPath) loadGlossaryFile(request.options.glossaryPath);
        return d.queue.submit(request);
      }),
    [CHANNELS.queueCancel]: (arg?: unknown) =>
      wrap(() => {
        d.queue.cancel(parseId(arg, 'submission id'));
        return null;
      }),
    [CHANNELS.queueResume]: (arg?: unknown) =>
      wrap(() => {
        d.queue.resume(parseId(arg, 'submission id'));
        return null;
      }),
    [CHANNELS.sourceProbe]: (arg?: unknown) => wrap(() => d.probe(parseSource(arg))),
    [CHANNELS.sourceEstimate]: (arg?: unknown) =>
      wrap(() => {
        const { durationMs, startMs, endMs } = parseEstimateArgs(arg);
        const rangeMs = Math.max(0, Math.min(endMs ?? durationMs, durationMs) - startMs);
        return estimateSeconds(rangeMs, d.speedFactor());
      }),
    [CHANNELS.dialogPickMedia]: () => wrap(() => d.pickFile('media')),
    [CHANNELS.dialogPickGlossary]: () => wrap(() => d.pickFile('glossary')),
  } satisfies Record<string, Handler>;
  return handlers;
}

export type Handlers = ReturnType<typeof createHandlers>;
