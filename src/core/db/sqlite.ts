import { DatabaseSync, type StatementSync } from 'node:sqlite';

type Param = string | number | bigint | null | Uint8Array;

export interface RunInfo {
  changes: number;
  lastInsertRowid: number;
}

export class Statement {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: Param[]): RunInfo {
    const r = this.stmt.run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get(...params: Param[]): unknown {
    return this.stmt.get(...params);
  }

  all(...params: Param[]): unknown[] {
    return this.stmt.all(...params);
  }
}

/** The small better-sqlite3-shaped surface this project uses, over Node's built-in `node:sqlite`. */
export class Database {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(file: string, opts: { readonly?: boolean } = {}) {
    this.db = new DatabaseSync(file, { readOnly: opts.readonly ?? false });
    // The CLI and the app share one WAL database. better-sqlite3 waited 5 s for a lock; node:sqlite waits 0.
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(text: string, opts: { simple?: boolean } = {}): unknown {
    const rows = this.db.prepare(`PRAGMA ${text}`).all() as Record<string, unknown>[];
    if (opts.simple) {
      const row = rows[0];
      return row ? Object.values(row)[0] : undefined;
    }
    return rows;
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      if (this.depth > 0) {
        // Nested: a savepoint, so an inner failure the caller catches undoes only its own changes.
        const name = `sp${this.depth}`;
        this.db.exec(`SAVEPOINT ${name}`);
        this.depth++;
        try {
          const result = fn(...args);
          this.db.exec(`RELEASE ${name}`);
          return result;
        } catch (err) {
          this.undo(`ROLLBACK TO ${name}`, `RELEASE ${name}`);
          throw err;
        } finally {
          this.depth--;
        }
      }
      this.db.exec('BEGIN');
      this.depth++;
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.undo('ROLLBACK');
        throw err;
      } finally {
        this.depth--;
      }
    };
  }

  /** Rolls back after a failure. A failing rollback must not replace the error that caused it. */
  private undo(...statements: string[]): void {
    try {
      for (const sql of statements) this.db.exec(sql);
    } catch {
      /* the original error is the one worth reporting */
    }
  }

  close(): void {
    this.db.close();
  }
}
