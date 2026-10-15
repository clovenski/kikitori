import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../errors';

export type Tier = 'gpu' | 'cpu';
export type Feature = 'core' | 'transcription' | 'translation' | 'summaries';

export interface LockEntry {
  id: string;
  version: string;
  url: string;
  sha256: string;
  /** Bytes of the download. */
  size: number;
  kind: 'file' | 'zip';
  /** Path relative to the resources directory (a file for 'file', a folder for 'zip'). */
  dest: string;
  /** zip only: extract into `dest` without wiping what other archives put there. */
  merge?: boolean;
  /** The program replaces itself (yt-dlp -U), so a changed size or checksum is not damage. */
  selfUpdates?: boolean;
}

export interface LockComponent {
  id: string;
  title: string;
  features: Feature[];
  tier: 'all' | Tier;
  license: string;
  homepage: string;
  files: LockEntry[];
}

export interface Lock {
  platform: 'win32-x64';
  components: LockComponent[];
}

export function loadLock(file: string): Lock {
  const lock = JSON.parse(readFileSync(file, 'utf8')) as Partial<Lock>;
  if (!Array.isArray(lock.components)) {
    throw new BgtError('InvalidInput', `${file} is in an old format. Run "pnpm pin:tools --update".`);
  }
  return lock as Lock;
}

/** Lists everything wrong with a lock (empty when it is fine). */
export function validateLock(lock: Lock): string[] {
  const problems: string[] = [];
  const componentIds = new Set<string>();
  const fileIds = new Set<string>();
  if (lock.platform !== 'win32-x64') problems.push('platform must be win32-x64');
  for (const c of lock.components) {
    if (componentIds.has(c.id)) problems.push(`duplicate component ${c.id}`);
    componentIds.add(c.id);
    for (const key of ['title', 'license', 'homepage'] as const) {
      if (!c[key]?.trim()) problems.push(`${c.id}: missing ${key}`);
    }
    if (c.features.length === 0) problems.push(`${c.id}: no features`);
    if (c.files.length === 0) problems.push(`${c.id}: no files`);
    for (const f of c.files) {
      if (fileIds.has(f.id)) problems.push(`${c.id}: duplicate file id ${f.id}`);
      fileIds.add(f.id);
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) problems.push(`${f.id}: sha256 is not 64 hex characters`);
      if (!Number.isInteger(f.size) || f.size <= 0) problems.push(`${f.id}: size must be a positive integer`);
      if (!f.url.startsWith('https://')) problems.push(`${f.id}: url must use https`);
      if (path.isAbsolute(f.dest) || f.dest.split(/[\\/]/).includes('..')) {
        problems.push(`${f.id}: dest must stay inside the resources folder`);
      }
    }
  }
  return problems;
}

export const allEntries = (lock: Lock): LockEntry[] => lock.components.flatMap((c) => c.files);

export function findComponent(lock: Lock, id: string): LockComponent {
  const component = lock.components.find((c) => c.id === id);
  if (!component) throw new BgtError('ToolMissing', `"${id}" is not listed in tools.lock.json. Run "pnpm pin:tools".`);
  return component;
}

export const componentBytes = (c: LockComponent): number => c.files.reduce((n, f) => n + f.size, 0);

/** The file recording which archive is unpacked in a zip entry's folder. */
export function markerPath(entry: LockEntry, resources: string): string {
  return path.join(resources, entry.dest, entry.merge ? `.${entry.id}.sha256` : '.sha256');
}

/** Path of the first file of a model component; it must exist. */
export function componentModelPath(lock: Lock, componentId: string, resources: string): string {
  const file = path.join(resources, findComponent(lock, componentId).files[0].dest);
  if (!existsSync(file)) {
    throw new BgtError(
      'ToolMissing',
      `Model file ${file} is missing. Install it from the Tools page (or run "pnpm setup:tools" in a development checkout).`,
    );
  }
  return file;
}
