import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatBytes } from '../bytes';
import { BgtError } from '../errors';
import { findComponent, markerPath, type Lock, type LockComponent, type LockEntry, type Tier } from '../tools/lock';
import { requiredComponentIds, type Wants } from './components';

/** A file counts when it exists with the pinned size; an archive when its marker matches the pinned checksum. */
export function entryInstalled(e: LockEntry, resources: string): boolean {
  if (e.kind === 'zip') {
    const marker = markerPath(e, resources);
    return existsSync(marker) && readFileSync(marker, 'utf8').trim() === e.sha256;
  }
  const file = path.join(resources, e.dest);
  if (!existsSync(file)) return false;
  return e.selfUpdates === true || statSync(file).size === e.size;
}

/** Where a download of this entry is kept until it is complete. */
export const partialPath = (e: LockEntry, resources: string): string =>
  e.kind === 'zip' ? path.join(resources, `${e.id}.zip.part`) : `${path.join(resources, e.dest)}.part`;

/**
 * Disk space an install of `components` needs: what is still to download (minus partial downloads already on disk)
 * plus room to unpack the largest archive next to its zip.
 */
export function requiredFreeBytes(components: LockComponent[], resources: string): number {
  const todo = components.flatMap((c) => c.files).filter((f) => !entryInstalled(f, resources));
  if (todo.length === 0) return 0;
  const partial = (f: LockEntry) => {
    const part = partialPath(f, resources);
    return existsSync(part) ? Math.min(statSync(part).size, f.size) : 0;
  };
  const left = todo.reduce((n, f) => n + f.size - partial(f), 0);
  const largestArchive = Math.max(0, ...todo.filter((f) => f.kind === 'zip').map((f) => f.size));
  return left + largestArchive;
}

export const componentInstalled = (c: LockComponent, resources: string): boolean =>
  c.files.every((f) => entryInstalled(f, resources));

export interface SetupPlan {
  /** Everything the selection needs, in install order. */
  required: LockComponent[];
  /** The part of `required` that is not installed yet. */
  missing: LockComponent[];
  /** Bytes still to download (installed files of a half-installed component are not counted). */
  missingBytes: number;
}

export function buildPlan(lock: Lock, tier: Tier, wants: Wants, resources: string): SetupPlan {
  const required = requiredComponentIds(tier, wants).map((id) => findComponent(lock, id));
  const missing = required.filter((c) => !componentInstalled(c, resources));
  const missingBytes = missing
    .flatMap((c) => c.files)
    .filter((f) => !entryInstalled(f, resources))
    .reduce((n, f) => n + f.size, 0);
  return { required, missing, missingBytes };
}

/** Throws SetupRequired when something the selection needs is not installed. */
export function ensureInstalled(lock: Lock, tier: Tier, wants: Wants, resources: string): void {
  const plan = buildPlan(lock, tier, wants, resources);
  if (plan.missing.length === 0) return;
  throw new BgtError(
    'SetupRequired',
    `Download ${plan.missing.map((c) => c.title).join(', ')} (${formatBytes(plan.missingBytes)}) first. Open Tools to install it.`,
  );
}
