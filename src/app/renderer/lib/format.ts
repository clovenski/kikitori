import type { JobStatus, ProgressEvent, SubmissionState } from '../../shared/ipc';

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return 'unknown until a first run';
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

const STAGES: Record<ProgressEvent['stage'], string> = {
  fetch: 'Downloading audio',
  transcribe: 'Transcribing',
  glossary: 'Finding names',
  translate: 'Translating',
  summarize: 'Summarizing',
};
export const stageLabel = (stage: ProgressEvent['stage']): string => STAGES[stage];

const STATES: Record<SubmissionState, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};
export const stateLabel = (state: SubmissionState): string => STATES[state];

const JOB_STATUSES: Record<JobStatus, string> = {
  pending: 'Not finished',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};
export const jobStatusLabel = (status: JobStatus): string => JOB_STATUSES[status];

export function progressPercent(e: ProgressEvent): number {
  if (e.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((e.done / e.total) * 100)));
}

export function formatRemaining(seconds: number | null): string {
  return seconds === null ? 'estimating' : formatEta(seconds);
}
