import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMediaResponse, parseMediaUrl, parseRange, resolveMediaPath } from '../../src/app/main/media';
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

describe('parseRange', () => {
  it('parses open, closed and suffix ranges and clamps the end to the file size', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('is unsatisfiable when the start is past the end of the file or the range is empty', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=500-100', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });

  it('ignores missing, malformed and multi-range headers (the whole file is served)', () => {
    for (const h of [null, '', 'bytes=', 'items=0-5', 'bytes=a-b', 'bytes=0-5,10-20', 'garbage']) {
      expect(parseRange(h, 1000)).toBeNull();
    }
  });
});

describe('buildMediaResponse', () => {
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

  it('serves the whole file with Accept-Ranges when there is no Range header', async () => {
    const file = path.join(dir, 'clip.mp4');
    writeFileSync(file, bytes);
    const res = await buildMediaResponse(file, null);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it('answers a Range request with 206, Content-Range and exactly the requested bytes', async () => {
    const file = path.join(dir, 'a folder with spaces', 'クリップ #1.mp4');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    const res = await buildMediaResponse(file, 'bytes=100-199');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(100, 200));
  });

  it('answers 416 with the file size for an unsatisfiable range', async () => {
    const file = path.join(dir, 'clip.wav');
    writeFileSync(file, bytes);
    const res = await buildMediaResponse(file, 'bytes=5000-');
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  it('picks a content type from the extension and falls back to octet-stream', async () => {
    const a = path.join(dir, 'a.m4a');
    const b = path.join(dir, 'b.unknownext');
    writeFileSync(a, 'x');
    writeFileSync(b, 'x');
    expect((await buildMediaResponse(a, null)).headers.get('content-type')).toBe('audio/mp4');
    expect((await buildMediaResponse(b, null)).headers.get('content-type')).toBe('application/octet-stream');
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
