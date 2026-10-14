import type { Database } from './sqlite';

/** Append-only. Index + 1 is the resulting PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    range_start_ms INTEGER NOT NULL,
    range_end_ms INTEGER NOT NULL,
    settings_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  CREATE TABLE chunks (
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    idx INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    wav_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    PRIMARY KEY (job_id, idx)
  );
  CREATE TABLE segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    chunk_idx INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    lang TEXT NOT NULL,
    avg_logprob REAL
  );
  CREATE INDEX idx_segments_job ON segments(job_id, start_ms);
  `,
  `
  CREATE TABLE glossary (
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    ja TEXT NOT NULL,
    en TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (job_id, ja)
  );
  CREATE TABLE translations (
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    segment_id INTEGER NOT NULL REFERENCES segments(id),
    text TEXT NOT NULL,
    batch_idx INTEGER NOT NULL,
    PRIMARY KEY (job_id, segment_id)
  );
  CREATE TABLE summaries (
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    level TEXT NOT NULL,
    idx INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (job_id, level, idx)
  );
  CREATE TABLE stages (
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (job_id, stage)
  );
  `,
];

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
