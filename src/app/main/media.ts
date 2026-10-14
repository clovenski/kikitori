import { existsSync, statSync } from 'node:fs';
import type { Repo } from '../../core/db/repo';
import { isUrl } from '../../core/pipeline/real-deps';

/** `bgt-media://job/<id>` -> id, or null for anything else. */
export function parseMediaUrl(url: string): number | null {
  const m = /^bgt-media:\/\/job\/(\d+)\/?(?:[?#].*)?$/.exec(url);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Only the local-file source of an existing job may be served; never an arbitrary path. */
export function resolveMediaPath(repo: Repo, jobId: unknown): string | null {
  if (typeof jobId !== 'number' || !Number.isInteger(jobId) || jobId < 1) return null;
  const job = repo.getJob(jobId);
  if (!job || isUrl(job.source)) return null;
  try {
    return existsSync(job.source) && statSync(job.source).isFile() ? job.source : null;
  } catch {
    return null;
  }
}
