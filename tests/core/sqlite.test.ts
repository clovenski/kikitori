import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Database } from '../../src/core/db/sqlite';

describe('Database adapter', () => {
  it('prepares, runs, gets and lists rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, n REAL)');
    const info = db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('a', 1.5);
    expect(info).toEqual({ changes: 1, lastInsertRowid: 1 });
    db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('b', null);
    expect(db.prepare('SELECT name, n FROM t WHERE id = ?').get(1)).toEqual({ name: 'a', n: 1.5 });
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get(99)).toBeUndefined();
    expect(db.prepare('SELECT name FROM t ORDER BY id').all()).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('waits up to 5 seconds for a locked database instead of failing at once', () => {
    // The CLI and the app share one WAL database; better-sqlite3 waited 5 s by default, node:sqlite waits 0.
    const db = new Database(':memory:');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('reads and writes pragmas', () => {
    const db = new Database(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    db.pragma('user_version = 7');
    expect(db.pragma('user_version', { simple: true })).toBe(7);
  });

  it('commits a transaction and rolls back when the callback throws', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (n INTEGER)');
    const insert = db.transaction((n: number, fail: boolean) => {
      db.prepare('INSERT INTO t VALUES (?)').run(n);
      if (fail) throw new Error('boom');
      return n * 2;
    });
    expect(insert(1, false)).toBe(2);
    expect(() => insert(2, true)).toThrow('boom');
    expect(db.prepare('SELECT n FROM t').all()).toEqual([{ n: 1 }]);
  });

  it('joins a nested transaction to the outer one', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (n INTEGER)');
    const inner = db.transaction((n: number) => db.prepare('INSERT INTO t VALUES (?)').run(n));
    const outer = db.transaction(() => {
      inner(1);
      inner(2);
      throw new Error('undo both');
    });
    expect(() => outer()).toThrow('undo both');
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 0 });
  });

  it('rolls back only a nested transaction that threw and was caught, keeping the outer work', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (n INTEGER)');
    const insert = (n: number) => db.prepare('INSERT INTO t VALUES (?)').run(n);
    const failing = db.transaction((n: number) => {
      insert(n);
      throw new Error('inner failed');
    });
    const outer = db.transaction(() => {
      insert(1);
      try {
        failing(2);
      } catch {
        /* the caller recovers */
      }
      insert(3);
    });
    outer();
    expect(db.prepare('SELECT n FROM t ORDER BY n').all()).toEqual([{ n: 1 }, { n: 3 }]);
  });

  it('keeps working after a nested rollback (depth is restored)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (n INTEGER)');
    const failing = db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (9)').run();
      throw new Error('x');
    });
    expect(() => failing()).toThrow('x'); // top level: plain rollback
    const ok = db.transaction(() => db.prepare('INSERT INTO t VALUES (1)').run());
    ok();
    expect(db.prepare('SELECT n FROM t').all()).toEqual([{ n: 1 }]);
  });

  it('opens a file read-only', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-sqlite-'));
    try {
      const file = path.join(dir, 'x.db');
      const rw = new Database(file);
      rw.exec('CREATE TABLE t (n INTEGER)');
      rw.close();
      const ro = new Database(file, { readonly: true });
      expect(ro.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 0 });
      expect(() => ro.exec('INSERT INTO t VALUES (1)')).toThrow();
      ro.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
