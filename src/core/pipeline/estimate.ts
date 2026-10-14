import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function estimateSeconds(audioMs: number, speedFactor: number | null): number | null {
  if (!speedFactor || speedFactor <= 0) return null;
  return Math.ceil(audioMs / 1000 / speedFactor);
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export interface PerfStore {
  read(): number | null;
  write(speedFactor: number): void;
}

/** Stores audio-seconds transcribed per wall-clock second, measured on previous runs. */
export function createPerfStore(file: string): PerfStore {
  return {
    read() {
      try {
        const value = (JSON.parse(readFileSync(file, 'utf8')) as { speedFactor?: unknown }).speedFactor;
        return typeof value === 'number' && value > 0 ? value : null;
      } catch {
        return null;
      }
    },
    write(speedFactor) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ speedFactor }));
    },
  };
}
