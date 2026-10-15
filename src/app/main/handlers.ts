import { existsSync } from 'node:fs';
import type { Channel, ChannelStore } from '../../core/db/channel-repo';
import type { Repo } from '../../core/db/repo';
import type { StageRepo } from '../../core/db/stage-repo';
import type { SubmissionOptions } from '../../core/db/submission-repo';
import { BgtError } from '../../core/errors';
import { loadGlossaryFile } from '../../core/llm/glossary-file';
import { estimateSeconds } from '../../core/pipeline/estimate';
import { isUrl } from '../../core/pipeline/real-deps';
import { CHANNELS, type ProbeResult, type Result } from '../shared/ipc';
import { buildFeed, toChannelInfo } from './channel-service';
import { getJobDetail, listLibrary } from './library-service';
import type { JobQueue } from './queue';
import type { SetupService } from './setup-service';
import {
  parseChannelText,
  parseEstimateArgs,
  parseId,
  parseOptionalId,
  parseSetupSelection,
  parseSource,
  parseSubmissionOptions,
  parseSubmitRequest,
  parseVideoId,
} from './validate';

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
  setup: Pick<SetupService, 'state' | 'detect' | 'plan' | 'missingFor' | 'start' | 'cancel' | 'repair' | 'updateYtDlp'>;
  openNotices(): Promise<void>;
  /** Throws SetupRequired when the job needs components that are not installed yet. */
  ensureReady(options: SubmissionOptions): void;
  /** Whisper model name of the installed tier; stored on every new submission. */
  transcribeModel(): string;
  channels: {
    store: ChannelStore;
    add(input: string): Promise<Channel>;
    refresh(id?: number): Promise<void>;
  };
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
        d.ensureReady(request.options);
        return d.queue.submit({ ...request, options: { ...request.options, model: d.transcribeModel() } });
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
    [CHANNELS.setupState]: () => wrap(() => d.setup.state()),
    [CHANNELS.setupDetect]: () => wrap(() => d.setup.detect()),
    [CHANNELS.setupPlan]: (arg?: unknown) => wrap(() => d.setup.plan(parseSetupSelection(arg))),
    [CHANNELS.setupMissingFor]: (arg?: unknown) => wrap(() => d.setup.missingFor(parseSubmissionOptions(arg))),
    [CHANNELS.setupStart]: (arg?: unknown) =>
      wrap(() => {
        d.setup.start(parseSetupSelection(arg));
        return null;
      }),
    [CHANNELS.setupCancel]: () =>
      wrap(async () => {
        await d.setup.cancel();
        return null;
      }),
    [CHANNELS.setupRepair]: () =>
      wrap(() => {
        d.setup.repair();
        return null;
      }),
    [CHANNELS.setupUpdateYtDlp]: () => wrap(() => d.setup.updateYtDlp()),
    [CHANNELS.setupOpenNotices]: () =>
      wrap(async () => {
        await d.openNotices();
        return null;
      }),
    [CHANNELS.channelsList]: () => wrap(() => d.channels.store.listChannels().map(toChannelInfo)),
    [CHANNELS.channelsAdd]: (arg?: unknown) => wrap(async () => toChannelInfo(await d.channels.add(parseChannelText(arg)))),
    [CHANNELS.channelsRemove]: (arg?: unknown) =>
      wrap(() => {
        d.channels.store.removeChannel(parseId(arg, 'channel id'));
        return null;
      }),
    [CHANNELS.channelsRefresh]: (arg?: unknown) =>
      wrap(async () => {
        await d.channels.refresh(parseOptionalId(arg, 'channel id'));
        return null;
      }),
    [CHANNELS.feedList]: () => wrap(() => buildFeed(d.channels.store, d.repo)),
    [CHANNELS.feedDismiss]: (arg?: unknown) =>
      wrap(() => {
        d.channels.store.dismiss(parseVideoId(arg));
        return null;
      }),
    [CHANNELS.feedDismissAll]: (arg?: unknown) =>
      wrap(() => {
        d.channels.store.dismissAll(parseOptionalId(arg, 'channel id'));
        return null;
      }),
  } satisfies Record<string, Handler>;
  return handlers;
}

export type Handlers = ReturnType<typeof createHandlers>;
