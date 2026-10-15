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

export interface QueueProgressEvent {
  submissionId: number;
  event: ProgressEvent;
}

export interface BgtApi {
  ping(): Promise<string>;
  library: { list(): Promise<Result<LibraryItem[]>> };
  job: {
    get(jobId: number): Promise<Result<JobDetail>>;
    openOutputFolder(jobId: number): Promise<Result<null>>;
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
}

/** IPC channel names, shared by main and preload. */
export const CHANNELS = {
  ping: 'app:ping',
  libraryList: 'library:list',
  jobGet: 'job:get',
  jobOpenOutputFolder: 'job:openOutputFolder',
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
} as const;
