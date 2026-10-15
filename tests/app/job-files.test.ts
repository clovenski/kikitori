import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteJobFiles } from '../../src/app/main/job-files';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ktr-jobfiles-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('deleteJobFiles', () => {
  it("removes the job's outputs and work folder but not other jobs' or foreign files", () => {
    const outDir = path.join(root, 'out');
    const workRoot = path.join(root, 'work');
    mkdirSync(outDir);
    mkdirSync(path.join(workRoot, '1'), { recursive: true });
    mkdirSync(path.join(workRoot, '12'), { recursive: true });
    for (const f of ['job-1.ja.srt', 'job-1.ja.json', 'job-1.en.srt', 'job-1.bi.srt', 'job-1.summary.md', 'job-12.ja.srt', 'job-1x.txt', 'notes.txt']) {
      writeFileSync(path.join(outDir, f), 'x');
    }
    writeFileSync(path.join(workRoot, '1', 'audio.wav'), 'x');
    deleteJobFiles({ outDir, workRoot }, 1);
    expect(readdirSync(outDir).sort()).toEqual(['job-12.ja.srt', 'job-1x.txt', 'notes.txt']);
    expect(existsSync(path.join(workRoot, '1'))).toBe(false);
    expect(existsSync(path.join(workRoot, '12'))).toBe(true);
  });

  it('does nothing when the folders do not exist', () => {
    expect(() => deleteJobFiles({ outDir: path.join(root, 'nope'), workRoot: path.join(root, 'nope2') }, 5)).not.toThrow();
  });
});
