import { writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Repo } from '../../src/core/db/repo';
import { migrate } from '../../src/core/db/schema';
import type { SilenceInterval } from '../../src/core/pipeline/chunker';
import type { FetchAudioArgs, PipelineDeps } from '../../src/core/pipeline/run';
import type { Segment } from '../../src/core/types';

export function memoryRepo(): Repo {
  const db = new Database(':memory:');
  migrate(db);
  return new Repo(db);
}

export interface FakeOptions {
  durationMs: number;
  silences?: SilenceInterval[];
  /** Ground-truth segments in audio-relative ms; chunks return the ones fully inside their range. */
  truth?: Segment[];
  /** Called before each transcription; throw to simulate failure or abort. */
  onTranscribe?: (chunkFile: string, callNumber: number) => void;
}

export interface Fakes {
  deps: PipelineDeps;
  transcribed: string[];
  fetchCalls: FetchAudioArgs[];
}

export function makeFakeDeps(repo: Repo, opts: FakeOptions): Fakes {
  const ranges = new Map<string, { startMs: number; endMs: number }>();
  const transcribed: string[] = [];
  const fetchCalls: FetchAudioArgs[] = [];

  const deps: PipelineDeps = {
    repo,
    log: () => {},
    perf: { read: () => null, write: () => {} },
    probeDurationMs: async () => opts.durationMs,
    fetchAudio: async (a) => {
      fetchCalls.push(a);
      writeFileSync(a.outWavPath, 'fake-audio');
    },
    detectSilences: async () => opts.silences ?? [],
    cutWav: async (a) => {
      writeFileSync(a.outPath, 'fake-chunk');
      ranges.set(a.outPath, { startMs: a.startMs, endMs: a.endMs });
    },
    transcriber: {
      transcribe: async (audioPath) => {
        const file = path.basename(audioPath);
        transcribed.push(file);
        opts.onTranscribe?.(file, transcribed.filter((f) => f === file).length);
        const range = ranges.get(audioPath) as { startMs: number; endMs: number };
        return (opts.truth ?? [])
          .filter((s) => s.startMs >= range.startMs && s.endMs <= range.endMs)
          .map((s) => ({ ...s, startMs: s.startMs - range.startMs, endMs: s.endMs - range.startMs }));
      },
    },
  };
  return { deps, transcribed, fetchCalls };
}
