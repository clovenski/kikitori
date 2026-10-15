import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** Removes what the pipeline wrote for a job: `job-<id>.*` in the output folder and its work folder. The source media is never touched. */
export function deleteJobFiles(dirs: { outDir: string; workRoot: string }, jobId: number): void {
  const prefix = `job-${jobId}.`;
  let names: string[] = [];
  try {
    names = readdirSync(dirs.outDir);
  } catch {
    // no output folder yet: nothing was written
  }
  for (const name of names) {
    if (name.startsWith(prefix)) rmSync(path.join(dirs.outDir, name), { force: true });
  }
  rmSync(path.join(dirs.workRoot, String(jobId)), { recursive: true, force: true });
}
