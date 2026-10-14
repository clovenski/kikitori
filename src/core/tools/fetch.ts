import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import extract from 'extract-zip';
import { BgtError } from '../errors';
import type { LockEntry } from './lock';

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'bg-auto-translator' } });
  if (!res.ok || !res.body) {
    throw new BgtError('DownloadFailed', `GET ${url} failed with HTTP ${res.status}.`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const part = `${dest}.part`;
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      onProgress?.(received, total);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream),
    counter,
    createWriteStream(part),
  );
  renameSync(part, dest);
}

async function verified(file: string, entry: LockEntry): Promise<void> {
  const actual = await sha256File(file);
  if (actual !== entry.sha256) {
    rmSync(file, { force: true });
    throw new BgtError(
      'DownloadFailed',
      `Checksum mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}.`,
    );
  }
}

export async function fetchEntry(
  entry: LockEntry,
  resources: string,
  log: (message: string) => void,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  const dest = path.join(resources, entry.dest);

  if (entry.kind === 'file') {
    if (existsSync(dest) && (await sha256File(dest)) === entry.sha256) {
      log(`${entry.id}: up to date`);
      return;
    }
    log(`${entry.id}: downloading ${entry.version}`);
    await downloadFile(entry.url, dest, onProgress);
    await verified(dest, entry);
    return;
  }

  const marker = path.join(dest, '.sha256');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === entry.sha256) {
    log(`${entry.id}: up to date`);
    return;
  }
  log(`${entry.id}: downloading ${entry.version}`);
  const zip = path.join(resources, `${entry.id}.zip`);
  await downloadFile(entry.url, zip, onProgress);
  await verified(zip, entry);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  await extract(zip, { dir: path.resolve(dest) });
  writeFileSync(marker, entry.sha256);
  rmSync(zip, { force: true });
}
