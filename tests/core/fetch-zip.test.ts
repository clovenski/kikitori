import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchEntry } from '../../src/core/tools/fetch';
import type { LockEntry } from '../../src/core/tools/lock';

/** Minimal "stored" (uncompressed) zip writer, enough for extract-zip. */
function makeZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const zips: Record<string, Buffer> = {
  '/main.zip': makeZip([{ name: 'llama-server.exe', data: 'server' }]),
  '/cudart.zip': makeZip([{ name: 'cudart64.dll', data: 'dll' }]),
  '/bad.zip': Buffer.from('this is not a zip'),
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let server: http.Server;
let base: string;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-zip-'));
  server = http.createServer((req, res) => {
    const body = zips[req.url ?? ''];
    if (!body) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-length', body.length);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const entry = (id: string, url: string, over: Partial<LockEntry> = {}): LockEntry => ({
  id,
  version: '1',
  url: `${base}${url}`,
  sha256: sha(zips[url]),
  size: zips[url].length,
  kind: 'zip',
  dest: 'llama',
  ...over,
});

describe('fetchEntry zip merge', () => {
  it('extracts a zip and skips it when its marker matches', async () => {
    await fetchEntry(entry('main', '/main.zip'), dir, () => {});
    expect(readFileSync(path.join(dir, 'llama', 'llama-server.exe'), 'utf8')).toBe('server');
    expect(existsSync(path.join(dir, 'llama', '.sha256'))).toBe(true);
  });

  it('merges a second archive into the same folder without wiping the first', async () => {
    await fetchEntry(entry('main', '/main.zip', { merge: true }), dir, () => {});
    await fetchEntry(entry('cudart', '/cudart.zip', { merge: true }), dir, () => {});
    expect(existsSync(path.join(dir, 'llama', 'llama-server.exe'))).toBe(true);
    expect(existsSync(path.join(dir, 'llama', 'cudart64.dll'))).toBe(true);
    expect(existsSync(path.join(dir, 'llama', '.cudart.sha256'))).toBe(true);
  });

  it('reports an archive that cannot be unpacked and leaves no marker or leftovers', async () => {
    await expect(fetchEntry(entry('bad', '/bad.zip'), dir, () => {})).rejects.toThrow(/Could not unpack bad/);
    expect(existsSync(path.join(dir, 'llama', '.sha256'))).toBe(false);
    expect(existsSync(path.join(dir, 'bad.zip'))).toBe(false);
  });

  it('a non-merge zip still replaces the destination', async () => {
    await fetchEntry(entry('main', '/main.zip', { merge: true }), dir, () => {});
    await fetchEntry(entry('cudart', '/cudart.zip'), dir, () => {});
    expect(existsSync(path.join(dir, 'llama', 'llama-server.exe'))).toBe(false);
    expect(existsSync(path.join(dir, 'llama', 'cudart64.dll'))).toBe(true);
  });
});
