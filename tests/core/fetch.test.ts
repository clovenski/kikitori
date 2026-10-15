import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadFile, fetchEntry, sha256File } from '../../src/core/tools/fetch';
import type { LockEntry } from '../../src/core/tools/lock';

const payload = Buffer.from('hello model bytes');
const payloadSha = createHash('sha256').update(payload).digest('hex');

let server: http.Server;
let base: string;
let hits = 0;
let dir: string;

beforeEach(async () => {
  hits = 0;
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-fetch-'));
  server = http.createServer((_req, res) => {
    hits++;
    res.setHeader('content-length', payload.length);
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<LockEntry> = {}): LockEntry => ({
  id: 'model',
  version: '1',
  url: `${base}/m.bin`,
  sha256: payloadSha,
  size: payload.length,
  kind: 'file',
  dest: 'models/m.bin',
  ...overrides,
});

describe('downloadFile / sha256File', () => {
  it('downloads atomically and reports progress', async () => {
    const dest = path.join(dir, 'a', 'm.bin');
    const seen: number[] = [];
    await downloadFile(`${base}/m.bin`, dest, (received) => seen.push(received));
    expect(readFileSync(dest)).toEqual(payload);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(payload.length);
    expect(await sha256File(dest)).toBe(payloadSha);
  });
});

describe('fetchEntry', () => {
  it('downloads a file, then skips it when the checksum already matches', async () => {
    const log = () => {};
    await fetchEntry(entry(), dir, log);
    expect(readFileSync(path.join(dir, 'models', 'm.bin'))).toEqual(payload);
    expect(hits).toBe(1);
    await fetchEntry(entry(), dir, log);
    expect(hits).toBe(1);
  });

  it('rejects and removes a download whose checksum does not match', async () => {
    await expect(fetchEntry(entry({ sha256: 'deadbeef' }), dir, () => {})).rejects.toThrow(/checksum/i);
    expect(existsSync(path.join(dir, 'models', 'm.bin'))).toBe(false);
    expect(existsSync(path.join(dir, 'models', 'm.bin.part'))).toBe(false);
  });
});
