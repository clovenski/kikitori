import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findComponent, markerPath, type Lock, type LockComponent, type LockEntry } from '../../src/core/tools/lock';

export const ALL_COMPONENT_IDS = [
  'yt-dlp',
  'ffmpeg',
  'vad',
  'whisper-gpu',
  'whisper-cpu',
  'model-transcribe-gpu',
  'model-transcribe-cpu',
  'llama-gpu',
  'llama-cpu',
  'model-translate-gpu',
  'model-translate-cpu',
  'model-general-gpu',
  'model-general-cpu',
] as const;

const ZIPS: Record<string, string> = {
  ffmpeg: 'ffmpeg',
  'whisper-gpu': 'whisper',
  'whisper-cpu': 'whisper',
  'llama-gpu': 'llama',
  'llama-cpu': 'llama',
};

/** A lock with every component the app knows, one small file each; archives use the real folder names. */
export function fakeLock(size = 10): Lock {
  return {
    platform: 'win32-x64',
    components: ALL_COMPONENT_IDS.map((id): LockComponent => {
      const zip = ZIPS[id];
      const file: LockEntry = {
        id: `${id}-file`,
        version: '1',
        url: `https://example.com/${id}`,
        // Distinct per component, like real pins: whisper-gpu and whisper-cpu share a folder and a marker file name.
        sha256: createHash('sha256').update(id).digest('hex'),
        size,
        kind: zip ? 'zip' : 'file',
        dest: zip ?? (id === 'yt-dlp' ? 'bin/yt-dlp.exe' : `models/${id}.bin`),
        ...(id === 'yt-dlp' ? { selfUpdates: true } : {}),
      };
      return {
        id,
        title: `Title of ${id}`,
        features: ['core'],
        tier: id.endsWith('-gpu') ? 'gpu' : id.endsWith('-cpu') ? 'cpu' : 'all',
        license: 'MIT',
        homepage: 'https://example.com',
        files: [file],
      };
    }),
  };
}

/** Creates the on-disk state of an installed component (right-sized file, or the unpack marker). */
export function installFake(lock: Lock, resources: string, ids: readonly string[]): void {
  for (const id of ids) {
    for (const f of findComponent(lock, id).files) {
      if (f.kind === 'zip') {
        const marker = markerPath(f, resources);
        mkdirSync(path.dirname(marker), { recursive: true });
        writeFileSync(marker, f.sha256);
      } else {
        const file = path.join(resources, f.dest);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, Buffer.alloc(f.size));
      }
    }
  }
}
