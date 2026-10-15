import type { JobStatus } from '../../core/db/repo';
import type { SummaryRow } from '../../core/db/stage-repo';
import type { Submission, SubmissionOptions } from '../../core/db/submission-repo';
import type { ProgressEvent } from '../../core/progress';

export type { Submission, SubmissionOptions, SummaryRow, ProgressEvent, JobStatus };
export type { SubmissionState } from '../../core/db/submission-repo';

import type { InstallProgress } from '../../core/setup/installer';
import type { Tier } from '../../core/tools/lock';

export type { InstallProgress, Tier };

export interface SetupFeatures {
  translation: boolean;
  summaries: boolean;
}
export interface SetupSelection {
  tier: Tier;
  features: SetupFeatures;
}
export interface SetupComponentInfo {
  id: string;
  title: string;
  tier: 'all' | Tier;
  sizeBytes: number;
  installed: boolean;
}
export interface SetupState {
  /** True when the first-run wizard must be shown (setup never finished, or a required tool is gone). */
  needsWizard: boolean;
  completed: boolean;
  installing: boolean;
  tier: Tier;
  features: SetupFeatures;
  components: SetupComponentInfo[];
  resourcesDir: string;
}
export interface HardwareReport {
  gpuName: string | null;
  vramMb: number | null;
  recommendedTier: Tier;
  reason: string;
  ramMb: number;
  cores: number;
  freeDiskBytes: number;
}
export interface SetupPlanView {
  /** What would be installed for this view; `components` lists everything it needs, with install state. */
  selection: SetupSelection;
  components: SetupComponentInfo[];
  missingBytes: number;
  /** Disk space the install needs: the missing bytes plus room to unpack the largest archive. */
  requiredFreeBytes: number;
  freeDiskBytes: number;
}
export interface SetupProgress {
  phase: 'idle' | 'installing' | 'done' | 'failed' | 'cancelled';
  progress: InstallProgress | null;
  message: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface LibraryItem {
  jobId: number;
  title: string | null;
  source: string;
  videoId: string | null;
  status: JobStatus;
  rangeStartMs: number;
  rangeEndMs: number;
  createdAt: string;
  hasTranslation: boolean;
  hasSummary: boolean;
  isLocalFile: boolean;
}

export interface TranscriptLine {
  id: number;
  startMs: number;
  endMs: number;
  ja: string;
  en: string | null;
}

export interface JobDetail {
  item: LibraryItem;
  lines: TranscriptLine[];
  summaries: SummaryRow[];
}

export interface ProbeResult {
  title: string | null;
  durationMs: number;
}

export interface SubmitRequest {
  source: string;
  startMs: number;
  endMs: number | null;
  options: SubmissionOptions;
}

export interface ChannelInfo {
  id: number;
  youtubeChannelId: string;
  handle: string | null;
  title: string;
  url: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface FeedItem {
  videoId: string;
  channelId: number;
  channelTitle: string;
  title: string;
  durationMs: number | null;
  tab: 'videos' | 'streams';
  firstSeenAt: string;
  /** The job that already exists for this video, if any. */
  job: { jobId: number; status: JobStatus } | null;
  /** Sent to the queue and waiting to start (no job yet); it must not be offered again. */
  queued: boolean;
}

/** Where the app update stands. Nothing is downloaded until the user asks (`available` waits for that). */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; version: string; message: string };

export interface QueueProgressEvent {
  submissionId: number;
  event: ProgressEvent;
}

/** Where subtitles and summaries for new jobs are written. */
export interface OutputDirInfo {
  dir: string;
  /** True when `dir` is the folder the app picked itself, not one the user chose. */
  isDefault: boolean;
  /** True when the environment fixes the folder, so the app cannot change it. */
  locked: boolean;
}

export interface BgtApi {
  ping(): Promise<string>;
  library: { list(): Promise<Result<LibraryItem[]>> };
  job: {
    get(jobId: number): Promise<Result<JobDetail>>;
    openOutputFolder(jobId: number): Promise<Result<null>>;
    /** Deletes the job, its transcript, translation and summary, and the files written for it. Refused while it runs. */
    delete(jobId: number): Promise<Result<null>>;
  };
  queue: {
    list(): Promise<Result<Submission[]>>;
    submit(request: SubmitRequest): Promise<Result<Submission>>;
    cancel(id: number): Promise<Result<null>>;
    resume(id: number): Promise<Result<null>>;
    onChanged(cb: (submissions: Submission[]) => void): () => void;
    onProgress(cb: (p: QueueProgressEvent) => void): () => void;
  };
  source: {
    probe(source: string): Promise<Result<ProbeResult>>;
    estimate(a: { durationMs: number; startMs: number; endMs: number | null }): Promise<Result<number | null>>;
  };
  dialog: {
    pickMedia(): Promise<Result<string | null>>;
    pickGlossary(): Promise<Result<string | null>>;
    /** Absolute path of a dropped file (synchronous; resolved in the preload). */
    pathForFile(file: File): string;
  };
  setup: {
    state(): Promise<Result<SetupState>>;
    detect(): Promise<Result<HardwareReport>>;
    plan(selection: SetupSelection): Promise<Result<SetupPlanView>>;
    /** What a job with these options still needs downloaded. */
    missingFor(options: SubmissionOptions): Promise<Result<SetupPlanView>>;
    /** Starts the download in the background; progress arrives through `onProgress`. */
    start(selection: SetupSelection): Promise<Result<null>>;
    cancel(): Promise<Result<null>>;
    repair(): Promise<Result<null>>;
    updateYtDlp(): Promise<Result<string>>;
    openNotices(): Promise<Result<null>>;
    onProgress(cb: (p: SetupProgress) => void): () => void;
  };
  output: {
    get(): Promise<Result<OutputDirInfo>>;
    /** Opens the folder picker. Resolves to null when the user cancels. */
    choose(): Promise<Result<OutputDirInfo | null>>;
    reset(): Promise<Result<OutputDirInfo>>;
  };
  channels: {
    list(): Promise<Result<ChannelInfo[]>>;
    add(input: string): Promise<Result<ChannelInfo>>;
    remove(id: number): Promise<Result<null>>;
    /** Checks one channel (or all of them) now and resolves when the check is done. */
    refresh(id?: number): Promise<Result<null>>;
    feed(): Promise<Result<FeedItem[]>>;
    dismiss(videoId: string): Promise<Result<null>>;
    dismissAll(channelId?: number): Promise<Result<null>>;
    onChanged(cb: () => void): () => void;
  };
  updates: {
    state(): Promise<Result<UpdateState>>;
    /** Looks for a newer version now. An error result means the check itself failed. */
    check(): Promise<Result<UpdateState>>;
    /** Starts the download in the background; progress arrives through `onChanged`. */
    download(): Promise<Result<null>>;
    /** Quits and installs the downloaded update. Does nothing if the user keeps a running job going. */
    install(): Promise<Result<null>>;
    onChanged(cb: (state: UpdateState) => void): () => void;
  };
}

/** IPC channel names, shared by main and preload. */
export const CHANNELS = {
  ping: 'app:ping',
  libraryList: 'library:list',
  jobGet: 'job:get',
  jobOpenOutputFolder: 'job:openOutputFolder',
  jobDelete: 'job:delete',
  queueList: 'queue:list',
  queueSubmit: 'queue:submit',
  queueCancel: 'queue:cancel',
  queueResume: 'queue:resume',
  queueChanged: 'queue:changed',
  queueProgress: 'queue:progress',
  sourceProbe: 'source:probe',
  sourceEstimate: 'source:estimate',
  dialogPickMedia: 'dialog:pickMedia',
  dialogPickGlossary: 'dialog:pickGlossary',
  setupState: 'setup:state',
  setupDetect: 'setup:detect',
  setupPlan: 'setup:plan',
  setupMissingFor: 'setup:missingFor',
  setupStart: 'setup:start',
  setupCancel: 'setup:cancel',
  setupRepair: 'setup:repair',
  setupUpdateYtDlp: 'setup:updateYtDlp',
  setupOpenNotices: 'setup:openNotices',
  setupProgress: 'setup:progress',
  outputGet: 'output:get',
  outputChoose: 'output:choose',
  outputReset: 'output:reset',
  channelsList: 'channels:list',
  channelsAdd: 'channels:add',
  channelsRemove: 'channels:remove',
  channelsRefresh: 'channels:refresh',
  feedList: 'feed:list',
  feedDismiss: 'feed:dismiss',
  feedDismissAll: 'feed:dismissAll',
  channelsChanged: 'channels:changed',
  updatesState: 'updates:state',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',
  updatesChanged: 'updates:changed',
} as const;
