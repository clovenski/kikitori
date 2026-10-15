import type { Database } from './sqlite';
import type { Segment } from '../types';
import type { PlannedChunk } from '../pipeline/chunker';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type ChunkStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobSettings {
  model: string;
  language: string;
  maxMinutes: number;
}

export interface JobRow {
  id: number;
  source: string;
  rangeStartMs: number;
  rangeEndMs: number;
  settings: JobSettings;
  status: JobStatus;
  createdAt: string;
  title: string | null;
  videoId: string | null;
}

export interface ChunkRow {
  jobId: number;
  idx: number;
  startMs: number;
  endMs: number;
  wavPath: string | null;
  status: ChunkStatus;
  attempts: number;
  error: string | null;
}

interface JobDb {
  id: number;
  source: string;
  range_start_ms: number;
  range_end_ms: number;
  settings_json: string;
  status: JobStatus;
  created_at: string;
  title: string | null;
  video_id: string | null;
}

interface ChunkDb {
  job_id: number;
  idx: number;
  start_ms: number;
  end_ms: number;
  wav_path: string | null;
  status: ChunkStatus;
  attempts: number;
  error: string | null;
}

interface SegmentDb {
  start_ms: number;
  end_ms: number;
  text: string;
  lang: string;
  avg_logprob: number | null;
}

const toJob = (r: JobDb): JobRow => ({
  id: r.id,
  source: r.source,
  rangeStartMs: r.range_start_ms,
  rangeEndMs: r.range_end_ms,
  settings: JSON.parse(r.settings_json) as JobSettings,
  status: r.status,
  createdAt: r.created_at,
  title: r.title,
  videoId: r.video_id,
});

const toChunk = (r: ChunkDb): ChunkRow => ({
  jobId: r.job_id,
  idx: r.idx,
  startMs: r.start_ms,
  endMs: r.end_ms,
  wavPath: r.wav_path,
  status: r.status,
  attempts: r.attempts,
  error: r.error,
});

export class Repo {
  constructor(private readonly db: Database) {}

  createJob(
    input: {
      source: string;
      rangeStartMs: number;
      rangeEndMs: number;
      settings: JobSettings;
      title?: string | null;
      videoId?: string | null;
    },
    createdAt: string = new Date().toISOString(),
  ): JobRow {
    const info = this.db
      .prepare(
        `INSERT INTO jobs (source, range_start_ms, range_end_ms, settings_json, status, created_at, title, video_id)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        input.source,
        input.rangeStartMs,
        input.rangeEndMs,
        JSON.stringify(input.settings),
        createdAt,
        input.title ?? null,
        input.videoId ?? null,
      );
    return this.getJob(Number(info.lastInsertRowid)) as JobRow;
  }

  getJob(id: number): JobRow | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobDb | undefined;
    return row ? toJob(row) : undefined;
  }

  listJobs(): JobRow[] {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY id DESC').all() as JobDb[];
    return rows.map(toJob);
  }

  findResumableJob(
    source: string,
    rangeStartMs: number,
    rangeEndMs: number,
    model: string,
  ): JobRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE source = ? AND range_start_ms = ? AND range_end_ms = ? AND status <> 'done'
         ORDER BY id DESC`,
      )
      .all(source, rangeStartMs, rangeEndMs) as JobDb[];
    return rows.map(toJob).find((job) => job.settings.model === model);
  }

  /** Startup recovery: a job still `running` was cut off by a crash or a hard kill. Returns how many. */
  resetRunningJobs(): number {
    return this.db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run().changes;
  }

  setJobStatus(id: number, status: JobStatus): void {
    this.db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
  }

