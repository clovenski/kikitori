import type { Submission, SubmissionOptions, SubmissionStore } from '../../core/db/submission-repo';
import { BgtError } from '../../core/errors';
import type { ProgressEvent } from '../../core/progress';
import type { QueueProgressEvent } from '../shared/ipc';

export interface RunContext {
  signal: AbortSignal;
  progress(e: ProgressEvent): void;
  onJob(jobId: number): void;
}

export interface QueueDeps {
  store: SubmissionStore;
  /** Resolves when the submission finished; rejects (or is aborted) otherwise. */
  run(sub: Submission, ctx: RunContext): Promise<void>;
  emitChanged(submissions: Submission[]): void;
  emitProgress(p: QueueProgressEvent): void;
}

type StopReason = 'cancel' | 'shutdown';

interface Running {
  id: number;
  controller: AbortController;
  reason: StopReason | null;
  done: Promise<void>;
}

const describe = (err: unknown) =>
  err instanceof BgtError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);

export class JobQueue {
  private current: Running | null = null;
  private shuttingDown = false;

  constructor(private readonly d: QueueDeps) {}

  /** Recovers anything a crash or quit left `running`, then processes the queue. */
  start(): void {
    this.d.store.recoverInterrupted();
    this.changed();
    this.pump();
  }

  list(): Submission[] {
    return this.d.store.list();
  }

  submit(req: { source: string; startMs: number; endMs: number | null; options: SubmissionOptions }): Submission {
    const sub = this.d.store.create(req);
    this.changed();
    this.pump();
    return sub;
  }

  cancel(id: number): void {
    const sub = this.d.store.get(id);
    if (!sub) return;
    if (sub.state === 'queued') {
      this.d.store.setState(id, 'cancelled');
      this.changed();
    } else if (sub.state === 'running' && this.current?.id === id) {
      this.current.reason = 'cancel';
      this.current.controller.abort();
    }
  }

  resume(id: number): void {
    const sub = this.d.store.get(id);
    if (!sub || !['failed', 'cancelled', 'interrupted'].includes(sub.state)) return;
    this.d.store.setState(id, 'queued', null);
    this.changed();
    this.pump();
  }

  /** Forgets the submissions of a job that is being deleted. A job that is being processed cannot go. */
  removeJob(jobId: number): void {
    if (this.d.store.list().some((s) => s.jobId === jobId && s.state === 'running')) {
      throw new BgtError('InvalidInput', 'This job is still running. Cancel it first, then delete it.');
    }
    this.d.store.deleteForJob(jobId);
    this.changed();
  }

  async whenIdle(): Promise<void> {
    while (this.current) await this.current.done;
  }

  /** Aborts the running job (it stays resumable as `interrupted`) and stops taking new work. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const running = this.current;
    if (running) {
      running.reason = 'shutdown';
      running.controller.abort();
      await running.done;
    }
  }

  private changed(): void {
    this.d.emitChanged(this.d.store.list());
  }

  private pump(): void {
    if (this.current || this.shuttingDown) return;
    const sub = this.d.store.nextQueued();
    if (!sub) return;
    this.d.store.setState(sub.id, 'running');
    const entry: Running = { id: sub.id, controller: new AbortController(), reason: null, done: Promise.resolve() };
    entry.done = this.execute(sub, entry).finally(() => {
      this.current = null;
      this.changed();
      this.pump();
    });
    this.current = entry;
    this.changed();
  }

  private async execute(sub: Submission, entry: Running): Promise<void> {
    try {
      await this.d.run(sub, {
        signal: entry.controller.signal,
        progress: (event) => this.d.emitProgress({ submissionId: sub.id, event }),
        onJob: (jobId) => {
          this.d.store.setJob(sub.id, jobId);
          this.changed();
        },
      });
      this.d.store.setState(sub.id, 'done');
    } catch (err) {
      if (entry.reason === 'shutdown') this.d.store.setState(sub.id, 'interrupted');
      else if (entry.reason === 'cancel' || entry.controller.signal.aborted) this.d.store.setState(sub.id, 'cancelled');
      else this.d.store.setState(sub.id, 'failed', describe(err));
    }
  }
}
