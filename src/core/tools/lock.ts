import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../errors';

export interface LockEntry {
  id: string;
  version: string;
  url: string;
  sha256: string;
  kind: 'file' | 'zip';
  /** Path relative to the resources directory (a file for 'file', a folder for 'zip'). */
  dest: string;
  /** zip only: extract into `dest` without wiping what other archives put there. */
  merge?: boolean;
}

export interface Lock {
  platform: 'win32-x64';
  tools: LockEntry[];
}

export function loadLock(file: string): Lock {
  return JSON.parse(readFileSync(file, 'utf8')) as Lock;
}

export function lockedModelPath(id: string, lock: Lock, resources: string): string {
  const entry = lock.tools.find((t) => t.id === id);
  if (!entry) throw new BgtError('ToolMissing', `"${id}" is not listed in tools.lock.json. Run "pnpm pin:tools".`);
  const file = path.join(resources, entry.dest);
  if (!existsSync(file)) throw new BgtError('ToolMissing', `Model file ${file} is missing. Run "pnpm setup:tools".`);
  return file;
}