  insertChunks(jobId: number, chunks: PlannedChunk[]): void {
    const insert = this.db.prepare(
      'INSERT INTO chunks (job_id, idx, start_ms, end_ms) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const chunk of chunks) insert.run(jobId, chunk.idx, chunk.startMs, chunk.endMs);
    })();
  }

  listChunks(jobId: number): ChunkRow[] {
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE job_id = ? ORDER BY idx')
      .all(jobId) as ChunkDb[];
    return rows.map(toChunk);
  }

  /** Crash recovery: running -> pending (attempts kept); failed -> pending (attempts reset). */
  resetUnfinishedChunks(jobId: number): void {
    this.db
      .prepare(
        `UPDATE chunks
         SET status = 'pending',
             attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END,
             error = NULL
         WHERE job_id = ? AND status IN ('running', 'failed')`,
      )
      .run(jobId);
  }

  markChunkRunning(jobId: number, idx: number): void {
    this.db
      .prepare(
        `UPDATE chunks SET status = 'running', attempts = attempts + 1 WHERE job_id = ? AND idx = ?`,
      )
      .run(jobId, idx);
  }

  markChunkPending(jobId: number, idx: number): void {
    this.db
      .prepare(`UPDATE chunks SET status = 'pending' WHERE job_id = ? AND idx = ?`)
      .run(jobId, idx);
  }

  markChunkFailed(jobId: number, idx: number, error: string): void {
    this.db
      .prepare(`UPDATE chunks SET status = 'failed', error = ? WHERE job_id = ? AND idx = ?`)
      .run(error, jobId, idx);
  }

  /** Atomically replaces the chunk's segments and marks it done. */
  completeChunk(jobId: number, idx: number, segments: Segment[]): void {
    const insert = this.db.prepare(
      `INSERT INTO segments (job_id, chunk_idx, start_ms, end_ms, text, lang, avg_logprob)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM translations WHERE job_id = ? AND segment_id IN
             (SELECT id FROM segments WHERE job_id = ? AND chunk_idx = ?)`,
        )
        .run(jobId, jobId, idx);
      this.db.prepare('DELETE FROM segments WHERE job_id = ? AND chunk_idx = ?').run(jobId, idx);
      for (const s of segments) {
        insert.run(jobId, idx, s.startMs, s.endMs, s.text, s.lang, s.avgLogprob ?? null);
      }
      this.db
        .prepare(`UPDATE chunks SET status = 'done', error = NULL WHERE job_id = ? AND idx = ?`)
        .run(jobId, idx);
      // Earlier chunk wins: if a later chunk finished first, drop its copy of the overlap.
      const end = segments.reduce((max, s) => Math.max(max, s.endMs), -1);
      if (end >= 0) {
        this.db
          .prepare(
            `DELETE FROM translations WHERE job_id = ? AND segment_id IN
               (SELECT id FROM segments WHERE job_id = ? AND chunk_idx > ? AND start_ms < ?)`,
          )
          .run(jobId, jobId, idx, end);
        this.db
          .prepare('DELETE FROM segments WHERE job_id = ? AND chunk_idx > ? AND start_ms < ?')
          .run(jobId, idx, end);
      }
    })();
  }

  listSegments(jobId: number): Segment[] {
    const rows = this.db
      .prepare('SELECT * FROM segments WHERE job_id = ? ORDER BY start_ms, id')
      .all(jobId) as SegmentDb[];
    return rows.map((r) => ({
      startMs: r.start_ms,
      endMs: r.end_ms,
      text: r.text,
      lang: r.lang,
      avgLogprob: r.avg_logprob,
    }));
  }

  listSegmentsWithId(jobId: number): (Segment & { id: number })[] {
    const rows = this.db
      .prepare('SELECT * FROM segments WHERE job_id = ? ORDER BY start_ms, id')
      .all(jobId) as (SegmentDb & { id: number })[];
    return rows.map((r) => ({
      id: r.id,
      startMs: r.start_ms,
      endMs: r.end_ms,
      text: r.text,
      lang: r.lang,
      avgLogprob: r.avg_logprob,
    }));
  }

  /** Largest segment end among chunks before `chunkIdx`, or null if there are none. */
  maxSegmentEndBefore(jobId: number, chunkIdx: number): number | null {
    const row = this.db
      .prepare('SELECT MAX(end_ms) AS m FROM segments WHERE job_id = ? AND chunk_idx < ?')
      .get(jobId, chunkIdx) as { m: number | null };
    return row.m;
  }
}
