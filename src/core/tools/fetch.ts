import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import extract from 'extract-zip';
import { BgtError } from '../errors';
import { downloadResumable } from '../setup/download';
import { markerPath, type LockEntry } from './lock';

export class ChecksumError extends BgtError {
  constructor(message: string) {
    super('DownloadFailed', message);
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadResumable(url, dest, { onProgress, signal });
}

async function verified(file: string, entry: LockEntry): Promise<void> {
  const actual = await sha256File(file);
  if (actual !== entry.sha256) {
    rmSync(file, { force: true });
    throw new ChecksumError(`Checksum mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}.`);
  }
}

export async function fetchEntry(
  entry: LockEntry,
  resources: string,
  log: (message: string) => void,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const dest = path.join(resources, entry.dest);

  if (entry.kind === 'file') {
    if (existsSync(dest) && (await sha256File(dest)) === entry.sha256) {
      log(`${entry.id}: up to date`);
      return;
    }
    log(`${entry.id}: downloading ${entry.version}`);
    await downloadFile(entry.url, dest, onProgress, signal);
    await verified(dest, entry);
    return;
  }

  const marker = markerPath(entry, resources);
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === entry.sha256) {
    log(`${entry.id}: up to date`);
    return;
  }
  log(`${entry.id}: downloading ${entry.version}`);
  const zip = path.join(resources, `${entry.id}.zip`);
  await downloadFile(entry.url, zip, onProgress, signal);
  await verified(zip, entry);
  if (!entry.merge) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  try {
    await extract(zip, { dir: path.resolve(dest) });
  } catch (err) {
    rmSync(zip, { force: true });
    if (!entry.merge) rmSync(dest, { recursive: true, force: true });
    throw new BgtError('DownloadFailed', `Could not unpack ${entry.id}: ${err instanceof Error ? err.message : err}`, { cause: err });
  }
  writeFileSync(marker, entry.sha256);
  rmSync(zip, { force: true });
}
