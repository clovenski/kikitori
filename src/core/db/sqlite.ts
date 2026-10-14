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
      if (this.depth > 0) return fn(...args); // nested: join the outer transaction
      this.db.exec('BEGIN');
      this.depth++;
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      } finally {
        this.depth--;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
