import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runJob, statusAfterFailure, type RunParams } from '../../src/core/pipeline/run';
import type { Segment } from '../../src/core/types';
import { makeFakeDeps, memoryRepo } from '../helpers/fakes';

const seg = (text: string, startMs: number, endMs: number): Segment => ({
  startMs,
  endMs,
  text,
  lang: 'ja',
  avgLogprob: -0.3,
});

// 40 min of audio, silence at 14:30-14:40 => chunk boundaries 875_000 and 1_775_000 (forced).
const TRUTH = [
  seg('A', 100_000, 102_000),
  seg('B', 874_000, 875_000), // inside the overlap: present in chunk 0 AND chunk 1
  seg('C', 880_000, 882_000),
];
const LONG = {
  durationMs: 2_400_000,
  silences: [{ startMs: 870_000, endMs: 880_000 }],
  truth: TRUTH,
};

let root: string;
const params = (over: Partial<RunParams> = {}): RunParams => ({
  source: 'https://www.youtube.com/watch?v=abc',
  startMs: 0,
  endMs: 1_800_000, // 30 min == cap
  maxMinutes: 30,
  model: 'large-v3',
  language: 'ja',
  workRoot: path.join(root, 'work'),
  outDir: path.join(root, 'out'),
  keepWork: true,
  ...over,
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-run-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('statusAfterFailure', () => {
  it('pauses an aborted job and fails any other, but never touches a job that already finished', () => {
    expect(statusAfterFailure('running', true)).toBe('pending');
    expect(statusAfterFailure('running', false)).toBe('failed');
    expect(statusAfterFailure('pending', false)).toBe('failed');
    // e.g. writing the output files failed after the job was already marked done
    expect(statusAfterFailure('done', false)).toBeNull();
    expect(statusAfterFailure('done', true)).toBeNull();
  });
});

describe('runJob', () => {
  it('runs end to end, dedupes the overlap (earlier chunk wins) and writes the SRT', async () => {
    const repo = memoryRepo();
    const { deps, transcribed } = makeFakeDeps(repo, { ...LONG, durationMs: 1_800_000 });
    const result = await runJob(deps, params({ endMs: 1_800_000 }));

    expect(result.status).toBe('done');
    expect(result.failedChunks).toEqual([]);
    expect(transcribed).toEqual(['chunk-000.wav', 'chunk-001.wav']);
    expect(repo.listSegments(result.jobId).map((s) => s.text)).toEqual(['A', 'B', 'C']);

    const srt = readFileSync(result.srtPath, 'utf8');
    expect(srt).toContain('00:01:40,000 --> 00:01:42,000\nA');
    expect(srt.match(/\nB\n/g)).toHaveLength(1);
    expect(existsSync(result.jsonPath)).toBe(true);
  });

  it('records the folder the job writes to, and a resumed job records the folder of its latest run', async () => {
    const repo = memoryRepo();
    const { deps } = makeFakeDeps(repo, { durationMs: 600_000, truth: [seg('hi', 1_000, 2_000)] });
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    let aborted = false;
    const { deps: failing } = makeFakeDeps(repo, {
      durationMs: 600_000,
      onTranscribe: () => {
        aborted = true;
        throw new Error('stop');
      },
    });
    await runJob(failing, params({ outDir: first })).catch(() => {});
    expect(aborted).toBe(true);
    const job = repo.listJobs()[0];
    expect(job.outDir).toBe(first);

    const result = await runJob(deps, params({ outDir: second }));
    expect(result.jobId).toBe(job.id);
    expect(repo.getJob(job.id)?.outDir).toBe(second);
  });

  it('adds the range start to subtitle times and passes the range to the fetcher', async () => {
    const repo = memoryRepo();
    const { deps, fetchCalls } = makeFakeDeps(repo, {
      durationMs: 600_000,
      truth: [seg('hi', 1_000, 2_000)],
    });
    const result = await runJob(deps, params({ startMs: 60_000, endMs: 360_000 }));
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({ startMs: 60_000, endMs: 360_000, fullDurationMs: 600_000 });
    expect(readFileSync(result.srtPath, 'utf8')).toContain('00:01:01,000 --> 00:01:02,000\nhi');
  });

  it('fails with OverCap before creating a job or downloading anything', async () => {
    const repo = memoryRepo();
    const { deps, fetchCalls } = makeFakeDeps(repo, LONG);
    await expect(runJob(deps, params({ endMs: null }))).rejects.toMatchObject({ code: 'OverCap' });
    expect(fetchCalls).toHaveLength(0);
    expect(repo.getJob(1)).toBeUndefined();
  });

  it('completes a music/silence-only chunk with no segments and still writes a valid SRT', async () => {
    const repo = memoryRepo();
    const { deps } = makeFakeDeps(repo, { durationMs: 600_000, truth: [] });
    const result = await runJob(deps, params({ endMs: null, source: '/tmp/music.wav' }));
    expect(result.status).toBe('done');
    expect(repo.listChunks(result.jobId)[0].status).toBe('done');
    expect(readFileSync(result.srtPath, 'utf8')).toBe('');
  });

  it('resumes after an abort without re-transcribing finished chunks', async () => {
    const repo = memoryRepo();
    const controller = new AbortController();
    const first = makeFakeDeps(repo, {
      ...LONG,
      durationMs: 1_800_000,
      onTranscribe: (file) => {
        if (file === 'chunk-001.wav') {
          controller.abort();
          throw controller.signal.reason;
        }
      },
    });
    await expect(runJob(first.deps, params({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(first.transcribed).toEqual(['chunk-000.wav', 'chunk-001.wav']);
    expect(repo.listChunks(1).map((c) => c.status)).toEqual(['done', 'pending']);
    expect(repo.getJob(1)?.status).toBe('pending'); // paused, not left claiming to be running

    const second = makeFakeDeps(repo, { ...LONG, durationMs: 1_800_000 });
    const result = await runJob(second.deps, params());
    expect(result.jobId).toBe(1);
    expect(result.status).toBe('done');
    expect(second.transcribed).toEqual(['chunk-001.wav']);
    expect(second.fetchCalls).toHaveLength(0); // audio.wav already complete
    expect(repo.listSegments(1).map((s) => s.text)).toEqual(['A', 'B', 'C']);
  });

  it('does not treat a partial download as complete audio', async () => {
    const repo = memoryRepo();
    const controller = new AbortController();
    const first = makeFakeDeps(repo, { durationMs: 600_000 });
    first.deps.fetchAudio = async (a) => {
      // leaves a truncated file at the temporary path, then dies
      writeFileSync(a.outWavPath, 'trunc');
      controller.abort();
      throw controller.signal.reason;
    };
    await expect(runJob(first.deps, params({ endMs: null, signal: controller.signal }))).rejects.toBeDefined();
    expect(existsSync(path.join(root, 'work', '1', 'audio.wav'))).toBe(false);

    const second = makeFakeDeps(repo, { durationMs: 600_000 });
    await runJob(second.deps, params({ endMs: null }));
    expect(second.fetchCalls).toHaveLength(1);
  });

  it('retries a failing chunk 3 times, marks it failed, continues, and recovers on re-run', async () => {
    const repo = memoryRepo();
    let broken = true;
    const first = makeFakeDeps(repo, {
      ...LONG,
      onTranscribe: (file) => {
        if (broken && file === 'chunk-001.wav') throw new Error('whisper crashed');
      },
    });
    const result = await runJob(first.deps, params({ startMs: 0, endMs: 1_800_000 }));
    // 30-min request, 40-min video: chunks planned over 30 min -> 2 chunks
    expect(result.status).toBe('failed');
    expect(result.failedChunks).toEqual([1]);
    expect(first.transcribed.filter((f) => f === 'chunk-001.wav')).toHaveLength(3);
    expect(repo.listChunks(result.jobId)[1]).toMatchObject({ status: 'failed', error: 'whisper crashed' });
    expect(repo.getJob(result.jobId)?.status).toBe('failed');

    broken = false;
    const second = makeFakeDeps(repo, LONG);
    const again = await runJob(second.deps, params({ startMs: 0, endMs: 1_800_000 }));
    expect(again.jobId).toBe(result.jobId);
    expect(again.status).toBe('done');
    expect(second.transcribed).toEqual(['chunk-001.wav']);
  });

  it('does not duplicate overlap speech when an earlier chunk is retried after a later one finished', async () => {
    const repo = memoryRepo();
    let broken = true;
    const first = makeFakeDeps(repo, {
      ...LONG,
      durationMs: 1_800_000,
      onTranscribe: (file) => {
        if (broken && file === 'chunk-000.wav') throw new Error('whisper crashed');
      },
    });
    const result = await runJob(first.deps, params());
    expect(result.failedChunks).toEqual([0]);

    broken = false;
    const second = makeFakeDeps(repo, { ...LONG, durationMs: 1_800_000 });
    const again = await runJob(second.deps, params());
    expect(again.status).toBe('done');
    expect(repo.listSegments(again.jobId).map((s) => s.text)).toEqual(['A', 'B', 'C']);
  });

  it('removes the work dir on success unless keepWork is set', async () => {
    const repo = memoryRepo();
    const a = makeFakeDeps(repo, { durationMs: 600_000 });
    const done = await runJob(a.deps, params({ endMs: null, keepWork: false }));
    expect(existsSync(path.join(root, 'work', String(done.jobId)))).toBe(false);
    expect(existsSync(done.srtPath)).toBe(true);
  });

  it('stores the video title and, for YouTube URLs, the video id on the job', async () => {
    const repo = memoryRepo();
    const { deps } = makeFakeDeps(repo, { durationMs: 600_000, title: 'My stream' });
    const result = await runJob(
      deps,
      params({ source: 'https://www.youtube.com/watch?v=7SHNxjFuw10&list=PLx', endMs: null }),
    );
    expect(repo.getJob(result.jobId)).toMatchObject({ title: 'My stream', videoId: '7SHNxjFuw10' });

    const local = await runJob(deps, params({ source: 'C:/clips/a.wav', endMs: null }));
    expect(repo.getJob(local.jobId)).toMatchObject({ title: 'My stream', videoId: null });
  });

  it('reports the job as soon as it exists and emits fetch and per-chunk progress', async () => {
    const repo = memoryRepo();
    const { deps } = makeFakeDeps(repo, { ...LONG, durationMs: 1_800_000 });
    const events: { stage: string; done: number; total: number }[] = [];
    deps.progress = (e) => events.push({ stage: e.stage, done: e.done, total: e.total });
    const seenJobs: number[] = [];
    await runJob(deps, params({ onJob: (job) => seenJobs.push(job.id) }));
    expect(seenJobs).toEqual([1]);
    expect(events.filter((e) => e.stage === 'fetch')).toEqual([
      { stage: 'fetch', done: 0, total: 1 },
      { stage: 'fetch', done: 1, total: 1 },
    ]);
    expect(events.filter((e) => e.stage === 'transcribe')).toEqual([
      { stage: 'transcribe', done: 0, total: 2 },
      { stage: 'transcribe', done: 1, total: 2 },
      { stage: 'transcribe', done: 2, total: 2 },
    ]);
  });

  it('marks the job failed when the pipeline throws something other than an abort', async () => {
    const repo = memoryRepo();
    const { deps } = makeFakeDeps(repo, { durationMs: 600_000 });
    deps.fetchAudio = async () => {
      throw new Error('download exploded');
    };
    await expect(runJob(deps, params({ endMs: null }))).rejects.toThrow('download exploded');
    expect(repo.getJob(1)?.status).toBe('failed');
  });

  it('records the measured speed factor', async () => {
    const repo = memoryRepo();
    const { deps } = makeFakeDeps(repo, { durationMs: 600_000 });
    let stored: number | null = null;
    deps.perf = { read: () => null, write: (v) => (stored = v) };
    await runJob(deps, params({ endMs: null }));
    expect(stored).toBeGreaterThan(0);
  });
});
