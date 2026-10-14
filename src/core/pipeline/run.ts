import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { JobRow, Repo } from '../db/repo';
import type { Transcriber } from '../interfaces';
import { formatClock, resolveRange } from '../time';
import type { ProgressEvent } from '../progress';
import { parseYoutubeId } from '../youtube';
import { CHUNK_DEFAULTS, planChunks, type SilenceInterval } from './chunker';
import { estimateSeconds, formatDuration, type PerfStore } from './estimate';
import { writeOutputs } from './outputs';
import { dropOverlapping, filterHallucinations } from './segment-cleanup';

export const MAX_ATTEMPTS = 3;

export interface FetchAudioArgs {
  source: string;
  startMs: number;
  endMs: number;
  fullDurationMs: number;
  workDir: string;
  /** The implementation must write a complete 16 kHz mono WAV covering exactly [startMs, endMs] here. */
  outWavPath: string;
  signal?: AbortSignal;
}

export interface PipelineDeps {
  repo: Repo;
  transcriber: Transcriber;
  perf: PerfStore;
  log(message: string): void;
  progress?(e: ProgressEvent): void;
  probe(source: string, signal?: AbortSignal): Promise<{ durationMs: number; title: string | null }>;
  fetchAudio(a: FetchAudioArgs): Promise<void>;
  detectSilences(wavPath: string, totalMs: number, signal?: AbortSignal): Promise<SilenceInterval[]>;
  cutWav(a: {
    wavPath: string;
    startMs: number;
    endMs: number;
    outPath: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export interface RunParams {
  source: string;
  startMs: number;
  endMs: number | null;
  maxMinutes: number;
  model: string;
  language: string;
  workRoot: string;
  outDir: string;
  keepWork: boolean;
  signal?: AbortSignal;
  /** Called once the job row exists (created or resumed), before any work starts. */
  onJob?(job: JobRow): void;
}

export interface RunResult {
  jobId: number;
  status: 'done' | 'failed';
  failedChunks: number[];
  srtPath: string;
  jsonPath: string;
}

async function processChunk(
  deps: PipelineDeps,
  params: RunParams,
  job: JobRow,
  chunk: { idx: number; startMs: number; endMs: number },
  workDir: string,
): Promise<boolean> {
  const { repo, log } = deps;
  const chunkWav = path.join(workDir, `chunk-${String(chunk.idx).padStart(3, '0')}.wav`);
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    params.signal?.throwIfAborted();
    repo.markChunkRunning(job.id, chunk.idx);
    try {
      await deps.cutWav({
        wavPath: path.join(workDir, 'audio.wav'),
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        outPath: chunkWav,
        signal: params.signal,
      });
      const raw = await deps.transcriber.transcribe(chunkWav, {
        language: params.language,
        signal: params.signal,
      });
      const shifted = raw.map((s) => ({
        ...s,
        startMs: s.startMs + chunk.startMs,
        endMs: s.endMs + chunk.startMs,
      }));
      const cutoff = repo.maxSegmentEndBefore(job.id, chunk.idx);
      const deduped = cutoff === null ? shifted : dropOverlapping(shifted, cutoff);
      repo.completeChunk(job.id, chunk.idx, filterHallucinations(deduped));
      return true;
    } catch (err) {
      if (params.signal?.aborted) {
        repo.markChunkPending(job.id, chunk.idx);
        throw err;
      }
      lastError = err instanceof Error ? err.message : String(err);
      log(`Chunk ${chunk.idx + 1}: attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError}`);
    }
  }
  repo.markChunkFailed(job.id, chunk.idx, lastError);
  return false;
}

export async function runJob(deps: PipelineDeps, params: RunParams): Promise<RunResult> {
  const { repo, log } = deps;
  const { signal } = params;

  const info = await deps.probe(params.source, signal);
  const durationMs = info.durationMs;
  const range = resolveRange({
    startMs: params.startMs,
    endMs: params.endMs,
    durationMs,
    maxMinutes: params.maxMinutes,
  });

  let job = repo.findResumableJob(params.source, range.startMs, range.endMs, params.model);
  if (job) {
    log(`Resuming job ${job.id}`);
  } else {
    job = repo.createJob({
      source: params.source,
      rangeStartMs: range.startMs,
      rangeEndMs: range.endMs,
      settings: { model: params.model, language: params.language, maxMinutes: params.maxMinutes },
      title: info.title,
      videoId: parseYoutubeId(params.source),
    });
  }
  repo.setJobStatus(job.id, 'running');
  params.onJob?.(job);

  const rangeMs = range.endMs - range.startMs;
  const eta = estimateSeconds(rangeMs, deps.perf.read());
  log(
    `Job ${job.id}: ${formatClock(range.startMs)} to ${formatClock(range.endMs)} ` +
      `(${formatDuration(rangeMs / 1000)} of audio). ` +
      (eta === null
        ? 'Time estimate: unknown until a first run measures speed.'
        : `Estimated time: about ${formatDuration(eta)}.`),
  );

  const workDir = path.join(params.workRoot, String(job.id));
  mkdirSync(workDir, { recursive: true });
  const wavPath = path.join(workDir, 'audio.wav');

  if (!existsSync(wavPath)) {
    // Fetch to a temporary name so an interrupted run never leaves a truncated audio.wav behind.
    const partial = path.join(workDir, 'audio.partial.wav');
    rmSync(partial, { force: true });
    log('Fetching audio...');
    deps.progress?.({ stage: 'fetch', done: 0, total: 1, message: 'Fetching audio' });
    await deps.fetchAudio({
      source: params.source,
      startMs: range.startMs,
      endMs: range.endMs,
      fullDurationMs: durationMs,
      workDir,
      outWavPath: partial,
      signal,
    });
    renameSync(partial, wavPath);
    deps.progress?.({ stage: 'fetch', done: 1, total: 1, message: 'Audio ready' });
  }

  if (repo.listChunks(job.id).length === 0) {
    log('Planning chunks...');
    const silences = await deps.detectSilences(wavPath, rangeMs, signal);
    repo.insertChunks(job.id, planChunks(rangeMs, silences, CHUNK_DEFAULTS));
  }
  repo.resetUnfinishedChunks(job.id);

  const chunks = repo.listChunks(job.id);
  let finished = chunks.filter((c) => c.status === 'done').length;
  deps.progress?.({ stage: 'transcribe', done: finished, total: chunks.length, message: 'Transcribing' });
  const failedChunks: number[] = [];
  let transcribedMs = 0;
  let wallMs = 0;

  for (const chunk of chunks) {
    if (chunk.status === 'done') continue;
    log(`Chunk ${chunk.idx + 1}/${chunks.length}: ${formatClock(chunk.startMs)} to ${formatClock(chunk.endMs)}`);
    const started = performance.now();
    const ok = await processChunk(deps, params, job, chunk, workDir);
    if (ok) {
      transcribedMs += chunk.endMs - chunk.startMs;
      wallMs += performance.now() - started;
      writeOutputs(repo, job, params.outDir);
      finished++;
      deps.progress?.({
        stage: 'transcribe',
        done: finished,
        total: chunks.length,
        message: `Chunk ${finished}/${chunks.length}`,
      });
    } else {
      failedChunks.push(chunk.idx);
    }
  }

  if (transcribedMs > 0 && wallMs > 0) deps.perf.write(transcribedMs / wallMs);

  const status = failedChunks.length === 0 ? 'done' : 'failed';
  repo.setJobStatus(job.id, status);
  const outputs = writeOutputs(repo, job, params.outDir);
  if (status === 'done' && !params.keepWork) rmSync(workDir, { recursive: true, force: true });
  if (status === 'failed') {
    log(`Chunks ${failedChunks.map((i) => i + 1).join(', ')} failed. Re-run the same command to retry them.`);
  }
  return { jobId: job.id, status, failedChunks, ...outputs };
}
