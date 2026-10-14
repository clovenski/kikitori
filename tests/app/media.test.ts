import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMediaUrl, resolveMediaPath } from '../../src/app/main/media';
import { memoryRepos } from '../helpers/fakes';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-media-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settings = { model: 'large-v3', language: 'ja', maxMinutes: 30 };

describe('resolveMediaPath', () => {
  it('returns the source of an existing local-file job', () => {
    const { repo } = memoryRepos();
    const file = path.join(dir, 'clip.wav');
    writeFileSync(file, 'x');
    const job = repo.createJob({ source: file, rangeStartMs: 0, rangeEndMs: 1, settings });
    expect(resolveMediaPath(repo, job.id)).toBe(file);
  });

  it('refuses unknown ids, URL sources, deleted files and non-numeric ids', () => {
    const { repo } = memoryRepos();
    const url = repo.createJob({ source: 'https://www.youtube.com/watch?v=7SHNxjFuw10', rangeStartMs: 0, rangeEndMs: 1, settings });
    const gone = repo.createJob({ source: path.join(dir, 'missing.wav'), rangeStartMs: 0, rangeEndMs: 1, settings });
    expect(resolveMediaPath(repo, 999)).toBeNull();
    expect(resolveMediaPath(repo, url.id)).toBeNull();
    expect(resolveMediaPath(repo, gone.id)).toBeNull();
    for (const bad of ['1', '../../etc/passwd', -1, 0, 1.5, null, undefined, NaN]) {
      expect(resolveMediaPath(repo, bad)).toBeNull();
    }
  });
});

describe('parseMediaUrl', () => {
  it('extracts the job id from bgt-media://job/<id> only', () => {
    expect(parseMediaUrl('bgt-media://job/12')).toBe(12);
    expect(parseMediaUrl('bgt-media://job/12?x=1')).toBe(12);
    for (const bad of ['bgt-media://other/12', 'bgt-media://job/abc', 'bgt-media://job/', 'bgt-media://job/1/2', 'https://job/1', 'nonsense']) {
      expect(parseMediaUrl(bad)).toBeNull();
    }
  });
});
