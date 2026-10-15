import type { Database } from './sqlite';

export type SubmissionState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface SubmissionOptions {
  translate: boolean;
  summarize: boolean;
  skim: boolean;
  glossaryPath?: string;
  maxMinutes: number;
  model: string;
}

export interface Submission {
  id: number;
  source: string;
  startMs: number;
  endMs: number | null;
  options: SubmissionOptions;
  state: SubmissionState;
  jobId: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SubmissionDb {
  id: number;
  source: string;
  start_ms: number;
  end_ms: number | null;
  options_json: string;
  state: SubmissionState;
  job_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const toSubmission = (r: SubmissionDb): Submission => ({
  id: r.id,
  source: r.source,
  startMs: r.start_ms,
  endMs: r.end_ms,
  options: JSON.parse(r.options_json) as SubmissionOptions,
  state: r.state,
  jobId: r.job_id,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SubmissionStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(input: { source: string; startMs: number; endMs: number | null; options: SubmissionOptions }): Submission {
    const at = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO submissions (source, start_ms, end_ms, options_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(input.source, input.startMs, input.endMs, JSON.stringify(input.options), at, at);
    return this.get(info.lastInsertRowid) as Submission;
  }

  get(id: number): Submission | undefined {
    const row = this.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as SubmissionDb | undefined;
    return row ? toSubmission(row) : undefined;
  }

  list(): Submission[] {
    return (this.db.prepare('SELECT * FROM submissions ORDER BY id').all() as SubmissionDb[]).map(toSubmission);
  }

  setState(id: number, state: SubmissionState, error: string | null = null): void {
    this.db
      .prepare('UPDATE submissions SET state = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(state, error, this.now(), id);
  }

  setJob(id: number, jobId: number): void {
    this.db.prepare('UPDATE submissions SET job_id = ?, updated_at = ? WHERE id = ?').run(jobId, this.now(), id);
  }

  deleteForJob(jobId: number): void {
    this.db.prepare('DELETE FROM submissions WHERE job_id = ?').run(jobId);
  }

  nextQueued(): Submission | undefined {
    const row = this.db
      .prepare("SELECT * FROM submissions WHERE state = 'queued' ORDER BY id LIMIT 1")
      .get() as SubmissionDb | undefined;
    return row ? toSubmission(row) : undefined;
  }

  /** Startup recovery: anything still `running` was cut off by a crash or quit. */
  recoverInterrupted(): number {
    return this.db
      .prepare("UPDATE submissions SET state = 'interrupted', updated_at = ? WHERE state = 'running'")
      .run(this.now()).changes;
  }
}
