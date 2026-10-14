import type { Database } from './sqlite';

export type GlossarySource = 'auto' | 'user';
export interface GlossaryEntry {
  ja: string;
  en: string;
  source: GlossarySource;
}
export type StageName = 'glossary' | 'translate' | 'summarize';
export type StageStatus = 'pending' | 'running' | 'done' | 'failed';
export type SummaryLevel = 'window' | 'section' | 'overview';
export interface SummaryRow {
  level: SummaryLevel;
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
}

const LEVEL_ORDER = `CASE level WHEN 'window' THEN 0 WHEN 'section' THEN 1 ELSE 2 END`;

export class StageRepo {
  constructor(private readonly db: Database) {}

  /** `user` entries overwrite anything; `auto` entries never overwrite an existing one. */
  upsertGlossary(jobId: number, entries: GlossaryEntry[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO glossary (job_id, ja, en, source) VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id, ja) DO UPDATE SET en = excluded.en, source = excluded.source
       WHERE excluded.source = 'user'`,
    );
    this.db.transaction(() => {
      for (const e of entries) stmt.run(jobId, e.ja, e.en, e.source);
    })();
  }

  listGlossary(jobId: number): GlossaryEntry[] {
    return this.db
      .prepare('SELECT ja, en, source FROM glossary WHERE job_id = ? ORDER BY rowid')
      .all(jobId) as GlossaryEntry[];
  }

  saveTranslations(jobId: number, batchIdx: number, items: { segmentId: number; text: string }[]): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO translations (job_id, segment_id, text, batch_idx) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const item of items) stmt.run(jobId, item.segmentId, item.text, batchIdx);
    })();
  }

  listTranslations(jobId: number): Map<number, string> {
    const rows = this.db
      .prepare('SELECT segment_id, text FROM translations WHERE job_id = ?')
      .all(jobId) as { segment_id: number; text: string }[];
    return new Map(rows.map((r) => [r.segment_id, r.text]));
  }

  saveSummary(jobId: number, row: SummaryRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO summaries (job_id, level, idx, start_ms, end_ms, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, row.level, row.idx, row.startMs, row.endMs, row.text);
  }

  listSummaries(jobId: number, level?: SummaryLevel): SummaryRow[] {
    const rows = this.db
      .prepare(
        `SELECT level, idx, start_ms, end_ms, text FROM summaries
         WHERE job_id = ? ${level ? 'AND level = ?' : ''}
         ORDER BY ${LEVEL_ORDER}, idx`,
      )
      .all(...(level ? [jobId, level] : [jobId])) as {
      level: SummaryLevel;
      idx: number;
      start_ms: number;
      end_ms: number;
      text: string;
    }[];
    return rows.map((r) => ({
      level: r.level,
      idx: r.idx,
      startMs: r.start_ms,
      endMs: r.end_ms,
      text: r.text,
    }));
  }

  setStage(jobId: number, stage: StageName, status: StageStatus): void {
    this.db
      .prepare('INSERT OR REPLACE INTO stages (job_id, stage, status) VALUES (?, ?, ?)')
      .run(jobId, stage, status);
  }

  getStage(jobId: number, stage: StageName): StageStatus | undefined {
    const row = this.db
      .prepare('SELECT status FROM stages WHERE job_id = ? AND stage = ?')
      .get(jobId, stage) as { status: StageStatus } | undefined;
    return row?.status;
  }
}
