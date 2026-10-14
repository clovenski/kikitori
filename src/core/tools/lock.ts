import { readFileSync } from 'node:fs';

export interface LockEntry {
  id: string;
  version: string;
  url: string;
  sha256: string;
  kind: 'file' | 'zip';
  /** Path relative to the resources directory (a file for 'file', a folder for 'zip'). */
  dest: string;
}

export interface Lock {
  platform: 'win32-x64';
  tools: LockEntry[];
}

export function loadLock(file: string): Lock {
  return JSON.parse(readFileSync(file, 'utf8')) as Lock;
}
