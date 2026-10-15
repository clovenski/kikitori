import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installComponents,
  removeDamaged,
  uninstallComponents,
  type InstallProgress,
} from '../../src/core/setup/installer';
import { entryInstalled } from '../../src/core/setup/plan';
import type { LockComponent } from '../../src/core/tools/lock';

const bodies: Record<string, Buffer> = {
  '/a.bin': Buffer.alloc(40_000, 1),
  '/b.bin': Buffer.alloc(60_000, 2),
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let server: http.Server;
let base: string;
let res: string;
let hits: Record<string, number>;
let corrupt: Record<string, number>; // how many times to serve wrong bytes first

beforeEach(async () => {
  hits = {};
  corrupt = {};
  res = mkdtempSync(path.join(os.tmpdir(), 'bgt-inst-'));
  server = http.createServer((req, response) => {
    const url = req.url ?? '';
    hits[url] = (hits[url] ?? 0) + 1;
    const body = bodies[url];
    if (!body) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const out = (corrupt[url] ?? 0) >= hits[url] ? Buffer.alloc(body.length, 9) : body;
    response.setHeader('content-length', out.length);
    response.end(out);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(res, { recursive: true, force: true });
});

const component = (id: string, url: string, over: Partial<LockComponent['files'][number]> = {}): LockComponent => ({
  id,
  title: `Title ${id}`,
  features: ['core'],
  tier: 'all',
  license: 'MIT',
  homepage: 'https://example.com',
  files: [
    { id: `${id}-f`, version: '1', url: `${base}${url}`, sha256: sha(bodies[url]), size: bodies[url].length, kind: 'file', dest: `models/${id}.bin`, ...over },
  ],
});

const A = () => component('a', '/a.bin');
const B = () => component('b', '/b.bin');
const plenty = () => 10 ** 12;

describe('installComponents', () => {
  it('downloads what is missing, skips what is installed and reports progress up to the total', async () => {
    const events: InstallProgress[] = [];
    await installComponents({ components: [A()], resourcesDir: res, freeBytes: plenty, throttleMs: 0 });
    expect(hits['/a.bin']).toBe(1);
    await installComponents({ components: [A(), B()], resourcesDir: res, freeBytes: plenty, throttleMs: 0, onProgress: (p) => events.push(p) });
    expect(hits['/a.bin']).toBe(1);
    expect(hits['/b.bin']).toBe(1);
    expect(entryInstalled(B().files[0], res)).toBe(true);
    const last = events.at(-1) as InstallProgress;
    expect(last).toMatchObject({ componentId: 'b', fileIndex: 1, fileCount: 1, overallReceived: 60_000, overallTotal: 60_000 });
    const received = events.map((e) => e.overallReceived);
    expect([...received].sort((x, y) => x - y)).toEqual(received);
  });

  it('refuses before downloading anything when the disk is too small, naming the shortfall', async () => {
    await expect(
      installComponents({ components: [A(), B()], resourcesDir: res, freeBytes: () => 50_000 }),
    ).rejects.toMatchObject({ code: 'DownloadFailed', message: expect.stringMatching(/Not enough free disk space.*short by/) });
    expect(Object.keys(hits)).toHaveLength(0);
  });

  it('needs only the bytes still to download: no spare room for plain files, and partial downloads count', async () => {
    await installComponents({ components: [A(), B()], resourcesDir: res, freeBytes: () => 100_000 });
    expect(entryInstalled(B().files[0], res)).toBe(true);
    rmSync(path.join(res, 'models'), { recursive: true, force: true });
    mkdirSync(path.join(res, 'models'), { recursive: true });
    writeFileSync(path.join(res, 'models', 'a.bin.part'), bodies['/a.bin'].subarray(0, 30_000));
    await installComponents({ components: [A(), B()], resourcesDir: res, freeBytes: () => 70_000 });
    expect(entryInstalled(A().files[0], res)).toBe(true);
    expect(entryInstalled(B().files[0], res)).toBe(true);
  });

  it('downloads again once when the checksum does not match', async () => {
    corrupt['/a.bin'] = 1;
    await installComponents({ components: [A()], resourcesDir: res, freeBytes: plenty });
    expect(hits['/a.bin']).toBe(2);
    expect(readFileSync(path.join(res, 'models', 'a.bin')).equals(bodies['/a.bin'])).toBe(true);
  });

  it('gives up with a clear message after two corrupted downloads', async () => {
    corrupt['/a.bin'] = 2;
    await expect(installComponents({ components: [A()], resourcesDir: res, freeBytes: plenty })).rejects.toMatchObject({
      message: expect.stringContaining('corrupted in both downloads'),
    });
    expect(existsSync(path.join(res, 'models', 'a.bin'))).toBe(false);
  });

  it('stops when aborted and keeps the finished components', async () => {
    const controller = new AbortController();
    await expect(
      installComponents({
        components: [A(), B()],
        resourcesDir: res,
        freeBytes: plenty,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.componentId === 'b') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(entryInstalled(A().files[0], res)).toBe(true);
    expect(entryInstalled(B().files[0], res)).toBe(false);
  });
});

describe('uninstallComponents', () => {
  it('removes files, unpacked archive folders and leftovers', () => {
    const file = path.join(res, 'models', 'a.bin');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x');
    writeFileSync(`${file}.part`, 'x');
    mkdirSync(path.join(res, 'llama'), { recursive: true });
    writeFileSync(path.join(res, 'llama', 'llama-server.exe'), 'x');
    const archive = { ...A(), files: [{ ...A().files[0], id: 'zip', kind: 'zip' as const, dest: 'llama' }] };
    uninstallComponents([A(), archive], res);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.part`)).toBe(false);
    expect(existsSync(path.join(res, 'llama'))).toBe(false);
  });
});

describe('removeDamaged', () => {
  it('deletes files whose checksum is wrong, keeps good ones and never touches self-updating files', async () => {
    await installComponents({ components: [A(), B()], resourcesDir: res, freeBytes: plenty });
    writeFileSync(path.join(res, 'models', 'a.bin'), Buffer.alloc(40_000, 7)); // same size, wrong bytes
    const updating = component('c', '/a.bin', { selfUpdates: true });
    writeFileSync(path.join(res, 'models', 'c.bin'), 'replaced by yt-dlp -U');
    const removed = await removeDamaged([A(), B(), updating], res);
    expect(removed.map((e) => e.id)).toEqual(['a-f']);
    expect(existsSync(path.join(res, 'models', 'a.bin'))).toBe(false);
    expect(existsSync(path.join(res, 'models', 'b.bin'))).toBe(true);
    expect(existsSync(path.join(res, 'models', 'c.bin'))).toBe(true);
  });
});
