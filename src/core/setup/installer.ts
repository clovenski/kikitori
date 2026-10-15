import { existsSync, mkdirSync, rmSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { formatBytes } from '../bytes';
import { BgtError } from '../errors';
import { ChecksumError, fetchEntry, sha256File } from '../tools/fetch';
import type { LockComponent, LockEntry } from '../tools/lock';
import { entryInstalled } from './plan';

export interface InstallProgress {
  componentId: string;
  componentTitle: string;
  fileId: string;
  /** 1-based position among the files that still had to be downloaded. */
  fileIndex: number;
  fileCount: number;
  fileReceived: number;
  fileTotal: number;
  overallReceived: number;
  overallTotal: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

/** Free bytes on the drive that holds `dir` (or its nearest existing parent). */
export function freeDiskBytes(dir: string): number {
  let probe = path.resolve(dir);
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const s = statfsSync(probe);
  return Number(s.bavail) * Number(s.bsize);
}

export interface InstallOptions {
  components: LockComponent[];
  resourcesDir: string;
  signal?: AbortSignal;
  onProgress?(p: InstallProgress): void;
  log?(message: string): void;
  freeBytes?(dir: string): number;
  fetchImpl?: typeof fetchEntry;
  /** Minimum time between progress events (the last event of a file is always sent). */
  throttleMs?: number;
}

async function installEntry(
  fetchImpl: typeof fetchEntry,
  entry: LockEntry,
  resources: string,
  log: (m: string) => void,
  onProgress: (received: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fetchImpl(entry, resources, log, (received) => onProgress(received), signal);
      return;
    } catch (err) {
      if (!(err instanceof ChecksumError)) throw err;
      if (attempt === 1) {
        log(`${entry.id}: checksum mismatch, downloading it again`);
        continue;
      }
      throw new BgtError(
        'DownloadFailed',
        `${entry.id} was corrupted in both downloads. Try again later; the file on the server may have changed.`,
        { cause: err },
      );
    }
  }
}

/** Downloads and unpacks every file of `components` that is not installed yet, one at a time. */
export async function installComponents(o: InstallOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const fetchImpl = o.fetchImpl ?? fetchEntry;
  const throttleMs = o.throttleMs ?? 250;
  const work = o.components.flatMap((c) =>
    c.files.filter((f) => !entryInstalled(f, o.resourcesDir)).map((f) => ({ c, f })),
  );
  if (work.length === 0) return;

  const overallTotal = work.reduce((n, w) => n + w.f.size, 0);
  const need = overallTotal + Math.max(...work.map((w) => w.f.size)); // unpacking needs room next to the archive
  mkdirSync(o.resourcesDir, { recursive: true });
  const free = (o.freeBytes ?? freeDiskBytes)(o.resourcesDir);
  if (free < need) {
    throw new BgtError(
      'DownloadFailed',
      `Not enough free disk space: ${formatBytes(need)} needed, ${formatBytes(free)} free (short by ${formatBytes(need - free)}). Free some space and try again.`,
    );
  }

  const startedAt = Date.now();
  let session = 0;
  let finished = 0;
  let lastEmit = 0;
  for (let i = 0; i < work.length; i++) {
    const { c, f } = work[i];
    o.signal?.throwIfAborted();
    let lastReceived = -1;
    const report = (received: number, force: boolean) => {
      if (lastReceived >= 0) session += Math.max(0, received - lastReceived);
      lastReceived = received;
      const now = Date.now();
      if (!force && now - lastEmit < throttleMs) return;
      lastEmit = now;
      const bytesPerSecond = session / (Math.max(1, now - startedAt) / 1000);
      const overallReceived = finished + received;
      o.onProgress?.({
        componentId: c.id,
        componentTitle: c.title,
        fileId: f.id,
        fileIndex: i + 1,
        fileCount: work.length,
        fileReceived: received,
        fileTotal: f.size,
        overallReceived,
        overallTotal,
        bytesPerSecond: Math.round(bytesPerSecond),
        etaSeconds: bytesPerSecond > 1 ? Math.round((overallTotal - overallReceived) / bytesPerSecond) : null,
      });
    };
    report(0, true);
    await installEntry(fetchImpl, f, o.resourcesDir, log, (received) => report(received, false), o.signal);
    report(f.size, true);
    finished += f.size;
  }
}

/** Removes the files and unpacked folders of `components` (and any partial downloads). */
export function uninstallComponents(components: LockComponent[], resources: string): void {
  for (const c of components) {
    for (const f of c.files) {
      const dest = path.join(resources, f.dest);
      if (f.kind === 'zip') {
        rmSync(dest, { recursive: true, force: true });
        rmSync(path.join(resources, `${f.id}.zip`), { force: true });
        rmSync(path.join(resources, `${f.id}.zip.part`), { force: true });
      } else {
        rmSync(dest, { force: true });
        rmSync(`${dest}.part`, { force: true });
      }
    }
  }
}

/** Hashes installed model and data files and deletes the ones that do not match; returns what it deleted. */
export async function removeDamaged(
  components: LockComponent[],
  resources: string,
  signal?: AbortSignal,
  onFile?: (entry: LockEntry) => void,
): Promise<LockEntry[]> {
  const removed: LockEntry[] = [];
  for (const c of components) {
    for (const f of c.files) {
      if (f.kind !== 'file' || f.selfUpdates) continue;
      const file = path.join(resources, f.dest);
      if (!existsSync(file)) continue;
      signal?.throwIfAborted();
      onFile?.(f);
      if ((await sha256File(file)) !== f.sha256) {
        rmSync(file, { force: true });
        removed.push(f);
      }
    }
  }
  return removed;
}
