import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BgtError } from '../../src/core/errors';
import { downloadResumable } from '../../src/core/setup/download';

const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));

interface Behavior {
  ignoreRange?: boolean;
  /** Close the connection after this many bytes, on the first request only. */
  dropAfter?: number;
  /** Send this many bytes, then go silent, on the first request only. */
  stallAfter?: number;
  status?: number;
}
let server: http.Server;
let base: string;
let dir: string;
let behavior: Behavior;
let requests: { range: string | undefined }[];

beforeEach(async () => {
  behavior = {};
  requests = [];
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-dl-'));
  server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range });
    const first = requests.length === 1;
    if (behavior.status) {
      res.statusCode = behavior.status;
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = match && !behavior.ignoreRange ? Number(match[1]) : 0;
    if (start >= payload.length) {
      res.statusCode = 416;
      res.end();
      return;
    }
    const body = payload.subarray(start);
    res.statusCode = start > 0 ? 206 : 200;
    res.setHeader('content-length', body.length);
    if (start > 0) res.setHeader('content-range', `bytes ${start}-${payload.length - 1}/${payload.length}`);
    if (first && behavior.dropAfter !== undefined) {
      res.write(body.subarray(0, behavior.dropAfter));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    if (first && behavior.stallAfter !== undefined) {
      res.write(body.subarray(0, behavior.stallAfter)); // then never end
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const opts = { backoffMs: 1, attempts: 3 };

describe('downloadResumable', () => {
  it('downloads atomically and reports progress up to the total', async () => {
    const dest = path.join(dir, 'a', 'f.bin');
    const seen: [number, number][] = [];
    await downloadResumable(`${base}/f`, dest, { ...opts, onProgress: (r, t) => seen.push([r, t]) });
    expect(readFileSync(dest).equals(payload)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toEqual([payload.length, payload.length]);
  });

  it('resumes from an existing .part with a Range request', async () => {
    const dest = path.join(dir, 'f.bin');
    writeFileSync(`${dest}.part`, payload.subarray(0, 1000));
    await downloadResumable(`${base}/f`, dest, opts);
    expect(requests[0].range).toBe('bytes=1000-');
    expect(readFileSync(dest).equals(payload)).toBe(true);
  });

  it('starts over when the server ignores Range and answers 200', async () => {
    behavior.ignoreRange = true;
    const dest = path.join(dir, 'f.bin');
    writeFileSync(`${dest}.part`, payload.subarray(0, 1000));
    await downloadResumable(`${base}/f`, dest, opts);
    expect(readFileSync(dest).equals(payload)).toBe(true);
  });

  it('starts over after a 416 for a part that is not usable', async () => {
    const dest = path.join(dir, 'f.bin');
    writeFileSync(`${dest}.part`, Buffer.concat([payload, Buffer.from('extra')]));
    await downloadResumable(`${base}/f`, dest, opts);
    expect(readFileSync(dest).equals(payload)).toBe(true);
  });

  it('retries and resumes after the connection drops half way', async () => {
    behavior.dropAfter = 120_000;
    const dest = path.join(dir, 'f.bin');
    await downloadResumable(`${base}/f`, dest, opts);
    expect(readFileSync(dest).equals(payload)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].range).toMatch(/^bytes=\d+-$/);
  });

  it('retries a stalled connection', async () => {
    behavior.stallAfter = 50_000;
    const dest = path.join(dir, 'f.bin');
    await downloadResumable(`${base}/f`, dest, { ...opts, stallMs: 150 });
    expect(readFileSync(dest).equals(payload)).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('fails at once on an HTTP error, without retrying', async () => {
    behavior.status = 404;
    await expect(downloadResumable(`${base}/f`, path.join(dir, 'f.bin'), opts)).rejects.toMatchObject({
      code: 'DownloadFailed',
      message: expect.stringContaining('HTTP 404'),
    });
    expect(requests).toHaveLength(1);
  });

  it('verifies the finished .part before renaming it, and does not retry a rejected one', async () => {
    const dest = path.join(dir, 'f.bin');
    let seen = 0;
    const verify = async (part: string) => {
      seen = readFileSync(part).length;
      expect(existsSync(dest)).toBe(false);
      throw new BgtError('DownloadFailed', 'bad checksum');
    };
    await expect(downloadResumable(`${base}/f`, dest, { ...opts, verify })).rejects.toThrow('bad checksum');
    expect(seen).toBe(payload.length);
    expect(existsSync(dest)).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it('says to check the internet connection when the server cannot be reached', async () => {
    await new Promise((resolve) => server.close(resolve));
    await expect(downloadResumable(`${base}/f`, path.join(dir, 'f.bin'), { ...opts, attempts: 2 })).rejects.toMatchObject({
      code: 'DownloadFailed',
      message: expect.stringMatching(/Could not download 127\.0\.0\.1.*internet connection/),
    });
  });

  it('stops on abort and keeps the .part for next time', async () => {
    behavior.stallAfter = 50_000;
    const controller = new AbortController();
    const dest = path.join(dir, 'f.bin');
    const run = downloadResumable(`${base}/f`, dest, { ...opts, signal: controller.signal, stallMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(`${dest}.part`)).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });
});
