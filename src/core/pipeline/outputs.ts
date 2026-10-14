import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JobRow, Repo } from '../db/repo';
import { toSrt } from '../subtitles/srt';

/** Writes `job-<id>.<lang>.srt` and `.json`. Times include the job's range offset (video time). */
export function writeOutputs(
  repo: Repo,
  job: JobRow,
  outDir: string,
): { srtPath: string; jsonPath: string } {
  mkdirSync(outDir, { recursive: true });
  const segments = repo.listSegments(job.id).map((s) => ({
    ...s,
    startMs: s.startMs + job.rangeStartMs,
    endMs: s.endMs + job.rangeStartMs,
  }));
  const base = path.join(outDir, `job-${job.id}.${job.settings.language}`);
  const srtPath = `${base}.srt`;
  const jsonPath = `${base}.json`;
  writeFileSync(srtPath, toSrt(segments));
  writeFileSync(jsonPath, JSON.stringify({ job, segments }, null, 2));
  return { srtPath, jsonPath };
}
