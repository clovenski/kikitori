import type { JobRow, Repo } from '../../core/db/repo';
import type { StageRepo } from '../../core/db/stage-repo';
import { isUrl } from '../../core/pipeline/real-deps';
import type { JobDetail, LibraryItem } from '../shared/ipc';

function toItem(job: JobRow, stages: StageRepo): LibraryItem {
  return {
    jobId: job.id,
    title: job.title,
    source: job.source,
    videoId: job.videoId,
    status: job.status,
    rangeStartMs: job.rangeStartMs,
    rangeEndMs: job.rangeEndMs,
    createdAt: job.createdAt,
    hasTranslation: stages.countTranslations(job.id) > 0,
    hasSummary: stages.countSummaries(job.id) > 0,
    isLocalFile: !isUrl(job.source),
  };
}

export function listLibrary(repo: Repo, stages: StageRepo): LibraryItem[] {
  return repo.listJobs().map((job) => toItem(job, stages));
}

export function getJobDetail(repo: Repo, stages: StageRepo, jobId: number): JobDetail | null {
  const job = repo.getJob(jobId);
  if (!job) return null;
  const translations = stages.listTranslations(jobId);
  const lines = repo.listSegmentsWithId(jobId).map((s) => ({
    id: s.id,
    startMs: s.startMs + job.rangeStartMs,
    endMs: s.endMs + job.rangeStartMs,
    ja: s.text,
    en: (translations.get(s.id) ?? '') === '' ? null : (translations.get(s.id) as string),
  }));
  return { item: toItem(job, stages), lines, summaries: stages.listSummaries(jobId) };
}
