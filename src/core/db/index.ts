import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Database } from './sqlite';
import { migrate } from './schema';

export function openDb(file: string): Database {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}
