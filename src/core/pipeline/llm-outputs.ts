import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JobRow, Repo } from '../db/repo';
import type { StageRepo } from '../db/stage-repo';
import { toBilingualSrt } from '../subtitles/bilingual';
import { toSrt } from '../subtitles/srt';
import { toSummaryMarkdown } from '../subtitles/summary-md';

/** Writes whichever of `.en.srt`, `.bi.srt` and `.summary.md` have content. Returns the paths written. */
export function writeLlmOutputs(repo: Repo, stages: StageRepo, job: JobRow, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `job-${job.id}`);
  const written: string[] = [];

  const translations = stages.listTranslations(job.id);
  if (translations.size > 0) {
    const rows = repo.listSegmentsWithId(job.id).map((s) => ({
      startMs: s.startMs + job.rangeStartMs,
      endMs: s.endMs + job.rangeStartMs,
      en: translations.get(s.id) ?? '',
      ja: s.text,
    }));
    writeFileSync(`${base}.en.srt`, toSrt(rows.filter((r) => r.en.trim() !== '').map((r) => ({ ...r, text: r.en }))));
    writeFileSync(`${base}.bi.srt`, toBilingualSrt(rows));
    written.push(`${base}.en.srt`, `${base}.bi.srt`);
  }

  const summaries = stages.listSummaries(job.id);
  if (summaries.length > 0) {
    writeFileSync(`${base}.summary.md`, toSummaryMarkdown(summaries));
    written.push(`${base}.summary.md`);
  }
  return written;
}
