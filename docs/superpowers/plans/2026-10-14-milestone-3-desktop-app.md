# Milestone 3 Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron + React desktop app that queues transcription/translation/summary jobs through the existing core, shows live progress, and plays each finished job with a synced subtitle overlay, a clickable transcript, and a clickable timestamped summary.

**Architecture:** `src/core/` stays Electron-free and is driven from the Electron main process (`JobQueue` -> `runSubmission` -> `runJob` / `runLlmStages`). The database moves from `better-sqlite3` to Node's built-in `node:sqlite` behind a small adapter so one code path serves the CLI, tests and Electron. The renderer talks only to a typed `window.bgt` API (contextBridge) and never touches Node.

**Tech Stack:** Electron 44 (Node 24), electron-vite 6, Vite 8, React 19, TypeScript, vitest 5 (Node + jsdom), Testing Library, `node:sqlite`. No UI library, no router library.

**Spec:** `docs/superpowers/specs/2026-10-14-milestone-3-desktop-app-design.md`

## Global Constraints

- `src/core/` imports nothing from `electron`, `react`, `src/app`, or `src/cli` (ESLint enforced).
- `src/app/renderer` imports no `electron`, no `node:*`, and no runtime code from `src/core` except the pure modules `core/time`, `core/errors`, `core/youtube`; type-only imports are always allowed. `src/app/shared` contains types only.
- Renderer window: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the preload exposes only the `BgtApi`; production CSP allows only own scripts plus `https://www.youtube.com`.
- One job runs at a time. Queue states: `queued | running | done | failed | cancelled | interrupted`. A `running` submission found at startup becomes `interrupted`.
- Subtitle times in the UI are absolute video time (range offset already added by `job.get`); segments in the DB stay relative to the extracted audio, as before.
- `bgt-media://job/<id>` serves only the local-file source of an existing job; never an arbitrary path.
- Unpackaged app uses the project's `data/` and `resources/` (shared with the CLI). Windows only.
- Database: migration 3 (`PRAGMA user_version = 3`) adds `jobs.title`, `jobs.video_id` and the `submissions` table. All Milestone 1 and 2 tests must keep passing after the `node:sqlite` switch.
- Never commit `out/`, models, binaries, media, `data/` or `output/`.

## Review Focus

1. **Quitting or closing the app during a job** must not leave `whisper-cli`, `llama-server`, `yt-dlp` or `ffmpeg` running, and the job must come back as Resume-able, not lost. Pinned in Task 7 (queue shutdown test) and Task 9 (lifecycle code, manual check in Task 15).
2. **The media protocol must not read arbitrary files**: unknown job ids, URL sources, deleted files and non-numeric ids are refused. Pinned in Task 9.
3. **Bad submissions fail before they are queued**: empty source, `skim` with `translate`, malformed or reversed times, over-cap range. Pinned in Tasks 6 and 12.
4. **Subtitle lookup edge cases**: empty list, time before the first line, gaps, equal start times, time after the last line. Pinned in Task 10.
5. **YouTube embed errors (101, 150, 153) or API load failure** must switch to reader mode with a visible notice, not a blank page. Pinned in Task 13.

---

## File Structure

```
src/core/db/sqlite.ts            # node:sqlite adapter (Database, Statement)
src/core/db/submission-repo.ts   # SubmissionStore
src/core/db/{schema,repo,stage-repo,index}.ts   # adapter types, migration 3, listJobs, counts
src/core/youtube.ts              # parseYoutubeId (pure)
src/core/progress.ts             # ProgressEvent
src/core/pipeline/{run,real-deps,stages,glossary-job,translate-job,summarize-job}.ts   # probe, progress, onJob, shared db
src/core/tools/{ytdlp,paths}.ts  # probeVideo (title), BGT_PROJECT_ROOT
src/app/shared/ipc.ts            # BgtApi and payload types (types only) + CHANNELS
src/app/main/{index,handlers,ipc,queue,run-submission,library-service,validate,media}.ts
src/app/preload/index.ts
src/app/renderer/{index.html,main.tsx,App.tsx,env.d.ts,styles.css}
src/app/renderer/lib/{api,format,subtitles,newjob,timesource,youtube-api}.ts(x)
src/app/renderer/components/{LibraryScreen,QueueStrip,NewJobDialog,PlayerShell,YouTubePlayer,LocalPlayer,TranscriptPanel,SummaryPanel,JobScreen}.tsx
electron.vite.config.ts, tsconfig.web.json, scripts/smoke-app.mjs
tests/core/*.test.ts, tests/app/*.test.ts, tests/renderer/*.test.ts(x)
```

---

### Task 1: Switch the database to `node:sqlite` behind an adapter

**Files:**
- Create: `src/core/db/sqlite.ts`
- Modify: `src/core/db/schema.ts`, `src/core/db/repo.ts`, `src/core/db/stage-repo.ts`, `src/core/db/index.ts`, `tests/core/repo.test.ts`, `tests/core/stage-repo.test.ts`, `tests/helpers/fakes.ts`, `package.json`, `pnpm-workspace.yaml`
- Test: `tests/core/sqlite.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class Database` (`constructor(file: string, opts?: { readonly?: boolean })`, `prepare(sql): Statement`, `exec(sql)`, `pragma(text, opts?: { simple?: boolean }): unknown`, `transaction<A, R>(fn): (...a: A) => R` joining an outer transaction if nested, `close()`), `class Statement` (`run(...p): { changes: number; lastInsertRowid: number }`, `get(...p): unknown`, `all(...p): unknown[]`). `openDb(file): Database` unchanged in behavior. `better-sqlite3` is removed.

- [ ] **Step 1: Write the failing adapter test**

`tests/core/sqlite.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/sqlite.test.ts`
Expected: FAIL, cannot resolve `../../src/core/db/sqlite`.

- [ ] **Step 3: Write the adapter**

`src/core/db/sqlite.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify the adapter passes**

Run: `pnpm test tests/core/sqlite.test.ts`
Expected: PASS (an ExperimentalWarning from Node is printed once; that is expected).

- [ ] **Step 5: Point the repositories and tests at the adapter**

Make these exact edits:
- `src/core/db/schema.ts`: replace `import type Database from 'better-sqlite3';` with `import type { Database } from './sqlite';` and `db: Database.Database` with `db: Database`.
- `src/core/db/repo.ts` and `src/core/db/stage-repo.ts`: same import replacement; `private readonly db: Database.Database` becomes `private readonly db: Database`.
- `src/core/db/index.ts`: replace `import Database from 'better-sqlite3';` with `import { Database } from './sqlite';` and the return type `Database.Database` with `Database`.
- `tests/core/repo.test.ts` and `tests/core/stage-repo.test.ts`: replace `import Database from 'better-sqlite3';` with `import { Database } from '../../src/core/db/sqlite';`; in `repo.test.ts` change `let db: Database.Database;` to `let db: Database;`.
- `tests/helpers/fakes.ts`: replace `import Database from 'better-sqlite3';` with `import { Database } from '../../src/core/db/sqlite';`.
- `package.json`: remove `better-sqlite3` from `dependencies` and `@types/better-sqlite3` from `devDependencies`. `pnpm-workspace.yaml`: delete the `better-sqlite3: true` line under `allowBuilds`. Run `pnpm install`.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all Milestone 1 and 2 tests PASS unchanged in meaning (198 tests plus the 5 new ones). If a `toEqual` fails only because rows from `node:sqlite` have a null prototype, wrap the affected `Repo`/`StageRepo` return values with `{ ...row }` rather than changing tests. Also confirm `grep -r "better-sqlite3" src tests scripts package.json` prints nothing.

- [ ] **Step 7: Verify the CLI still reads the existing database**

Run: `pnpm bgt doctor`
Expected: same output as before (database is opened lazily by `run`; this just checks nothing import-time broke). Then `node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/bgt.sqlite',{readOnly:true});console.log(d.prepare('select count(*) c from jobs').get())"` prints the existing job count (2 or more).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(db): replace better-sqlite3 with node:sqlite behind a small adapter

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration 3, job titles, and the submissions store

**Files:**
- Create: `src/core/db/submission-repo.ts`
- Modify: `src/core/db/schema.ts`, `src/core/db/repo.ts`, `src/core/db/stage-repo.ts`, `tests/core/repo.test.ts`
- Test: `tests/core/submission-repo.test.ts`, `tests/core/repo.test.ts` (extend), `tests/core/stage-repo.test.ts` (extend)

**Interfaces:**
- Consumes: `Database` (Task 1), `Repo`, `StageRepo`.
- Produces:
  - `JobRow` gains `title: string | null` and `videoId: string | null`; `Repo.createJob` input gains optional `title?: string | null; videoId?: string | null`; `Repo.listJobs(): JobRow[]` (newest first).
  - `StageRepo.countTranslations(jobId): number` (non-empty translations only), `StageRepo.countSummaries(jobId): number`.
  - `type SubmissionState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'`
  - `interface SubmissionOptions { translate: boolean; summarize: boolean; skim: boolean; glossaryPath?: string; maxMinutes: number; model: string }`
  - `interface Submission { id: number; source: string; startMs: number; endMs: number | null; options: SubmissionOptions; state: SubmissionState; jobId: number | null; error: string | null; createdAt: string; updatedAt: string }`
  - `class SubmissionStore(db, now?: () => string)`: `create(input: { source; startMs; endMs; options }): Submission`, `get(id): Submission | undefined`, `list(): Submission[]` (ascending id), `setState(id, state, error?: string | null)`, `setJob(id, jobId)`, `nextQueued(): Submission | undefined` (lowest id), `recoverInterrupted(): number`.

- [ ] **Step 1: Write the failing tests**

Change `tests/core/repo.test.ts`: the migrate assertion becomes `toBe(3)`; add inside `describe('jobs', ...)`:
```ts
  it('stores a title and video id, lists newest first, and defaults both to null', () => {
    const a = repo.createJob({ source: 'a', rangeStartMs: 0, rangeEndMs: 1000, settings });
    const b = repo.createJob({
      source: 'b',
      rangeStartMs: 0,
      rangeEndMs: 1000,
      settings,
      title: 'My video',
      videoId: 'abcdefghijk',
    });
    expect(a).toMatchObject({ title: null, videoId: null });
    expect(b).toMatchObject({ title: 'My video', videoId: 'abcdefghijk' });
    expect(repo.listJobs().map((j) => j.id)).toEqual([b.id, a.id]);
  });
```
Append to `tests/core/stage-repo.test.ts` inside `describe('summaries and stages', ...)`:
```ts
  it('counts non-empty translations and summaries', () => {
    repo.completeChunk(jobId, 0, [seg('a', 0, 1000), seg('b', 1000, 2000)]);
    const [a, b] = repo.listSegmentsWithId(jobId);
    stages.saveTranslations(jobId, 0, [{ segmentId: a.id, text: 'A' }, { segmentId: b.id, text: '' }]);
    stages.saveSummary(jobId, { level: 'overview', idx: 0, startMs: 0, endMs: 9, text: 'O' });
    expect(stages.countTranslations(jobId)).toBe(1);
    expect(stages.countSummaries(jobId)).toBe(1);
  });
```
`tests/core/submission-repo.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/db/sqlite';
import { migrate } from '../../src/core/db/schema';
import { Repo } from '../../src/core/db/repo';
import { SubmissionStore } from '../../src/core/db/submission-repo';

const options = { translate: true, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3' };
let db: Database;
let store: SubmissionStore;
let tick = 0;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  tick = 0;
  store = new SubmissionStore(db, () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}Z`);
});

describe('SubmissionStore', () => {
  it('creates queued submissions with options and reads them back', () => {
    const s = store.create({ source: 'https://y/1', startMs: 0, endMs: 60_000, options });
    expect(s).toMatchObject({ id: 1, state: 'queued', jobId: null, error: null, endMs: 60_000, options });
    expect(store.get(1)).toEqual(s);
    expect(store.get(99)).toBeUndefined();
  });

  it('serves the lowest queued id next and skips other states', () => {
    const a = store.create({ source: 'a', startMs: 0, endMs: null, options });
    const b = store.create({ source: 'b', startMs: 0, endMs: null, options });
    store.setState(a.id, 'running');
    expect(store.nextQueued()?.id).toBe(b.id);
    store.setState(b.id, 'done');
    expect(store.nextQueued()).toBeUndefined();
  });

  it('records errors, job links and updates the timestamp', () => {
    const jobId = new Repo(db).createJob({
      source: 'a',
      rangeStartMs: 0,
      rangeEndMs: 1,
      settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 },
    }).id;
    const s = store.create({ source: 'a', startMs: 0, endMs: null, options });
    store.setJob(s.id, jobId);
    store.setState(s.id, 'failed', 'DownloadFailed: nope');
    const after = store.get(s.id);
    expect(after).toMatchObject({ jobId, state: 'failed', error: 'DownloadFailed: nope' });
    expect(after?.updatedAt > s.updatedAt).toBe(true);
    store.setState(s.id, 'queued', null);
    expect(store.get(s.id)?.error).toBeNull();
  });

  it('recovers running submissions as interrupted and returns how many', () => {
    const a = store.create({ source: 'a', startMs: 0, endMs: null, options });
    store.create({ source: 'b', startMs: 0, endMs: null, options });
    store.setState(a.id, 'running');
    expect(store.recoverInterrupted()).toBe(1);
    expect(store.list().map((s) => s.state)).toEqual(['interrupted', 'queued']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/core/repo.test.ts tests/core/stage-repo.test.ts tests/core/submission-repo.test.ts`
Expected: FAIL (user_version is 2; missing members and module).

- [ ] **Step 3: Implement**

`src/core/db/schema.ts`: append a third migration string to `MIGRATIONS`:
```ts
  `
  ALTER TABLE jobs ADD COLUMN title TEXT;
  ALTER TABLE jobs ADD COLUMN video_id TEXT;
  CREATE TABLE submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    start_ms INTEGER NOT NULL DEFAULT 0,
    end_ms INTEGER,
    options_json TEXT NOT NULL,
    state TEXT NOT NULL,
    job_id INTEGER REFERENCES jobs(id),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
```

`src/core/db/repo.ts`:
- `JobRow`: add `title: string | null; videoId: string | null;`.
- `JobDb`: add `title: string | null; video_id: string | null;`.
- `toJob`: add `title: r.title, videoId: r.video_id,`.
- `createJob` input type: add `title?: string | null; videoId?: string | null;`; the INSERT becomes
```ts
        `INSERT INTO jobs (source, range_start_ms, range_end_ms, settings_json, status, created_at, title, video_id)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
```
with `.run(input.source, input.rangeStartMs, input.rangeEndMs, JSON.stringify(input.settings), createdAt, input.title ?? null, input.videoId ?? null)`.
- Add method:
```ts
  listJobs(): JobRow[] {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY id DESC').all() as JobDb[];
    return rows.map(toJob);
  }
```

`src/core/db/stage-repo.ts`: add methods
```ts
  countTranslations(jobId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM translations WHERE job_id = ? AND text <> ''")
      .get(jobId) as { c: number };
    return row.c;
  }

  countSummaries(jobId: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM summaries WHERE job_id = ?').get(jobId) as { c: number };
    return row.c;
  }
```

`src/core/db/submission-repo.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. Also verify the real database migrates in place (it must keep jobs 2 and 3): copy it, then open the copy with `openDb` and read `jobs`:
```bash
cp data/bgt.sqlite "$TEMP/bgt-copy.sqlite"
cat > "$TEMP/mig.mts" <<'EOF'
import { openDb } from 'file:///C:/Users/Joel/source/repos/bg-auto-translator/src/core/db/index.ts';
const db = openDb(process.argv[2]);
console.log(db.pragma('user_version', { simple: true }), db.prepare('SELECT id, title, video_id FROM jobs ORDER BY id').all());
EOF
pnpm exec tsx "$TEMP/mig.mts" "$TEMP/bgt-copy.sqlite"
```
Expected: `3` and the existing jobs with `title: null, video_id: null`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): migration 3 with job titles and a submissions store

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: YouTube id parsing and video probe with title

**Files:**
- Create: `src/core/youtube.ts`
- Modify: `src/core/tools/ytdlp.ts`, `src/core/pipeline/run.ts`, `src/core/pipeline/real-deps.ts`, `tests/helpers/fakes.ts`, `tests/core/ytdlp.test.ts`, `tests/core/run.test.ts`
- Test: `tests/core/youtube.test.ts`

**Interfaces:**
- Consumes: `Repo.createJob` with `title`/`videoId` (Task 2).
- Produces:
  - `parseYoutubeId(input: string): string | null`
  - `probeVideo(a: { ytdlpPath: string; url: string; signal?: AbortSignal }): Promise<{ durationMs: number; title: string | null }>` (replaces `getDurationMs`)
  - `buildProbeArgs(url)` prints duration then title (UTF-8)
  - `PipelineDeps.probe(source, signal?): Promise<{ durationMs: number; title: string | null }>` replaces `probeDurationMs`; `runJob` stores `title` and (for URLs) `videoId` on the job it creates.
  - `FakeOptions.title?: string | null` in `tests/helpers/fakes.ts`.

- [ ] **Step 1: Write the failing tests**

`tests/core/youtube.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseYoutubeId } from '../../src/core/youtube';

describe('parseYoutubeId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://www.youtube.com/watch?v=7SHNxjFuw10&list=PLxyz&index=4', '7SHNxjFuw10'],
    ['https://youtube.com/watch?feature=share&v=QGWaK-UF5QU', 'QGWaK-UF5QU'],
    ['https://m.youtube.com/watch?v=7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://music.youtube.com/watch?v=7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://youtu.be/7SHNxjFuw10?t=10', '7SHNxjFuw10'],
    ['https://www.youtube.com/shorts/7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://www.youtube.com/embed/7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://www.youtube.com/live/7SHNxjFuw10?si=x', '7SHNxjFuw10'],
    ['https://www.youtube-nocookie.com/embed/7SHNxjFuw10', '7SHNxjFuw10'],
  ])('extracts the id from %s', (url, id) => {
    expect(parseYoutubeId(url)).toBe(id);
  });

  it.each([
    'https://example.com/watch?v=7SHNxjFuw10',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/playlist?list=PLxyz',
    'https://youtu.be/',
    'C:\\videos\\clip.mp4',
    'not a url',
    '',
  ])('returns null for %j', (input) => {
    expect(parseYoutubeId(input)).toBeNull();
  });
});
```

In `tests/core/ytdlp.test.ts` replace the `buildProbeArgs` test body with:
```ts
    const args = buildProbeArgs(url);
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--skip-download');
    expect(args[args.indexOf('--encoding') + 1]).toBe('utf-8');
    const prints = args.flatMap((a, i) => (a === '--print' ? [args[i + 1]] : []));
    expect(prints).toEqual(['duration', 'title']);
    expect(args[args.length - 1]).toBe(url);
```

In `tests/helpers/fakes.ts`: add `title?: string | null;` to `FakeOptions` and replace `probeDurationMs: async () => opts.durationMs,` with `probe: async () => ({ durationMs: opts.durationMs, title: opts.title ?? null }),`.

Append to `tests/core/run.test.ts` inside `describe('runJob', ...)`:
```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test`
Expected: FAIL (module missing; probe args differ; `deps.probe` unused).

- [ ] **Step 3: Implement**

`src/core/youtube.ts`:
```ts
const ID = /^[A-Za-z0-9_-]{11}$/;

/** Extracts the video id from a YouTube watch/short/embed/live URL; null for anything else. */
export function parseYoutubeId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return ID.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  if (url.pathname === '/watch') {
    const v = url.searchParams.get('v') ?? '';
    return ID.test(v) ? v : null;
  }
  const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
  return m && ID.test(m[1]) ? m[1] : null;
}
```

`src/core/tools/ytdlp.ts`: replace `buildProbeArgs` and `getDurationMs` with
```ts
export function buildProbeArgs(url: string): string[] {
  return [
    '--no-playlist',
    '--skip-download',
    '--no-warnings',
    '--encoding',
    'utf-8',
    '--print',
    'duration',
    '--print',
    'title',
    url,
  ];
}
```
and
```ts
export async function probeVideo(a: {
  ytdlpPath: string;
  url: string;
  signal?: AbortSignal;
}): Promise<{ durationMs: number; title: string | null }> {
  const r = await runProcess(a.ytdlpPath, buildProbeArgs(a.url), { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('DownloadFailed', `yt-dlp could not read the video: ${lastLine(r.stderr)}. ${HINT}`);
  }
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim());
  const seconds = Number.parseFloat(lines[0] ?? '');
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new BgtError('InvalidInput', 'The video has no known duration (live streams are not supported yet).');
  }
  const title = lines.slice(1).join(' ').trim();
  return { durationMs: Math.round(seconds * 1000), title: title === '' || title === 'NA' ? null : title };
}
```

`src/core/pipeline/run.ts`:
- In `PipelineDeps` replace `probeDurationMs(source: string, signal?: AbortSignal): Promise<number>;` with `probe(source: string, signal?: AbortSignal): Promise<{ durationMs: number; title: string | null }>;`.
- Add `import { parseYoutubeId } from '../youtube';`.
- Replace `const durationMs = await deps.probeDurationMs(params.source, signal);` with
```ts
  const info = await deps.probe(params.source, signal);
  const durationMs = info.durationMs;
```
- In the `repo.createJob({ ... })` call add `title: info.title, videoId: parseYoutubeId(params.source),`.

`src/core/pipeline/real-deps.ts`:
- Import `probeVideo` instead of `getDurationMs` (`import { downloadAudio, probeVideo } from '../tools/ytdlp';`).
- Replace the `probeDurationMs` property with
```ts
    async probe(source, signal) {
      if (isUrl(source)) {
        return probeVideo({ ytdlpPath: resolveTool('yt-dlp'), url: source, signal });
      }
      if (!existsSync(source) || !statSync(source).isFile()) {
        throw new BgtError('InvalidInput', `File not found: ${source}`);
      }
      const durationMs = await probeDurationMs({ ffmpegPath, file: source, signal });
      return { durationMs, title: path.basename(source, path.extname(source)) };
    },
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Verify against real yt-dlp (UTF-8 title)**

Run:
```bash
resources/bin/yt-dlp.exe --no-playlist --skip-download --no-warnings --encoding utf-8 --print duration --print title "https://www.youtube.com/watch?v=7SHNxjFuw10"
```
Expected: two lines, `557` (or similar) then the title. If the title is mojibake or the flag is rejected, drop `--encoding utf-8` from `buildProbeArgs`, set `PYTHONIOENCODING=utf-8` via a new optional `env` in `RunOptions` (spawn option) instead, and update the args test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): parse YouTube ids and store video title with the job

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Progress events, job identity callback, shared database handle

**Files:**
- Create: `src/core/progress.ts`
- Modify: `src/core/pipeline/run.ts`, `src/core/pipeline/glossary-job.ts`, `src/core/pipeline/translate-job.ts`, `src/core/pipeline/summarize-job.ts`, `src/core/pipeline/stages.ts`, `src/core/pipeline/real-deps.ts`, `src/core/tools/paths.ts`
- Test: `tests/core/run.test.ts`, `tests/core/translate-job.test.ts`, `tests/core/glossary-job.test.ts`, `tests/core/summarize-job.test.ts`, `tests/core/paths.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `type ProgressStage = 'fetch' | 'transcribe' | 'glossary' | 'translate' | 'summarize'`; `interface ProgressEvent { stage: ProgressStage; done: number; total: number; message: string }`
  - `PipelineDeps.progress?(e: ProgressEvent): void`; `RunParams.onJob?(job: JobRow): void` (called once the job row exists, before any work)
  - `progress?: (e: ProgressEvent) => void` argument on `runGlossaryStage`, `runTranslateStage`, `runSummarizeStage`, and `StageContext.progress?`
  - `createRealDeps` accepts optional `db?: Database`; when given, it is used and `close()` does not close it.
  - `projectRoot()` honors `BGT_PROJECT_ROOT`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/run.test.ts` inside `describe('runJob', ...)`:
```ts
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
```
Append to `tests/core/translate-job.test.ts` inside its `describe`:
```ts
  it('reports progress per batch', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, texts);
    const events: [number, number][] = [];
    await runTranslateStage({
      repo,
      stages,
      translator: new HyMtTranslator(scriptedChat(echoTranslate())),
      jobId: job.id,
      batchSize: 2,
      log: () => {},
      progress: (e) => {
        expect(e.stage).toBe('translate');
        events.push([e.done, e.total]);
      },
    });
    expect(events).toEqual([[1, 3], [2, 3], [3, 3]]);
  });
```
Append to `tests/core/glossary-job.test.ts` inside its `describe`:
```ts
  it('reports one progress event per window', async () => {
    const llm = scriptedChat(() => '[]');
    const ctx = base(llm);
    const events: [number, number][] = [];
    await runGlossaryStage({
      repo: ctx.repo,
      stages: ctx.stages,
      llm,
      jobId: ctx.job.id,
      userGlossary: {},
      log: ctx.log,
      progress: (e) => events.push([e.done, e.total]),
    });
    expect(events).toEqual([[1, 1]]);
  });
```
Append to `tests/core/summarize-job.test.ts` inside its `describe`:
```ts
  it('reports progress per window', async () => {
    const events: [number, number][] = [];
    await run(['a', 'b', 'c', 'd', 'e', 'f'], { progress: (e) => events.push([e.done, e.total]) });
    expect(events).toEqual([[1, 2], [2, 2]]);
  });
```
Append to `tests/core/paths.test.ts` (new `describe` at the end of the file; add `projectRoot` to the import from `../../src/core/tools/paths`):
```ts
describe('projectRoot', () => {
  it('honors BGT_PROJECT_ROOT', () => {
    process.env.BGT_PROJECT_ROOT = path.join(os.tmpdir(), 'somewhere');
    try {
      expect(projectRoot()).toBe(path.join(os.tmpdir(), 'somewhere'));
    } finally {
      delete process.env.BGT_PROJECT_ROOT;
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test`
Expected: FAIL (new options/events do not exist; typecheck errors for `progress`/`onJob`).

- [ ] **Step 3: Implement**

`src/core/progress.ts`:
```ts
export type ProgressStage = 'fetch' | 'transcribe' | 'glossary' | 'translate' | 'summarize';

export interface ProgressEvent {
  stage: ProgressStage;
  done: number;
  total: number;
  message: string;
}
```

`src/core/tools/paths.ts`: change `projectRoot` to
```ts
export function projectRoot(): string {
  return process.env.BGT_PROJECT_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));
}
```

`src/core/pipeline/run.ts`:
- `import type { ProgressEvent } from '../progress';`
- In `PipelineDeps` add `progress?(e: ProgressEvent): void;`. In `RunParams` add `onJob?(job: JobRow): void;`.
- After `repo.setJobStatus(job.id, 'running');` add `params.onJob?.(job);`.
- Around the fetch: immediately before `log('Fetching audio...');` add `deps.progress?.({ stage: 'fetch', done: 0, total: 1, message: 'Fetching audio' });` and immediately after `renameSync(partial, wavPath);` add `deps.progress?.({ stage: 'fetch', done: 1, total: 1, message: 'Audio ready' });`.
- After `const chunks = repo.listChunks(job.id);` add
```ts
  let finished = chunks.filter((c) => c.status === 'done').length;
  deps.progress?.({ stage: 'transcribe', done: finished, total: chunks.length, message: 'Transcribing' });
```
and inside the `if (ok) { ... }` branch, after `writeOutputs(repo, job, params.outDir);`, add
```ts
      finished++;
      deps.progress?.({ stage: 'transcribe', done: finished, total: chunks.length, message: `Chunk ${finished}/${chunks.length}` });
```

Stage runners: add an optional `progress?: (e: ProgressEvent) => void;` argument and emit:
- `glossary-job.ts`: in the window loop, after the `try/catch` for a window (so failures also advance), `progress?.({ stage: 'glossary', done: window.idx + 1, total: windows.length, message: 'Finding names' });`.
- `translate-job.ts`: after `a.onBatch?.();` add `a.progress?.({ stage: 'translate', done: batchIdx + 1, total: totalBatches, message: 'Translating' });`.
- `summarize-job.ts`: in the window loop, after the `try/catch` and also for the `continue` case (finished windows still count), emit `progress?.({ stage: 'summarize', done: window.idx + 1, total: windows.length, message: 'Summarizing' });`. Implement by moving the `continue` check: `if (!windowRows.has(window.idx)) { ...existing try/catch... }` followed by the emit.
- `stages.ts`: add `progress?: (e: ProgressEvent) => void;` to `StageContext` and pass `progress: ctx.progress` into the three runner calls.

`src/core/pipeline/real-deps.ts`: import `type { Database } from '../db/sqlite'`; add `db?: Database;` to the options type; replace `const db = openDb(path.join(a.dataDir, 'bgt.sqlite'));` with
```ts
  const ownsDb = !a.db;
  const db = a.db ?? openDb(path.join(a.dataDir, 'bgt.sqlite'));
```
and the return's `close` with `close: () => { if (ownsDb) db.close(); }`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): structured progress events, job callback, shared db handle

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Electron + React scaffold with a smoke test

**Files:**
- Create: `electron.vite.config.ts`, `tsconfig.web.json`, `scripts/smoke-app.mjs`, `src/app/main/index.ts`, `src/app/preload/index.ts`, `src/app/renderer/index.html`, `src/app/renderer/main.tsx`, `src/app/renderer/App.tsx`, `src/app/renderer/env.d.ts`, `src/app/shared/ipc.ts`
- Modify: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime.
- Produces: `pnpm dev:app`, `pnpm build:app`, `pnpm smoke:app` (prints `SMOKE OK` and exits 0 when the built app's window loads and `window.bgt.ping()` resolves `"pong"`). Shared type `BgtApi` with only `ping(): Promise<string>` for now (extended in Task 6). ESLint boundaries from the Global Constraints. Typecheck covers both `tsconfig.json` (Node code) and `tsconfig.web.json` (renderer).

- [ ] **Step 1: Install dependencies**

Run:
```bash
pnpm add react react-dom
pnpm add -D electron electron-vite vite @vitejs/plugin-react @types/react @types/react-dom jsdom @testing-library/react
```
In `pnpm-workspace.yaml` add `electron: true` under `allowBuilds`, then run `pnpm install` so the Electron binary downloads.
Expected: install succeeds; `pnpm exec electron --version` prints `v44.x`.

- [ ] **Step 2: Write the configs**

`package.json`: add `"main": "out/main/index.js"` and scripts
```json
    "dev:app": "electron-vite dev",
    "build:app": "electron-vite build",
    "smoke:app": "node scripts/smoke-app.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.web.json"
```
(replace the existing `typecheck`).

`electron.vite.config.ts`:
```ts
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/app/main/index.ts') },
        external: [/^node:/],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/app/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/app/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve('src/app/renderer/index.html') } } },
  },
});
```

`tsconfig.json`: add `"exclude": ["src/app/renderer", "tests/renderer", "node_modules", "out"]` (keep the existing `include`).

`tsconfig.web.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": []
  },
  "include": ["src/app/renderer", "src/app/shared", "tests/renderer"]
}
```
Renderer files that import from `../../core/...` (types, and the pure modules) are pulled in transitively; `core/time.ts`, `core/errors.ts` and `core/youtube.ts` need no Node types. If `tsc` complains about `process`/`node:` types for a transitively imported core file, that file does not belong in the renderer allow-list (fix the import, do not add Node types).

`vitest.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    testTimeout: 20_000,
  },
});
```

`.gitignore`: add `out/`.

`eslint.config.js`: add `'out'` to the `ignores` array and append two config objects:
```js
  {
    files: ['src/app/renderer/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*', 'node:*'], message: 'The renderer must not use Node or Electron APIs; use window.bgt.' },
            {
              group: ['**/core/**', '!**/core/time', '!**/core/errors', '!**/core/youtube'],
              allowTypeImports: true,
              message: 'The renderer may only import types and the pure modules core/time, core/errors, core/youtube.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**'], allowTypeImports: true, message: 'src/app/shared is types only.' }] },
      ],
    },
  },
```
(The existing `src/core/**` rule already forbids `**/main/*` etc., which covers `src/app/main`.)

- [ ] **Step 3: Write the shared type, preload, main, renderer**

`src/app/shared/ipc.ts`:
```ts
export interface BgtApi {
  ping(): Promise<string>;
}
```

`src/app/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { BgtApi } from '../shared/ipc';

const api: BgtApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
};

contextBridge.exposeInMainWorld('bgt', api);
```

`src/app/main/index.ts`:
```ts
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';

const smoke = process.argv.includes('--smoke');
// `import.meta.url`-based root discovery in src/core does not work from a bundle.
process.env.BGT_PROJECT_ROOT ??= app.getAppPath();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: !smoke,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

void app.whenReady().then(() => {
  ipcMain.handle('app:ping', () => 'pong');
  const win = createWindow();

  if (smoke) {
    const timer = setTimeout(() => {
      console.error('SMOKE TIMEOUT');
      app.exit(1);
    }, 30_000);
    win.webContents.once('did-finish-load', async () => {
      try {
        const reply = await win.webContents.executeJavaScript(
          'window.bgt ? window.bgt.ping() : Promise.resolve("no-bridge")',
        );
        clearTimeout(timer);
        if (reply === 'pong') {
          console.log('SMOKE OK');
          app.exit(0);
        } else {
          console.error(`SMOKE FAIL: ${String(reply)}`);
          app.exit(1);
        }
      } catch (err) {
        console.error('SMOKE ERROR', err);
        app.exit(1);
      }
    });
  }
});

app.on('window-all-closed', () => app.quit());
```

`src/app/renderer/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>BG Auto Translator</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/app/renderer/env.d.ts`:
```ts
import type { BgtApi } from '../shared/ipc';

declare global {
  interface Window {
    bgt: BgtApi;
  }
}

export {};
```

`src/app/renderer/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`src/app/renderer/App.tsx`:
```tsx
export function App() {
  return <h1>BG Auto Translator</h1>;
}
```

`scripts/smoke-app.mjs`:
```js
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron'); // the electron package exports the binary path
const result = spawnSync(electronPath, ['.', '--smoke'], { encoding: 'utf8', timeout: 60_000 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status === 0 && (result.stdout ?? '').includes('SMOKE OK') ? 0 : 1);
```

- [ ] **Step 4: Build and smoke**

Run: `pnpm build:app && ls out/main out/preload out/renderer && pnpm smoke:app`
Expected: the build succeeds; `out/preload/index.cjs` exists; the smoke prints `SMOKE OK` and exits 0.
If the preload file has a different name, adjust the `preload:` path in `main/index.ts` and the `entryFileNames` setting until it matches. If `ping` never resolves because the sandboxed preload failed to load, run `pnpm exec electron . --enable-logging 2>&1 | head -30` to read the error. If a `node:` import is reported unresolved, confirm the `external: [/^node:/]` entry is in the main config.

- [ ] **Step 5: Run the project checks**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(app): electron-vite scaffold with sandboxed preload and smoke test

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: IPC contract, validation, and library service

**Files:**
- Modify: `src/app/shared/ipc.ts`
- Create: `src/app/main/validate.ts`, `src/app/main/library-service.ts`
- Test: `tests/app/validate.test.ts`, `tests/app/library-service.test.ts`

**Interfaces:**
- Consumes: `Submission`/`SubmissionOptions` (Task 2), `ProgressEvent` (Task 4), `Repo.listJobs`, `StageRepo.countTranslations/countSummaries/listTranslations/listSummaries`, `isUrl` (real-deps).
- Produces (all types in `shared/ipc.ts`):
  - `Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }`
  - `LibraryItem { jobId; title: string | null; source: string; videoId: string | null; status: 'pending'|'running'|'done'|'failed'; rangeStartMs; rangeEndMs; createdAt; hasTranslation: boolean; hasSummary: boolean; isLocalFile: boolean }`
  - `TranscriptLine { id: number; startMs: number; endMs: number; ja: string; en: string | null }`
  - `JobDetail { item: LibraryItem; lines: TranscriptLine[]; summaries: SummaryRow[] }`
  - `ProbeResult { title: string | null; durationMs: number }`
  - `SubmitRequest { source: string; startMs: number; endMs: number | null; options: SubmissionOptions }`
  - `QueueProgressEvent { submissionId: number; event: ProgressEvent }`
  - `BgtApi` (full surface, see Step 3) and `const CHANNELS`.
  - `parseSubmitRequest(raw: unknown): SubmitRequest`, `parseId(raw: unknown, what: string): number`, `parseSource(raw: unknown): string`, `parseEstimateArgs(raw: unknown): { durationMs: number; startMs: number; endMs: number | null }` (all throw `BgtError('InvalidInput', ...)`).
  - `listLibrary(repo, stages): LibraryItem[]`, `getJobDetail(repo, stages, jobId): JobDetail | null`.

- [ ] **Step 1: Write the failing tests**

`tests/app/validate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseEstimateArgs, parseId, parseSource, parseSubmitRequest } from '../../src/app/main/validate';

const good = {
  source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
  startMs: 0,
  endMs: 60_000,
  options: { translate: true, summarize: true, skim: false, maxMinutes: 30, model: 'large-v3' },
};

const bad = (raw: unknown, text: RegExp) =>
  expect(() => parseSubmitRequest(raw)).toThrow(expect.objectContaining({ code: 'InvalidInput', message: expect.stringMatching(text) }));

describe('parseSubmitRequest', () => {
  it('accepts a valid request and fills defaults', () => {
    expect(parseSubmitRequest(good)).toEqual(good);
    expect(parseSubmitRequest({ ...good, endMs: null, options: { translate: false, summarize: false, skim: false } })).toMatchObject({
      endMs: null,
      options: { maxMinutes: 30, model: 'large-v3' },
    });
  });

  it('trims the source and keeps a glossary path', () => {
    const r = parseSubmitRequest({ ...good, source: '  C:/a/b.wav ', options: { ...good.options, glossaryPath: 'C:/g.json' } });
    expect(r.source).toBe('C:/a/b.wav');
    expect(r.options.glossaryPath).toBe('C:/g.json');
  });

  it.each([
    ['not an object', 42, /request/i],
    ['empty source', { ...good, source: '   ' }, /source/i],
    ['non-string source', { ...good, source: 5 }, /source/i],
    ['negative start', { ...good, startMs: -1 }, /start/i],
    ['fractional start', { ...good, startMs: 1.5 }, /start/i],
    ['end before start', { ...good, startMs: 5000, endMs: 5000 }, /end/i],
    ['missing options', { ...good, options: undefined }, /options/i],
    ['skim with translate', { ...good, options: { ...good.options, skim: true, translate: true } }, /skim/i],
    ['bad model name', { ...good, options: { ...good.options, model: '../evil' } }, /model/i],
    ['absurd cap', { ...good, options: { ...good.options, maxMinutes: 100000 } }, /maxMinutes/i],
  ])('rejects %s', (_name, raw, text) => bad(raw, text));
});

describe('small parsers', () => {
  it('parseId accepts positive integers only', () => {
    expect(parseId(7, 'job id')).toBe(7);
    for (const v of [0, -1, 1.5, '3', null, NaN]) {
      expect(() => parseId(v, 'job id')).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    }
  });

  it('parseSource trims and rejects blanks', () => {
    expect(parseSource(' x ')).toBe('x');
    expect(() => parseSource('')).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
  });

  it('parseEstimateArgs validates the numbers', () => {
    expect(parseEstimateArgs({ durationMs: 600_000, startMs: 0, endMs: null })).toEqual({ durationMs: 600_000, startMs: 0, endMs: null });
    expect(() => parseEstimateArgs({ durationMs: 0, startMs: 0, endMs: null })).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    expect(() => parseEstimateArgs('x')).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
  });
});
```

`tests/app/library-service.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { getJobDetail, listLibrary } from '../../src/app/main/library-service';
import { memoryRepos, seedJob } from '../helpers/fakes';

describe('listLibrary', () => {
  it('lists jobs newest first with translation and summary flags', () => {
    const { repo, stages } = memoryRepos();
    const a = seedJob(repo, ['あ']);
    const b = seedJob(repo, ['い']);
    const [seg] = repo.listSegmentsWithId(b.id);
    stages.saveTranslations(b.id, 0, [{ segmentId: seg.id, text: 'I' }]);
    stages.saveSummary(b.id, { level: 'overview', idx: 0, startMs: 0, endMs: 1, text: 'O' });
    const items = listLibrary(repo, stages);
    expect(items.map((i) => i.jobId)).toEqual([b.id, a.id]);
    expect(items[0]).toMatchObject({ hasTranslation: true, hasSummary: true, isLocalFile: true });
    expect(items[1]).toMatchObject({ hasTranslation: false, hasSummary: false });
  });

  it('marks URL sources as not local', () => {
    const { repo, stages } = memoryRepos();
    const job = repo.createJob({
      source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
      rangeStartMs: 0,
      rangeEndMs: 1000,
      settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 },
      title: 'Hi',
      videoId: '7SHNxjFuw10',
    });
    expect(listLibrary(repo, stages)[0]).toMatchObject({ jobId: job.id, isLocalFile: false, videoId: '7SHNxjFuw10', title: 'Hi' });
  });
});

describe('getJobDetail', () => {
  it('returns lines with absolute video times, English when present, and summaries', () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い'], { rangeStartMs: 60_000, stepMs: 2000 });
    const [a, b] = repo.listSegmentsWithId(job.id);
    stages.saveTranslations(job.id, 0, [{ segmentId: a.id, text: 'A' }, { segmentId: b.id, text: '' }]);
    stages.saveSummary(job.id, { level: 'overview', idx: 0, startMs: 60_000, endMs: 64_000, text: 'Overview' });
    const detail = getJobDetail(repo, stages, job.id);
    expect(detail?.lines).toEqual([
      { id: a.id, startMs: 60_000, endMs: 61_500, ja: 'あ', en: 'A' },
      { id: b.id, startMs: 62_000, endMs: 63_500, ja: 'い', en: null },
    ]);
    expect(detail?.summaries).toHaveLength(1);
    expect(detail?.item.jobId).toBe(job.id);
  });

  it('returns null for an unknown job', () => {
    const { repo, stages } = memoryRepos();
    expect(getJobDetail(repo, stages, 99)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/app`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

Replace `src/app/shared/ipc.ts` with:
```ts
import type { JobStatus } from '../../core/db/repo';
import type { SummaryRow } from '../../core/db/stage-repo';
import type { Submission, SubmissionOptions } from '../../core/db/submission-repo';
import type { ProgressEvent } from '../../core/progress';

export type { Submission, SubmissionOptions, SummaryRow, ProgressEvent, JobStatus };
export type { SubmissionState } from '../../core/db/submission-repo';

export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface LibraryItem {
  jobId: number;
  title: string | null;
  source: string;
  videoId: string | null;
  status: JobStatus;
  rangeStartMs: number;
  rangeEndMs: number;
  createdAt: string;
  hasTranslation: boolean;
  hasSummary: boolean;
  isLocalFile: boolean;
}

export interface TranscriptLine {
  id: number;
  startMs: number;
  endMs: number;
  ja: string;
  en: string | null;
}

export interface JobDetail {
  item: LibraryItem;
  lines: TranscriptLine[];
  summaries: SummaryRow[];
}

export interface ProbeResult {
  title: string | null;
  durationMs: number;
}

export interface SubmitRequest {
  source: string;
  startMs: number;
  endMs: number | null;
  options: SubmissionOptions;
}

export interface QueueProgressEvent {
  submissionId: number;
  event: ProgressEvent;
}

export interface BgtApi {
  ping(): Promise<string>;
  library: { list(): Promise<Result<LibraryItem[]>> };
  job: {
    get(jobId: number): Promise<Result<JobDetail>>;
    openOutputFolder(jobId: number): Promise<Result<null>>;
  };
  queue: {
    list(): Promise<Result<Submission[]>>;
    submit(request: SubmitRequest): Promise<Result<Submission>>;
    cancel(id: number): Promise<Result<null>>;
    resume(id: number): Promise<Result<null>>;
    onChanged(cb: (submissions: Submission[]) => void): () => void;
    onProgress(cb: (p: QueueProgressEvent) => void): () => void;
  };
  source: {
    probe(source: string): Promise<Result<ProbeResult>>;
    estimate(a: { durationMs: number; startMs: number; endMs: number | null }): Promise<Result<number | null>>;
  };
  dialog: {
    pickMedia(): Promise<Result<string | null>>;
    pickGlossary(): Promise<Result<string | null>>;
    /** Absolute path of a dropped file (synchronous; resolved in the preload). */
    pathForFile(file: File): string;
  };
}

/** IPC channel names, shared by main and preload. */
export const CHANNELS = {
  ping: 'app:ping',
  libraryList: 'library:list',
  jobGet: 'job:get',
  jobOpenOutputFolder: 'job:openOutputFolder',
  queueList: 'queue:list',
  queueSubmit: 'queue:submit',
  queueCancel: 'queue:cancel',
  queueResume: 'queue:resume',
  queueChanged: 'queue:changed',
  queueProgress: 'queue:progress',
  sourceProbe: 'source:probe',
  sourceEstimate: 'source:estimate',
  dialogPickMedia: 'dialog:pickMedia',
  dialogPickGlossary: 'dialog:pickGlossary',
} as const;
```
(`CHANNELS` is a value, so `shared/ipc.ts` is not purely types any more; relax the `src/app/shared` ESLint rule from Task 5 to allow value declarations but still forbid runtime imports: keep `allowTypeImports: true` and the `**` group, which only restricts imports.)

`src/app/main/validate.ts`:
```ts
import type { SubmissionOptions } from '../../core/db/submission-repo';
import { BgtError } from '../../core/errors';
import type { SubmitRequest } from '../shared/ipc';

const invalid = (message: string) => new BgtError('InvalidInput', message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function parseSource(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw invalid('Enter a YouTube URL or choose a file (source is empty).');
  return raw.trim();
}

export function parseId(raw: unknown, what: string): number {
  if (!isInt(raw) || raw < 1) throw invalid(`Invalid ${what}.`);
  return raw;
}

export function parseEstimateArgs(raw: unknown): { durationMs: number; startMs: number; endMs: number | null } {
  if (!isObject(raw)) throw invalid('Invalid estimate request.');
  const { durationMs, startMs, endMs } = raw;
  if (!isInt(durationMs) || durationMs < 1) throw invalid('Invalid duration.');
  if (!isInt(startMs) || startMs < 0) throw invalid('Invalid start time.');
  if (endMs !== null && !isInt(endMs)) throw invalid('Invalid end time.');
  return { durationMs, startMs, endMs: endMs as number | null };
}

export function parseSubmitRequest(raw: unknown): SubmitRequest {
  if (!isObject(raw)) throw invalid('Invalid request.');
  const source = parseSource(raw.source);
  const { startMs, endMs } = raw;
  if (!isInt(startMs) || startMs < 0) throw invalid('Start time must be a non-negative whole number of milliseconds.');
  if (endMs !== null && endMs !== undefined && (!isInt(endMs) || endMs <= startMs)) {
    throw invalid('End time must be after the start time.');
  }
  const o = raw.options;
  if (!isObject(o)) throw invalid('Missing options.');
  const translate = o.translate === true;
  const summarize = o.summarize === true;
  const skim = o.skim === true;
  if (skim && translate) throw invalid('Skim skips full translation, so it cannot be combined with Translate.');
  const maxMinutes = o.maxMinutes === undefined ? 30 : o.maxMinutes;
  if (typeof maxMinutes !== 'number' || !Number.isFinite(maxMinutes) || maxMinutes < 1 || maxMinutes > 600) {
    throw invalid('maxMinutes must be between 1 and 600.');
  }
  const model = o.model === undefined ? 'large-v3' : o.model;
  if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(model)) throw invalid('Invalid model name.');
  const options: SubmissionOptions = { translate, summarize, skim, maxMinutes, model };
  if (typeof o.glossaryPath === 'string' && o.glossaryPath.trim() !== '') options.glossaryPath = o.glossaryPath.trim();
  return { source, startMs, endMs: endMs === undefined ? null : (endMs as number | null), options };
}
```

`src/app/main/library-service.ts`:
```ts
import type { JobRow, Repo } from '../../core/db/repo';
import type { StageRepo } from '../../core/db/stage-repo';
import { isUrl } from '../../core/pipeline/real-deps';
import type { JobDetail, LibraryItem } from '../shared/ipc';

function toItem(job: JobRow, stages: StageRepo): LibraryItem {
  return {
    jobId: job.id,
    title: job.title,
    source: job.source,
    videoId: job.videoId,
    status: job.status,
    rangeStartMs: job.rangeStartMs,
    rangeEndMs: job.rangeEndMs,
    createdAt: job.createdAt,
    hasTranslation: stages.countTranslations(job.id) > 0,
    hasSummary: stages.countSummaries(job.id) > 0,
    isLocalFile: !isUrl(job.source),
  };
}

export function listLibrary(repo: Repo, stages: StageRepo): LibraryItem[] {
  return repo.listJobs().map((job) => toItem(job, stages));
}

export function getJobDetail(repo: Repo, stages: StageRepo, jobId: number): JobDetail | null {
  const job = repo.getJob(jobId);
  if (!job) return null;
  const translations = stages.listTranslations(jobId);
  const lines = repo.listSegmentsWithId(jobId).map((s) => ({
    id: s.id,
    startMs: s.startMs + job.rangeStartMs,
    endMs: s.endMs + job.rangeStartMs,
    ja: s.text,
    en: (translations.get(s.id) ?? '') === '' ? null : (translations.get(s.id) as string),
  }));
  return { item: toItem(job, stages), lines, summaries: stages.listSummaries(jobId) };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(app): IPC contract, request validation and library service

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: JobQueue

**Files:**
- Create: `src/app/main/queue.ts`
- Test: `tests/app/queue.test.ts`

**Interfaces:**
- Consumes: `SubmissionStore`, `Submission`, `SubmissionOptions` (Task 2), `ProgressEvent` (Task 4), `QueueProgressEvent` (Task 6), `BgtError`.
- Produces: `interface RunContext { signal: AbortSignal; progress(e: ProgressEvent): void; onJob(jobId: number): void }`; `interface QueueDeps { store: SubmissionStore; run(sub: Submission, ctx: RunContext): Promise<void>; emitChanged(subs: Submission[]): void; emitProgress(p: QueueProgressEvent): void }`; `class JobQueue(deps)` with `start()` (recovers `running` to `interrupted`, then processes), `submit(req: { source; startMs; endMs; options }): Submission`, `cancel(id)`, `resume(id)`, `list()`, `whenIdle(): Promise<void>`, `shutdown(): Promise<void>` (aborts the running job, marks it `interrupted`, never starts another). `run` rejecting with a `BgtError` records `"<code>: <message>"`; any other error records its message.

- [ ] **Step 1: Write the failing tests**

`tests/app/queue.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/core/db/schema';
import { Database } from '../../src/core/db/sqlite';
import { SubmissionStore, type Submission } from '../../src/core/db/submission-repo';
import { BgtError } from '../../src/core/errors';
import { JobQueue, type RunContext } from '../../src/app/main/queue';

const options = { translate: false, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3' };
const req = (source: string) => ({ source, startMs: 0, endMs: null, options });

interface Harness {
  store: SubmissionStore;
  queue: JobQueue;
  started: string[];
  progress: { submissionId: number; stage: string }[];
  changed: number;
  /** resolve/reject the currently running submission's `run` */
  finish: (source: string, err?: unknown) => void;
  contexts: Map<string, RunContext>;
}

function harness(): Harness {
  const db = new Database(':memory:');
  migrate(db);
  const store = new SubmissionStore(db);
  const pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
  const contexts = new Map<string, RunContext>();
  const h = { started: [] as string[], progress: [] as { submissionId: number; stage: string }[], changed: 0 } as Harness;
  const queue = new JobQueue({
    store,
    run: (sub: Submission, ctx: RunContext) =>
      new Promise<void>((resolve, reject) => {
        h.started.push(sub.source);
        contexts.set(sub.source, ctx);
        pending.set(sub.source, { resolve, reject });
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason ?? new Error('aborted')));
      }),
    emitChanged: () => {
      h.changed++;
    },
    emitProgress: (p) => h.progress.push({ submissionId: p.submissionId, stage: p.event.stage }),
  });
  h.store = store;
  h.queue = queue;
  h.contexts = contexts;
  h.finish = (source, err) => (err ? pending.get(source)?.reject(err) : pending.get(source)?.resolve());
  return h;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('JobQueue', () => {
  it('runs one submission at a time, in order', async () => {
    h.queue.submit(req('a'));
    h.queue.submit(req('b'));
    await tick();
    expect(h.started).toEqual(['a']);
    h.finish('a');
    await tick();
    expect(h.started).toEqual(['a', 'b']);
    h.finish('b');
    await h.queue.whenIdle();
    expect(h.queue.list().map((s) => s.state)).toEqual(['done', 'done']);
  });

  it('records a BgtError as "code: message" and moves on to the next submission', async () => {
    h.queue.submit(req('a'));
    h.queue.submit(req('b'));
    await tick();
    h.finish('a', new BgtError('DownloadFailed', 'nope'));
    await tick();
    expect(h.queue.list()[0]).toMatchObject({ state: 'failed', error: 'DownloadFailed: nope' });
    expect(h.started).toEqual(['a', 'b']);
  });

  it('records a plain error message', async () => {
    h.queue.submit(req('a'));
    await tick();
    h.finish('a', new Error('kaput'));
    await h.queue.whenIdle();
    expect(h.queue.list()[0]).toMatchObject({ state: 'failed', error: 'kaput' });
  });

  it('cancels the running submission, aborting its signal, then starts the next', async () => {
    const a = h.queue.submit(req('a'));
    h.queue.submit(req('b'));
    await tick();
    h.queue.cancel(a.id);
    await tick();
    expect(h.contexts.get('a')?.signal.aborted).toBe(true);
    expect(h.queue.list()[0].state).toBe('cancelled');
    expect(h.started).toEqual(['a', 'b']);
  });

  it('cancels a queued submission without ever running it', async () => {
    h.queue.submit(req('a'));
    const b = h.queue.submit(req('b'));
    await tick();
    h.queue.cancel(b.id);
    h.finish('a');
    await h.queue.whenIdle();
    expect(h.started).toEqual(['a']);
    expect(h.queue.list()[1].state).toBe('cancelled');
  });

  it('resume re-queues failed, cancelled and interrupted submissions only', async () => {
    const a = h.queue.submit(req('a'));
    await tick();
    h.finish('a', new Error('x'));
    await h.queue.whenIdle();
    h.queue.resume(a.id);
    await tick();
    expect(h.started).toEqual(['a', 'a']);
    expect(h.queue.list()[0]).toMatchObject({ state: 'running', error: null });
    h.queue.resume(a.id); // running: ignored
    expect(h.started).toEqual(['a', 'a']);
    h.finish('a');
    await h.queue.whenIdle();
    h.queue.resume(a.id); // done: ignored
    await tick();
    expect(h.started).toEqual(['a', 'a']);
  });

  it('start() turns leftover running submissions into interrupted and does not run them', async () => {
    const a = h.store.create(req('a'));
    h.store.setState(a.id, 'running');
    const queued = h.store.create(req('b'));
    h.queue.start();
    await tick();
    expect(h.store.get(a.id)?.state).toBe('interrupted');
    expect(h.started).toEqual(['b']);
    expect(h.store.get(queued.id)?.state).toBe('running');
  });

  it('shutdown aborts the running job, marks it interrupted and starts nothing else', async () => {
    const a = h.queue.submit(req('a'));
    h.queue.submit(req('b'));
    await tick();
    await h.queue.shutdown();
    expect(h.contexts.get('a')?.signal.aborted).toBe(true);
    expect(h.store.get(a.id)?.state).toBe('interrupted');
    expect(h.started).toEqual(['a']);
    h.queue.submit(req('c'));
    await tick();
    expect(h.started).toEqual(['a']);
  });

  it('links the job and forwards progress with the submission id', async () => {
    const a = h.queue.submit(req('a'));
    await tick();
    const ctx = h.contexts.get('a') as RunContext;
    ctx.onJob(42);
    ctx.progress({ stage: 'transcribe', done: 1, total: 3, message: 'x' });
    expect(h.store.get(a.id)?.jobId).toBe(42);
    expect(h.progress).toEqual([{ submissionId: a.id, stage: 'transcribe' }]);
    h.finish('a');
    await h.queue.whenIdle();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/app/queue.test.ts`
Expected: FAIL, cannot resolve `queue`.

- [ ] **Step 3: Implement**

`src/app/main/queue.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(app): sequential job queue with cancel, resume and shutdown

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Running a submission through the core

**Files:**
- Create: `src/app/main/run-submission.ts`
- Test: `tests/app/run-submission.test.ts`

**Interfaces:**
- Consumes: `runJob`, `PipelineDeps`, `RunParams` (Tasks 3 and 4), `runLlmStages`, `ModelPool`, `loadGlossaryFile`, `Submission` (Task 2), `RunContext` (Task 7), `Repo`, `StageRepo`, `BgtError`.
- Produces: `interface RunSubmissionEnv { repo: Repo; stages: StageRepo; makeDeps(sub: Submission): PipelineDeps; workRoot: string; outDir: string; pool: ModelPool; log(m: string): void }` and `runSubmission(env: RunSubmissionEnv, sub: Submission, ctx: RunContext): Promise<void>`. It loads the glossary file first (fail fast), runs `runJob` with `progress` and `onJob` wired to `ctx`, throws `BgtError('TranscribeFailed', ...)` if any chunk failed, then runs the LLM stages only if `translate`, `summarize` or `skim` is set, always stopping the pool afterward.

- [ ] **Step 1: Write the failing tests**

`tests/app/run-submission.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSubmission, type RunSubmissionEnv } from '../../src/app/main/run-submission';
import type { RunContext } from '../../src/app/main/queue';
import type { Submission } from '../../src/core/db/submission-repo';
import type { LlmChat } from '../../src/core/llm/client';
import type { ModelPool, ModelRole } from '../../src/core/pipeline/stages';
import type { Segment } from '../../src/core/types';
import { echoTranslate, scriptedChat } from '../helpers/llm-fakes';
import { makeFakeDeps, memoryRepos } from '../helpers/fakes';

const seg = (text: string, startMs: number, endMs: number): Segment => ({ startMs, endMs, text, lang: 'ja', avgLogprob: -0.3 });

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-runsub-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakePool(chats: Record<ModelRole, LlmChat>) {
  const used: ModelRole[] = [];
  const pool: ModelPool & { used: ModelRole[]; stopped: number } = {
    used,
    stopped: 0,
    async use(role) {
      used.push(role);
      return chats[role];
    },
    async stopAll() {
      pool.stopped++;
    },
  };
  return pool;
}

const generalAnswer = (m: { content: string }[]) => {
  const c = m[m.length - 1].content;
  if (c.includes('JSON array')) return '[]';
  if (c.includes('overview in English')) return 'Overview';
  return '- [0:00:00] Something';
};

function setup(over: { truth?: Segment[]; onTranscribe?: (f: string) => void } = {}) {
  const { repo, stages } = memoryRepos();
  const fakes = makeFakeDeps(repo, {
    durationMs: 600_000,
    truth: over.truth ?? [seg('あ', 1000, 2000), seg('い', 3000, 4000)],
    onTranscribe: over.onTranscribe,
  });
  const translate = scriptedChat(echoTranslate());
  const pool = fakePool({ general: scriptedChat(generalAnswer), translate });
  const env: RunSubmissionEnv = {
    repo,
    stages,
    makeDeps: () => fakes.deps,
    workRoot: path.join(root, 'work'),
    outDir: path.join(root, 'out'),
    pool,
    log: () => {},
  };
  const events: string[] = [];
  const jobs: number[] = [];
  const ctx: RunContext = {
    signal: new AbortController().signal,
    progress: (e) => events.push(e.stage),
    onJob: (id) => jobs.push(id),
  };
  return { env, ctx, repo, stages, pool, translate, events, jobs };
}

const sub = (options: Partial<Submission['options']> = {}): Submission => ({
  id: 1,
  source: '/tmp/clip.wav',
  startMs: 0,
  endMs: null,
  options: { translate: false, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3', ...options },
  state: 'running',
  jobId: null,
  error: null,
  createdAt: '',
  updatedAt: '',
});

describe('runSubmission', () => {
  it('transcribes only when no LLM option is set, reporting the job and progress, without using models', async () => {
    const t = setup();
    await runSubmission(t.env, sub(), t.ctx);
    expect(t.jobs).toEqual([1]);
    expect(t.events).toContain('fetch');
    expect(t.events).toContain('transcribe');
    expect(t.pool.used).toEqual([]);
    expect(t.repo.listSegments(1).map((s) => s.text)).toEqual(['あ', 'い']);
  });

  it('runs translate and summarize stages and always stops the model pool', async () => {
    const t = setup();
    await runSubmission(t.env, sub({ translate: true, summarize: true }), t.ctx);
    expect(t.pool.used).toEqual(['general', 'translate', 'general']);
    expect(t.pool.stopped).toBe(1);
    expect(t.stages.getStage(1, 'translate')).toBe('done');
    expect(t.stages.getStage(1, 'summarize')).toBe('done');
    expect(t.events).toEqual(expect.arrayContaining(['glossary', 'translate', 'summarize']));
  });

  it('skim summarizes without translating', async () => {
    const t = setup();
    await runSubmission(t.env, sub({ skim: true }), t.ctx);
    expect(t.pool.used).toEqual(['general', 'general']);
    expect(t.stages.getStage(1, 'translate')).toBeUndefined();
    expect(t.stages.getStage(1, 'summarize')).toBe('done');
  });

  it('fails with TranscribeFailed when a chunk fails and skips the LLM stages', async () => {
    const t = setup({
      onTranscribe: () => {
        throw new Error('whisper crashed');
      },
    });
    await expect(runSubmission(t.env, sub({ translate: true }), t.ctx)).rejects.toMatchObject({ code: 'TranscribeFailed' });
    expect(t.pool.used).toEqual([]);
  });

  it('loads the glossary file before doing any work and rejects a bad one', async () => {
    const t = setup();
    const file = path.join(root, 'g.json');
    writeFileSync(file, '{oops');
    await expect(runSubmission(t.env, sub({ translate: true, glossaryPath: file }), t.ctx)).rejects.toMatchObject({
      code: 'InvalidInput',
    });
    expect(t.jobs).toEqual([]);
  });

  it('passes a user glossary into the translation prompt', async () => {
    const t = setup({ truth: [seg('ゆりまるです', 1000, 2000)] });
    const file = path.join(root, 'g.json');
    writeFileSync(file, '{"ゆりまる":"Yurimaru"}');
    await runSubmission(t.env, sub({ translate: true, glossaryPath: file }), t.ctx);
    expect(t.translate.calls[0][0].content).toContain('ゆりまる translates to Yurimaru');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/app/run-submission.test.ts`
Expected: FAIL, cannot resolve `run-submission`.

- [ ] **Step 3: Implement**

`src/app/main/run-submission.ts`:
```ts
import type { Repo } from '../../core/db/repo';
import type { StageRepo } from '../../core/db/stage-repo';
import type { Submission } from '../../core/db/submission-repo';
import { BgtError } from '../../core/errors';
import { loadGlossaryFile } from '../../core/llm/glossary-file';
import { runJob, type PipelineDeps } from '../../core/pipeline/run';
import { runLlmStages, type ModelPool } from '../../core/pipeline/stages';
import type { RunContext } from './queue';

export interface RunSubmissionEnv {
  repo: Repo;
  stages: StageRepo;
  /** Builds pipeline dependencies for the submission's model (shares the app's database). */
  makeDeps(sub: Submission): PipelineDeps;
  workRoot: string;
  outDir: string;
  pool: ModelPool;
  log(message: string): void;
}

export async function runSubmission(env: RunSubmissionEnv, sub: Submission, ctx: RunContext): Promise<void> {
  const { options } = sub;
  // A bad glossary file should fail now, not after the transcription.
  const userGlossary = options.glossaryPath ? loadGlossaryFile(options.glossaryPath) : {};

  const deps: PipelineDeps = { ...env.makeDeps(sub), log: env.log, progress: ctx.progress };
  const result = await runJob(deps, {
    source: sub.source,
    startMs: sub.startMs,
    endMs: sub.endMs,
    maxMinutes: options.maxMinutes,
    model: options.model,
    language: 'ja',
    workRoot: env.workRoot,
    outDir: env.outDir,
    keepWork: false,
    signal: ctx.signal,
    onJob: (job) => ctx.onJob(job.id),
  });
  if (result.status !== 'done') {
    throw new BgtError(
      'TranscribeFailed',
      `${result.failedChunks.length} chunk(s) could not be transcribed. Resume the job to retry them.`,
    );
  }

  if (!options.translate && !options.summarize && !options.skim) return;
  const job = env.repo.getJob(result.jobId);
  if (!job) throw new BgtError('InvalidInput', `Job ${result.jobId} disappeared.`);
  await runLlmStages(
    {
      repo: env.repo,
      stages: env.stages,
      job,
      outDir: env.outDir,
      pool: env.pool,
      log: env.log,
      signal: ctx.signal,
      progress: ctx.progress,
    },
    { translate: options.translate, summarize: options.summarize, skim: options.skim, userGlossary },
  );
}
```
(`runLlmStages` already calls `pool.stopAll()` in its own `finally`.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(app): run a queued submission through the core pipeline and LLM stages

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Handlers, media protocol, preload, lifecycle

**Files:**
- Create: `src/app/main/handlers.ts`, `src/app/main/media.ts`, `src/app/main/ipc.ts`
- Modify: `src/app/main/index.ts`, `src/app/preload/index.ts`, `scripts/smoke-app.mjs`
- Test: `tests/app/handlers.test.ts`, `tests/app/media.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 7 and 8; `CHANNELS`, `BgtApi`; `createRealDeps`, `createRealModelPool`, `createPerfStore`, `estimateSeconds`, `openDb`, `dataDir`/`resourcesDir`.
- Produces:
  - `interface HandlerDeps { repo: Repo; stages: StageRepo; queue: JobQueue; probe(source: string): Promise<ProbeResult>; speedFactor(): number | null; pickFile(kind: 'media' | 'glossary'): Promise<string | null>; openFolder(dir: string): Promise<void>; outDir: string }`
  - `createHandlers(d: HandlerDeps): { [K in keyof typeof CHANNELS handled by invoke]: (arg?: unknown) => Promise<Result<unknown>> }`, keyed by the `CHANNELS` values (`library:list`, `job:get`, `job:openOutputFolder`, `queue:list`, `queue:submit`, `queue:cancel`, `queue:resume`, `source:probe`, `source:estimate`, `dialog:pickMedia`, `dialog:pickGlossary`); every handler catches errors and returns `{ ok: false, error: { code, message } }` (a `BgtError` keeps its code, anything else is `Error`).
  - `resolveMediaPath(repo: Repo, jobId: unknown): string | null` (only the existing local-file source of an existing job; null otherwise).

- [ ] **Step 1: Write the failing tests**

`tests/app/media.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMediaUrl, resolveMediaPath } from '../../src/app/main/media';
import { memoryRepos } from '../helpers/fakes';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-media-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settings = { model: 'large-v3', language: 'ja', maxMinutes: 30 };

describe('resolveMediaPath', () => {
  it('returns the source of an existing local-file job', () => {
    const { repo } = memoryRepos();
    const file = path.join(dir, 'clip.wav');
    writeFileSync(file, 'x');
    const job = repo.createJob({ source: file, rangeStartMs: 0, rangeEndMs: 1, settings });
    expect(resolveMediaPath(repo, job.id)).toBe(file);
  });

  it('refuses unknown ids, URL sources, deleted files and non-numeric ids', () => {
    const { repo } = memoryRepos();
    const url = repo.createJob({ source: 'https://www.youtube.com/watch?v=7SHNxjFuw10', rangeStartMs: 0, rangeEndMs: 1, settings });
    const gone = repo.createJob({ source: path.join(dir, 'missing.wav'), rangeStartMs: 0, rangeEndMs: 1, settings });
    expect(resolveMediaPath(repo, 999)).toBeNull();
    expect(resolveMediaPath(repo, url.id)).toBeNull();
    expect(resolveMediaPath(repo, gone.id)).toBeNull();
    for (const bad of ['1', '../../etc/passwd', -1, 0, 1.5, null, undefined, NaN]) {
      expect(resolveMediaPath(repo, bad)).toBeNull();
    }
  });
});

describe('parseMediaUrl', () => {
  it('extracts the job id from bgt-media://job/<id> only', () => {
    expect(parseMediaUrl('bgt-media://job/12')).toBe(12);
    expect(parseMediaUrl('bgt-media://job/12?x=1')).toBe(12);
    for (const bad of ['bgt-media://other/12', 'bgt-media://job/abc', 'bgt-media://job/', 'bgt-media://job/1/2', 'https://job/1', 'nonsense']) {
      expect(parseMediaUrl(bad)).toBeNull();
    }
  });
});
```

`tests/app/handlers.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createHandlers } from '../../src/app/main/handlers';
import { JobQueue } from '../../src/app/main/queue';
import { SubmissionStore } from '../../src/core/db/submission-repo';
import { BgtError } from '../../src/core/errors';
import { Database } from '../../src/core/db/sqlite';
import { migrate } from '../../src/core/db/schema';
import { memoryRepos, seedJob } from '../helpers/fakes';

function setup(over: { speed?: number | null; probe?: () => Promise<{ title: string | null; durationMs: number }> } = {}) {
  const { repo, stages } = memoryRepos();
  const db = new Database(':memory:');
  migrate(db);
  const store = new SubmissionStore(db);
  const queue = new JobQueue({ store, run: async () => {}, emitChanged: () => {}, emitProgress: () => {} });
  const opened: string[] = [];
  const handlers = createHandlers({
    repo,
    stages,
    queue,
    probe: over.probe ?? (async () => ({ title: 'T', durationMs: 600_000 })),
    speedFactor: () => (over.speed === undefined ? 10 : over.speed),
    pickFile: async (kind) => (kind === 'media' ? 'C:/a.wav' : null),
    openFolder: async (dir) => {
      opened.push(dir);
    },
    outDir: 'C:/out',
  });
  return { handlers, repo, stages, queue, opened };
}

const options = { translate: false, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3' };

describe('handlers', () => {
  it('library:list and job:get wrap the library service', async () => {
    const t = setup();
    const job = seedJob(t.repo, ['あ']);
    const list = await t.handlers['library:list']();
    expect(list).toMatchObject({ ok: true, value: [{ jobId: job.id }] });
    const detail = await t.handlers['job:get'](job.id);
    expect(detail).toMatchObject({ ok: true, value: { item: { jobId: job.id } } });
    expect(await t.handlers['job:get'](999)).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['job:get']('x')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
  });

  it('queue:submit validates, queues and returns the submission', async () => {
    const t = setup();
    const ok = await t.handlers['queue:submit']({ source: 'C:/a.wav', startMs: 0, endMs: null, options });
    expect(ok).toMatchObject({ ok: true, value: { id: 1, source: 'C:/a.wav' } });
    const bad = await t.handlers['queue:submit']({ source: '', startMs: 0, endMs: null, options });
    expect(bad).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(t.queue.list()).toHaveLength(1);
  });

  it('queue:cancel and queue:resume validate ids', async () => {
    const t = setup();
    expect(await t.handlers['queue:cancel'](0)).toMatchObject({ ok: false });
    expect(await t.handlers['queue:resume'](1)).toEqual({ ok: true, value: null });
  });

  it('source:probe returns the probe result or a typed error', async () => {
    const good = setup();
    expect(await good.handlers['source:probe']('https://x')).toEqual({ ok: true, value: { title: 'T', durationMs: 600_000 } });
    const failing = setup({
      probe: async () => {
        throw new BgtError('DownloadFailed', 'blocked');
      },
    });
    expect(await failing.handlers['source:probe']('https://x')).toEqual({
      ok: false,
      error: { code: 'DownloadFailed', message: 'blocked' },
    });
    expect(await good.handlers['source:probe']('  ')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
  });

  it('source:estimate divides the range by the measured speed, or answers null', async () => {
    const t = setup({ speed: 10 });
    expect(await t.handlers['source:estimate']({ durationMs: 600_000, startMs: 0, endMs: null })).toEqual({ ok: true, value: 60 });
    expect(await t.handlers['source:estimate']({ durationMs: 600_000, startMs: 300_000, endMs: 600_000 })).toEqual({ ok: true, value: 30 });
    const unknown = setup({ speed: null });
    expect(await unknown.handlers['source:estimate']({ durationMs: 600_000, startMs: 0, endMs: null })).toEqual({ ok: true, value: null });
  });

  it('dialogs and open-folder delegate to the injected functions', async () => {
    const t = setup();
    expect(await t.handlers['dialog:pickMedia']()).toEqual({ ok: true, value: 'C:/a.wav' });
    expect(await t.handlers['dialog:pickGlossary']()).toEqual({ ok: true, value: null });
    seedJob(t.repo, ['あ']);
    expect(await t.handlers['job:openOutputFolder'](1)).toEqual({ ok: true, value: null });
    expect(t.opened).toEqual(['C:/out']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/app/handlers.test.ts tests/app/media.test.ts`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement the pure parts**

`src/app/main/media.ts`:
```ts
import { existsSync, statSync } from 'node:fs';
import type { Repo } from '../../core/db/repo';
import { isUrl } from '../../core/pipeline/real-deps';

/** `bgt-media://job/<id>` -> id, or null for anything else. */
export function parseMediaUrl(url: string): number | null {
  const m = /^bgt-media:\/\/job\/(\d+)\/?(?:[?#].*)?$/.exec(url);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Only the local-file source of an existing job may be served; never an arbitrary path. */
export function resolveMediaPath(repo: Repo, jobId: unknown): string | null {
  if (typeof jobId !== 'number' || !Number.isInteger(jobId) || jobId < 1) return null;
  const job = repo.getJob(jobId);
  if (!job || isUrl(job.source)) return null;
  try {
    return existsSync(job.source) && statSync(job.source).isFile() ? job.source : null;
  } catch {
    return null;
  }
}
```

`src/app/main/handlers.ts`:
```ts
import type { Repo } from '../../core/db/repo';
import type { StageRepo } from '../../core/db/stage-repo';
import { BgtError } from '../../core/errors';
import { estimateSeconds } from '../../core/pipeline/estimate';
import { CHANNELS, type ProbeResult, type Result } from '../shared/ipc';
import { getJobDetail, listLibrary } from './library-service';
import type { JobQueue } from './queue';
import { parseEstimateArgs, parseId, parseSource, parseSubmitRequest } from './validate';

export interface HandlerDeps {
  repo: Repo;
  stages: StageRepo;
  queue: JobQueue;
  probe(source: string): Promise<ProbeResult>;
  speedFactor(): number | null;
  pickFile(kind: 'media' | 'glossary'): Promise<string | null>;
  openFolder(dir: string): Promise<void>;
  outDir: string;
}

type Handler = (arg?: unknown) => Promise<Result<unknown>>;

async function wrap<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof BgtError) return { ok: false, error: { code: err.code, message: err.message } };
    return { ok: false, error: { code: 'Error', message: err instanceof Error ? err.message : String(err) } };
  }
}

export function createHandlers(d: HandlerDeps) {
  const handlers = {
    [CHANNELS.libraryList]: () => wrap(() => listLibrary(d.repo, d.stages)),
    [CHANNELS.jobGet]: (arg?: unknown) =>
      wrap(() => {
        const id = parseId(arg, 'job id');
        const detail = getJobDetail(d.repo, d.stages, id);
        if (!detail) throw new BgtError('InvalidInput', `There is no job ${id}.`);
        return detail;
      }),
    [CHANNELS.jobOpenOutputFolder]: (arg?: unknown) =>
      wrap(async () => {
        const id = parseId(arg, 'job id');
        if (!d.repo.getJob(id)) throw new BgtError('InvalidInput', `There is no job ${id}.`);
        await d.openFolder(d.outDir);
        return null;
      }),
    [CHANNELS.queueList]: () => wrap(() => d.queue.list()),
    [CHANNELS.queueSubmit]: (arg?: unknown) => wrap(() => d.queue.submit(parseSubmitRequest(arg))),
    [CHANNELS.queueCancel]: (arg?: unknown) =>
      wrap(() => {
        d.queue.cancel(parseId(arg, 'submission id'));
        return null;
      }),
    [CHANNELS.queueResume]: (arg?: unknown) =>
      wrap(() => {
        d.queue.resume(parseId(arg, 'submission id'));
        return null;
      }),
    [CHANNELS.sourceProbe]: (arg?: unknown) => wrap(() => d.probe(parseSource(arg))),
    [CHANNELS.sourceEstimate]: (arg?: unknown) =>
      wrap(() => {
        const { durationMs, startMs, endMs } = parseEstimateArgs(arg);
        const rangeMs = Math.max(0, Math.min(endMs ?? durationMs, durationMs) - startMs);
        return estimateSeconds(rangeMs, d.speedFactor());
      }),
    [CHANNELS.dialogPickMedia]: () => wrap(() => d.pickFile('media')),
    [CHANNELS.dialogPickGlossary]: () => wrap(() => d.pickFile('glossary')),
  } satisfies Record<string, Handler>;
  return handlers;
}

export type Handlers = ReturnType<typeof createHandlers>;
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Wire Electron (not unit tested; verified by smoke and Task 15)**

`src/app/main/ipc.ts`:
```ts
import { BrowserWindow, ipcMain } from 'electron';
import { CHANNELS } from '../shared/ipc';
import type { Handlers } from './handlers';

export function registerIpc(handlers: Handlers): void {
  ipcMain.handle(CHANNELS.ping, () => 'pong');
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, arg) => (handler as (a?: unknown) => Promise<unknown>)(arg));
  }
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
```

`src/app/preload/index.ts` (replace):
```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CHANNELS, type BgtApi, type QueueProgressEvent, type Submission } from '../shared/ipc';

const invoke = <T>(channel: string, arg?: unknown) => ipcRenderer.invoke(channel, arg) as Promise<T>;

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: BgtApi = {
  ping: () => invoke(CHANNELS.ping),
  library: { list: () => invoke(CHANNELS.libraryList) },
  job: {
    get: (jobId) => invoke(CHANNELS.jobGet, jobId),
    openOutputFolder: (jobId) => invoke(CHANNELS.jobOpenOutputFolder, jobId),
  },
  queue: {
    list: () => invoke(CHANNELS.queueList),
    submit: (request) => invoke(CHANNELS.queueSubmit, request),
    cancel: (id) => invoke(CHANNELS.queueCancel, id),
    resume: (id) => invoke(CHANNELS.queueResume, id),
    onChanged: (cb) => subscribe<Submission[]>(CHANNELS.queueChanged, cb),
    onProgress: (cb) => subscribe<QueueProgressEvent>(CHANNELS.queueProgress, cb),
  },
  source: {
    probe: (source) => invoke(CHANNELS.sourceProbe, source),
    estimate: (a) => invoke(CHANNELS.sourceEstimate, a),
  },
  dialog: {
    pickMedia: () => invoke(CHANNELS.dialogPickMedia),
    pickGlossary: () => invoke(CHANNELS.dialogPickGlossary),
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
};

contextBridge.exposeInMainWorld('bgt', api);
```

`src/app/main/index.ts` (replace with the full app main):
```ts
import path from 'node:path';
import { app, BrowserWindow, dialog, net, protocol, session, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import { openDb } from '../../core/db';
import { Repo } from '../../core/db/repo';
import { StageRepo } from '../../core/db/stage-repo';
import { SubmissionStore } from '../../core/db/submission-repo';
import { createPerfStore } from '../../core/pipeline/estimate';
import { createRealDeps } from '../../core/pipeline/real-deps';
import { createRealModelPool } from '../../core/pipeline/real-llm';
import { dataDir } from '../../core/tools/paths';
import { CHANNELS } from '../shared/ipc';
import { createHandlers } from './handlers';
import { broadcast, registerIpc } from './ipc';
import { parseMediaUrl, resolveMediaPath } from './media';
import { JobQueue } from './queue';
import { runSubmission } from './run-submission';

const smoke = process.argv.includes('--smoke');
// `import.meta.url`-based root discovery in src/core does not work from a bundle.
process.env.BGT_PROJECT_ROOT ??= app.getAppPath();

const REFERER = 'https://bgt.local/';
protocol.registerSchemesAsPrivileged([
  { scheme: 'bgt-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let queue: JobQueue | null = null;
let quitting = false;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    show: !smoke,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Anything that is not our own page opens in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault();
  });
  win.on('close', (e) => {
    if (quitting || !queue) return;
    const running = queue.list().some((s) => s.state === 'running');
    if (!running) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Keep running', 'Quit and resume later'],
      defaultId: 0,
      cancelId: 0,
      message: 'A job is still running.',
      detail: 'If you quit now it is paused and can be resumed the next time you open the app.',
    });
    if (choice === 0) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

function configureSession(): void {
  const ses = session.defaultSession;
  // The YouTube embed refuses requests without a plausible referrer (player error 153).
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.youtube.com/*', 'https://*.youtube-nocookie.com/*'] }, (details, cb) => {
    details.requestHeaders.Referer = REFERER;
    cb({ requestHeaders: details.requestHeaders });
  });
  if (!process.env.ELECTRON_RENDERER_URL) {
    const csp = [
      "default-src 'self'",
      "script-src 'self' https://www.youtube.com https://s.ytimg.com",
      "style-src 'self' 'unsafe-inline'",
      'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
      "img-src 'self' data: https://i.ytimg.com",
      "media-src 'self' bgt-media:",
      "connect-src 'self'",
    ].join('; ');
    ses.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }
}

void app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  configureSession();

  const dir = dataDir();
  const outDir = path.resolve(process.env.BGT_OUTPUT_DIR ?? path.join(app.getAppPath(), 'output'));
  const db = openDb(path.join(dir, 'bgt.sqlite'));
  const repo = new Repo(db);
  const stages = new StageRepo(db);
  const store = new SubmissionStore(db);
  const pool = createRealModelPool({ log: (m) => console.log(m) });
  const probeDeps = () => createRealDeps({ dataDir: dir, model: 'large-v3', db, log: () => {} }).deps;

  queue = new JobQueue({
    store,
    run: (sub, ctx) =>
      runSubmission(
        {
          repo,
          stages,
          makeDeps: (s) => createRealDeps({ dataDir: dir, model: s.options.model, db, log: (m) => console.log(m) }).deps,
          workRoot: path.join(dir, 'work'),
          outDir,
          pool,
          log: (m) => console.log(m),
        },
        sub,
        ctx,
      ),
    emitChanged: (subs) => broadcast(CHANNELS.queueChanged, subs),
    emitProgress: (p) => broadcast(CHANNELS.queueProgress, p),
  });

  registerIpc(
    createHandlers({
      repo,
      stages,
      queue,
      probe: (source) => probeDeps().probe(source),
      speedFactor: () => createPerfStore(path.join(dir, 'perf.json')).read(),
      pickFile: async (kind) => {
        const filters =
          kind === 'media'
            ? [{ name: 'Audio and video', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'] }]
            : [{ name: 'Glossary JSON', extensions: ['json'] }];
        const r = await dialog.showOpenDialog({ properties: ['openFile'], filters });
        return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
      },
      openFolder: async (folder) => {
        await shell.openPath(folder);
      },
      outDir,
    }),
  );

  protocol.handle('bgt-media', (request) => {
    const file = resolveMediaPath(repo, parseMediaUrl(request.url));
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
  });

  const win = createWindow();
  if (smoke) {
    const timer = setTimeout(() => {
      console.error('SMOKE TIMEOUT');
      app.exit(1);
    }, 30_000);
    win.webContents.once('did-finish-load', async () => {
      try {
        const reply = await win.webContents.executeJavaScript(
          'window.bgt ? Promise.all([window.bgt.ping(), window.bgt.library.list()]) : Promise.resolve(["no-bridge"])',
        );
        clearTimeout(timer);
        if (reply[0] === 'pong' && reply[1]?.ok === true) {
          console.log('SMOKE OK');
          app.exit(0);
        } else {
          console.error(`SMOKE FAIL: ${JSON.stringify(reply)}`);
          app.exit(1);
        }
      } catch (err) {
        console.error('SMOKE ERROR', err);
        app.exit(1);
      }
    });
  } else {
    queue.start();
  }

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      try {
        await queue?.shutdown();
        await pool.stopAll();
      } finally {
        db.close();
        app.exit(0);
      }
    })();
  });
});

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 6: Build and smoke**

Run: `pnpm build:app && pnpm smoke:app`
Expected: `SMOKE OK` (the preload now exposes the full API and `library.list()` returns `ok: true` against the real `data/bgt.sqlite`). If it fails, read the printed error; the usual causes are a preload path/name mismatch or a bundling error for a core module (check `pnpm build:app` output for unresolved imports).

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add -A
git commit -m "feat(app): IPC handlers, media protocol, preload API and app lifecycle

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Renderer foundation (API access, formatting, subtitle logic)

**Files:**
- Create: `src/app/renderer/lib/api.tsx`, `src/app/renderer/lib/format.ts`, `src/app/renderer/lib/subtitles.ts`
- Test: `tests/renderer/subtitles.test.ts`, `tests/renderer/format.test.ts`, `tests/renderer/api.test.tsx`

**Interfaces:**
- Consumes: `BgtApi`, `Result`, `LibraryItem`, `Submission`, `ProgressEvent`, `TranscriptLine` (type-only from shared).
- Produces:
  - `ApiContext`, `ApiProvider`, `useApi(): BgtApi`, `unwrap<T>(r: Result<T>): T` (throws `Error` with the message), `useQueue(): Submission[]`, `useProgress(): Map<number, ProgressEvent>`, `useLibrary(submissions: Submission[]): LibraryItem[]`.
  - `formatClock(ms)` (`h:mm:ss`), `formatEta(seconds | null)` ("about 2 min" / "unknown until a first run"), `stageLabel(stage)`, `stateLabel(state)`, `progressPercent(e)`.
  - `findActiveIndex(lines: { startMs: number; endMs: number }[], timeMs: number): number` (-1 if none), `type SubtitleMode = 'en' | 'ja' | 'both'`, `subtitleText(line: { ja: string; en: string | null }, mode): string[]`.

- [ ] **Step 1: Write the failing tests**

`tests/renderer/subtitles.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { findActiveIndex, subtitleText } from '../../src/app/renderer/lib/subtitles';

const L = (startMs: number, endMs: number) => ({ startMs, endMs });

describe('findActiveIndex', () => {
  const lines = [L(1000, 2000), L(2500, 4000), L(4000, 5000), L(9000, 9500)];

  it('returns -1 for an empty list', () => {
    expect(findActiveIndex([], 1500)).toBe(-1);
  });

  it('returns -1 before the first line and after the last one has ended', () => {
    expect(findActiveIndex(lines, 0)).toBe(-1);
    expect(findActiveIndex(lines, 999)).toBe(-1);
    expect(findActiveIndex(lines, 9500)).toBe(-1);
    expect(findActiveIndex(lines, 60_000)).toBe(-1);
  });

  it('finds the line containing the time (start inclusive, end exclusive)', () => {
    expect(findActiveIndex(lines, 1000)).toBe(0);
    expect(findActiveIndex(lines, 1999)).toBe(0);
    expect(findActiveIndex(lines, 2500)).toBe(1);
    expect(findActiveIndex(lines, 4000)).toBe(2);
    expect(findActiveIndex(lines, 9499)).toBe(3);
  });

  it('returns -1 in a gap between lines', () => {
    expect(findActiveIndex(lines, 2000)).toBe(-1);
    expect(findActiveIndex(lines, 2499)).toBe(-1);
    expect(findActiveIndex(lines, 6000)).toBe(-1);
  });

  it('prefers the later line when two start at the same time', () => {
    expect(findActiveIndex([L(1000, 3000), L(1000, 3000)], 1500)).toBe(1);
  });

  it('keeps the earlier line active while a later overlapping one has not started', () => {
    expect(findActiveIndex([L(1000, 5000), L(3000, 4000)], 2000)).toBe(0);
    expect(findActiveIndex([L(1000, 5000), L(3000, 4000)], 3500)).toBe(1);
  });
});

describe('subtitleText', () => {
  it('returns English, Japanese or both, falling back to Japanese when English is missing', () => {
    expect(subtitleText({ ja: 'こんにちは', en: 'Hello' }, 'en')).toEqual(['Hello']);
    expect(subtitleText({ ja: 'こんにちは', en: 'Hello' }, 'ja')).toEqual(['こんにちは']);
    expect(subtitleText({ ja: 'こんにちは', en: 'Hello' }, 'both')).toEqual(['Hello', 'こんにちは']);
    expect(subtitleText({ ja: 'えっと', en: null }, 'en')).toEqual(['えっと']);
    expect(subtitleText({ ja: 'えっと', en: null }, 'both')).toEqual(['えっと']);
  });
});
```

`tests/renderer/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatClock, formatEta, progressPercent, stageLabel, stateLabel } from '../../src/app/renderer/lib/format';

describe('format helpers', () => {
  it('formats clock times', () => {
    expect(formatClock(0)).toBe('0:00:00');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });

  it('describes an estimate', () => {
    expect(formatEta(null)).toBe('unknown until a first run');
    expect(formatEta(45)).toBe('under a minute');
    expect(formatEta(300)).toBe('about 5 min');
    expect(formatEta(5400)).toBe('about 1 h 30 min');
  });

  it('labels stages and states', () => {
    expect(stageLabel('translate')).toBe('Translating');
    expect(stateLabel('interrupted')).toBe('Interrupted');
  });

  it('computes a bounded percentage', () => {
    expect(progressPercent({ stage: 'transcribe', done: 1, total: 4, message: '' })).toBe(25);
    expect(progressPercent({ stage: 'transcribe', done: 0, total: 0, message: '' })).toBe(0);
    expect(progressPercent({ stage: 'transcribe', done: 9, total: 4, message: '' })).toBe(100);
  });
});
```

`tests/renderer/api.test.tsx`:
```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiProvider, unwrap, useLibrary, useProgress, useQueue } from '../../src/app/renderer/lib/api';
import type { BgtApi, Submission } from '../../src/app/shared/ipc';

afterEach(cleanup);

describe('unwrap', () => {
  it('returns the value or throws the error message', () => {
    expect(unwrap({ ok: true, value: 3 })).toBe(3);
    expect(() => unwrap({ ok: false, error: { code: 'X', message: 'broken' } })).toThrow('broken');
  });
});

function fakeApi() {
  const changed = new Set<(s: Submission[]) => void>();
  const progress = new Set<(p: { submissionId: number; event: { stage: 'translate'; done: number; total: number; message: string } }) => void>();
  const sub = { id: 1, state: 'running' } as Submission;
  const api = {
    queue: {
      list: async () => ({ ok: true as const, value: [sub] }),
      onChanged: (cb: (s: Submission[]) => void) => {
        changed.add(cb);
        return () => changed.delete(cb);
      },
      onProgress: (cb: never) => {
        progress.add(cb);
        return () => progress.delete(cb);
      },
    },
    library: { list: async () => ({ ok: true as const, value: [{ jobId: 5, title: 'T' }] }) },
  } as unknown as BgtApi;
  return { api, changed, progress };
}

function Probe() {
  const subs = useQueue();
  const progress = useProgress();
  const items = useLibrary(subs);
  return (
    <div>
      <span data-testid="subs">{subs.length}</span>
      <span data-testid="items">{items.length}</span>
      <span data-testid="progress">{progress.get(1)?.done ?? 'none'}</span>
    </div>
  );
}

describe('hooks', () => {
  it('load the queue and library and follow pushed updates', async () => {
    const { api, changed, progress } = fakeApi();
    render(
      <ApiProvider api={api}>
        <Probe />
      </ApiProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId('subs').textContent).toBe('1');
    expect(screen.getByTestId('items').textContent).toBe('1');
    expect(screen.getByTestId('progress').textContent).toBe('none');

    act(() => {
      for (const cb of progress) cb({ submissionId: 1, event: { stage: 'translate', done: 2, total: 3, message: '' } });
    });
    expect(screen.getByTestId('progress').textContent).toBe('2');

    act(() => {
      for (const cb of changed) cb([]);
    });
    expect(screen.getByTestId('subs').textContent).toBe('0');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/renderer`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

`src/app/renderer/lib/subtitles.ts`:
```ts
export type SubtitleMode = 'en' | 'ja' | 'both';

/**
 * Index of the line active at `timeMs` (start inclusive, end exclusive), or -1.
 * `lines` must be sorted by start time. With equal starts the later line wins.
 */
export function findActiveIndex(lines: { startMs: number; endMs: number }[], timeMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= timeMs) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Walk back over overlapping lines that started earlier but are still on screen.
  for (let i = candidate; i >= 0; i--) {
    if (timeMs < lines[i].endMs) return i;
    if (candidate - i > 8) break;
  }
  return -1;
}

export function subtitleText(line: { ja: string; en: string | null }, mode: SubtitleMode): string[] {
  if (mode === 'ja') return [line.ja];
  if (mode === 'en') return [line.en ?? line.ja];
  return line.en ? [line.en, line.ja] : [line.ja];
}
```

`src/app/renderer/lib/format.ts`:
```ts
import type { ProgressEvent, SubmissionState } from '../../shared/ipc';

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return 'unknown until a first run';
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

const STAGES: Record<ProgressEvent['stage'], string> = {
  fetch: 'Downloading audio',
  transcribe: 'Transcribing',
  glossary: 'Finding names',
  translate: 'Translating',
  summarize: 'Summarizing',
};
export const stageLabel = (stage: ProgressEvent['stage']): string => STAGES[stage];

const STATES: Record<SubmissionState, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};
export const stateLabel = (state: SubmissionState): string => STATES[state];

export function progressPercent(e: ProgressEvent): number {
  if (e.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((e.done / e.total) * 100)));
}
```

`src/app/renderer/lib/api.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BgtApi, LibraryItem, ProgressEvent, Result, Submission } from '../../shared/ipc';

const ApiContext = createContext<BgtApi | null>(null);

export function ApiProvider({ api, children }: { api: BgtApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): BgtApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('ApiProvider is missing');
  return api;
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export function useQueue(): Submission[] {
  const api = useApi();
  const [subs, setSubs] = useState<Submission[]>([]);
  useEffect(() => {
    let alive = true;
    void api.queue.list().then((r) => {
      if (alive && r.ok) setSubs(r.value);
    });
    const off = api.queue.onChanged((next) => {
      if (alive) setSubs(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  return subs;
}

export function useProgress(): Map<number, ProgressEvent> {
  const api = useApi();
  const [map, setMap] = useState<Map<number, ProgressEvent>>(new Map());
  useEffect(() => {
    return api.queue.onProgress(({ submissionId, event }) => {
      setMap((prev) => new Map(prev).set(submissionId, event));
    });
  }, [api]);
  return map;
}

/** Reloads the library whenever the queue changes (a job appears, finishes or gets translated). */
export function useLibrary(submissions: Submission[]): LibraryItem[] {
  const api = useApi();
  const [items, setItems] = useState<LibraryItem[]>([]);
  useEffect(() => {
    let alive = true;
    void api.library.list().then((r) => {
      if (alive && r.ok) setItems(r.value);
    });
    return () => {
      alive = false;
    };
  }, [api, submissions]);
  return items;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. (`api.test.tsx` imports `.tsx`; `tsconfig.web.json` covers `tests/renderer`.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(renderer): API access hooks, formatting and subtitle lookup

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: App shell, Library screen and Queue strip

**Files:**
- Create: `src/app/renderer/components/LibraryScreen.tsx`, `src/app/renderer/components/QueueStrip.tsx`, `src/app/renderer/styles.css`
- Modify: `src/app/renderer/App.tsx`, `src/app/renderer/main.tsx`
- Test: `tests/renderer/library.test.tsx`, `tests/renderer/queue-strip.test.tsx`

**Interfaces:**
- Consumes: Task 10 hooks and format helpers; types from `shared/ipc`.
- Produces: `LibraryScreen({ items, submissions, onOpen, onNew })`, `QueueStrip({ submissions, progress, onCancel, onResume })`, and `App` wiring: routes `library | job`, top bar with "New job", queue strip at the bottom. `App` renders `JobScreen` and `NewJobDialog` from later tasks; until those exist it renders placeholders (replaced in Tasks 12 and 14).

- [ ] **Step 1: Write the failing tests**

`tests/renderer/library.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryScreen } from '../../src/app/renderer/components/LibraryScreen';
import type { LibraryItem, Submission } from '../../src/app/shared/ipc';

afterEach(cleanup);

const item = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  jobId: 1,
  title: 'GRWM',
  source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
  videoId: '7SHNxjFuw10',
  status: 'done',
  rangeStartMs: 0,
  rangeEndMs: 557_000,
  createdAt: '2026-10-14T12:00:00.000Z',
  hasTranslation: true,
  hasSummary: true,
  isLocalFile: false,
  ...over,
});

const sub = (over: Partial<Submission> = {}): Submission => ({
  id: 1,
  source: 'https://www.youtube.com/watch?v=QGWaK-UF5QU',
  startMs: 0,
  endMs: null,
  options: { translate: true, summarize: true, skim: false, maxMinutes: 30, model: 'large-v3' },
  state: 'queued',
  jobId: null,
  error: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('LibraryScreen', () => {
  it('shows an empty state with a New job button', () => {
    const onNew = vi.fn();
    render(<LibraryScreen items={[]} submissions={[]} onOpen={() => {}} onNew={onNew} />);
    fireEvent.click(screen.getByText('New job'));
    expect(onNew).toHaveBeenCalled();
  });

  it('lists jobs with title, range, and badges, and opens one on click', () => {
    const onOpen = vi.fn();
    render(<LibraryScreen items={[item(), item({ jobId: 2, title: null, source: 'C:/clips/a.wav', isLocalFile: true, hasTranslation: false, hasSummary: false })]} submissions={[]} onOpen={onOpen} onNew={() => {}} />);
    expect(screen.getByText('GRWM')).toBeTruthy();
    expect(screen.getByText('0:00:00 to 0:09:17')).toBeTruthy();
    expect(screen.getAllByText('EN')).toHaveLength(1);
    expect(screen.getAllByText('Summary')).toHaveLength(1);
    expect(screen.getByText('C:/clips/a.wav')).toBeTruthy(); // falls back to the source when there is no title
    fireEvent.click(screen.getByText('GRWM'));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('shows queued and running submissions that have no job yet', () => {
    render(
      <LibraryScreen
        items={[]}
        submissions={[sub(), sub({ id: 2, state: 'running' }), sub({ id: 3, state: 'done', jobId: 9 })]}
        onOpen={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getAllByText('https://www.youtube.com/watch?v=QGWaK-UF5QU')).toHaveLength(2);
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
  });
});
```

`tests/renderer/queue-strip.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueStrip } from '../../src/app/renderer/components/QueueStrip';
import type { ProgressEvent, Submission } from '../../src/app/shared/ipc';

afterEach(cleanup);

const sub = (over: Partial<Submission>): Submission => ({
  id: 1,
  source: 'https://www.youtube.com/watch?v=QGWaK-UF5QU',
  startMs: 0,
  endMs: null,
  options: { translate: true, summarize: true, skim: false, maxMinutes: 30, model: 'large-v3' },
  state: 'queued',
  jobId: null,
  error: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('QueueStrip', () => {
  it('renders nothing when there is nothing to show', () => {
    const { container } = render(<QueueStrip submissions={[]} progress={new Map()} onCancel={() => {}} onResume={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('shows the running submission with its stage and percentage, and cancels it', () => {
    const onCancel = vi.fn();
    const progress = new Map<number, ProgressEvent>([[1, { stage: 'translate', done: 1, total: 4, message: '' }]]);
    render(<QueueStrip submissions={[sub({ state: 'running' }), sub({ id: 2 }), sub({ id: 3 })]} progress={progress} onCancel={onCancel} onResume={() => {}} />);
    expect(screen.getByText('Translating')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('2 waiting')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledWith(1);
  });

  it('offers Resume for failed, interrupted and cancelled submissions and shows the error', () => {
    const onResume = vi.fn();
    render(
      <QueueStrip
        submissions={[sub({ id: 4, state: 'failed', error: 'DownloadFailed: nope' }), sub({ id: 5, state: 'interrupted' })]}
        progress={new Map()}
        onCancel={() => {}}
        onResume={onResume}
      />,
    );
    expect(screen.getByText('DownloadFailed: nope')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Resume')[0]);
    expect(onResume).toHaveBeenCalled();
    expect(screen.getAllByText('Resume')).toHaveLength(2);
  });

  it('does not show finished submissions', () => {
    const { container } = render(<QueueStrip submissions={[sub({ state: 'done' })]} progress={new Map()} onCancel={() => {}} onResume={() => {}} />);
    expect(container.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/renderer/library.test.tsx tests/renderer/queue-strip.test.tsx`
Expected: FAIL, cannot resolve components.

- [ ] **Step 3: Implement**

`src/app/renderer/components/LibraryScreen.tsx`:
```tsx
import type { LibraryItem, Submission } from '../../shared/ipc';
import { formatClock, stateLabel } from '../lib/format';

interface Props {
  items: LibraryItem[];
  submissions: Submission[];
  onOpen(jobId: number): void;
  onNew(): void;
}

export function LibraryScreen({ items, submissions, onOpen, onNew }: Props) {
  const pending = submissions.filter((s) => s.jobId === null && (s.state === 'queued' || s.state === 'running'));
  if (items.length === 0 && pending.length === 0) {
    return (
      <div className="empty">
        <h2>No jobs yet</h2>
        <p>Paste a YouTube link or choose a recording to get English subtitles and a summary.</p>
        <button className="primary" onClick={onNew}>
          New job
        </button>
      </div>
    );
  }
  return (
    <ul className="library">
      {pending.map((s) => (
        <li key={`s${s.id}`} className="row pending">
          <div className="title">{s.source}</div>
          <div className="meta">
            <span className={`badge state-${s.state}`}>{stateLabel(s.state)}</span>
          </div>
        </li>
      ))}
      {items.map((item) => (
        <li key={item.jobId}>
          <button className="row" onClick={() => onOpen(item.jobId)}>
            <span className="title">{item.title ?? item.source}</span>
            <span className="meta">
              <span>{`${formatClock(item.rangeStartMs)} to ${formatClock(item.rangeEndMs)}`}</span>
              <span>{new Date(item.createdAt).toLocaleDateString()}</span>
              {item.status !== 'done' && <span className={`badge state-${item.status}`}>{item.status}</span>}
              {item.hasTranslation && <span className="badge">EN</span>}
              {item.hasSummary && <span className="badge">Summary</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

`src/app/renderer/components/QueueStrip.tsx`:
```tsx
import type { ProgressEvent, Submission } from '../../shared/ipc';
import { progressPercent, stageLabel, stateLabel } from '../lib/format';

interface Props {
  submissions: Submission[];
  progress: Map<number, ProgressEvent>;
  onCancel(id: number): void;
  onResume(id: number): void;
}

const RESUMABLE = new Set(['failed', 'interrupted', 'cancelled']);

export function QueueStrip({ submissions, progress, onCancel, onResume }: Props) {
  const running = submissions.find((s) => s.state === 'running');
  const waiting = submissions.filter((s) => s.state === 'queued').length;
  const stopped = submissions.filter((s) => RESUMABLE.has(s.state)).slice(-3);
  if (!running && waiting === 0 && stopped.length === 0) return null;

  const event = running ? progress.get(running.id) : undefined;
  return (
    <footer className="queue">
      {running && (
        <div className="queue-running">
          <span className="queue-source">{running.source}</span>
          <span className="queue-stage">{event ? stageLabel(event.stage) : 'Starting'}</span>
          <progress max={100} value={event ? progressPercent(event) : undefined} />
          {event && <span className="queue-percent">{`${progressPercent(event)}%`}</span>}
          <button onClick={() => onCancel(running.id)}>Cancel</button>
        </div>
      )}
      {waiting > 0 && <div className="queue-waiting">{`${waiting} waiting`}</div>}
      {stopped.map((s) => (
        <div key={s.id} className="queue-stopped">
          <span className="queue-source">{s.source}</span>
          <span className={`badge state-${s.state}`}>{stateLabel(s.state)}</span>
          {s.error && <span className="queue-error">{s.error}</span>}
          <button onClick={() => onResume(s.id)}>Resume</button>
        </div>
      ))}
    </footer>
  );
}
```

`src/app/renderer/App.tsx`:
```tsx
import { useState } from 'react';
import { LibraryScreen } from './components/LibraryScreen';
import { QueueStrip } from './components/QueueStrip';
import { useApi, useLibrary, useProgress, useQueue } from './lib/api';

type Route = { name: 'library' } | { name: 'job'; jobId: number };

export function App() {
  const api = useApi();
  const submissions = useQueue();
  const progress = useProgress();
  const items = useLibrary(submissions);
  const [route, setRoute] = useState<Route>({ name: 'library' });
  const [newJobOpen, setNewJobOpen] = useState(false);

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setRoute({ name: 'library' })}>
          BG Auto Translator
        </button>
        <button className="primary" onClick={() => setNewJobOpen(true)}>
          New job
        </button>
      </header>
      <main className="content">
        {route.name === 'library' ? (
          <LibraryScreen items={items} submissions={submissions} onOpen={(jobId) => setRoute({ name: 'job', jobId })} onNew={() => setNewJobOpen(true)} />
        ) : (
          <div>{`Job ${route.jobId}`}</div>
        )}
      </main>
      <QueueStrip
        submissions={submissions}
        progress={progress}
        onCancel={(id) => void api.queue.cancel(id)}
        onResume={(id) => void api.queue.resume(id)}
      />
      {newJobOpen && <div>New job dialog placeholder</div>}
    </div>
  );
}
```

`src/app/renderer/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ApiProvider } from './lib/api';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ApiProvider api={window.bgt}>
      <App />
    </ApiProvider>
  </StrictMode>,
);
```

`src/app/renderer/styles.css`:
```css
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #1b1f27;
  --muted: #667085;
  --line: #e2e5ea;
  --accent: #2f6fed;
  --accent-text: #ffffff;
  --bad: #c0392b;
  --ok: #1f8a4c;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --panel: #1c1f26;
    --text: #e8eaed;
    --muted: #98a2b3;
    --line: #2b303a;
    --accent: #5b8cff;
    --accent-text: #0b1020;
    --bad: #ff7a6b;
    --ok: #5fd38d;
  }
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, 'Segoe UI', 'Yu Gothic UI', sans-serif; }
button { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
input[type='text'], select { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
.app { display: grid; grid-template-rows: auto 1fr auto; height: 100%; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
.brand { border: none; background: none; font-weight: 600; font-size: 15px; padding: 0; }
.content { overflow: auto; padding: 16px; }
.empty { max-width: 460px; margin: 80px auto; text-align: center; color: var(--muted); }
.library { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; max-width: 900px; margin-inline: auto; }
.row { width: 100%; display: grid; gap: 4px; text-align: left; padding: 12px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.row.pending { opacity: 0.8; }
.row .title { font-weight: 600; overflow-wrap: anywhere; }
.row .meta { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: 12px; align-items: center; }
.badge { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; font-size: 11px; }
.badge.state-failed, .badge.state-interrupted, .badge.state-cancelled { color: var(--bad); border-color: var(--bad); }
.badge.state-running, .badge.state-queued { color: var(--accent); border-color: var(--accent); }
.queue { border-top: 1px solid var(--line); background: var(--panel); padding: 8px 16px; display: grid; gap: 6px; }
.queue-running, .queue-stopped { display: flex; gap: 12px; align-items: center; }
.queue-source { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.queue-error { color: var(--bad); font-size: 12px; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue progress { width: 220px; }
.queue-waiting { color: var(--muted); font-size: 12px; }
.dialog-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); display: grid; place-items: center; z-index: 10; }
.dialog { width: min(560px, 92vw); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px; display: grid; gap: 12px; }
.dialog h2 { margin: 0; }
.dialog label { display: grid; gap: 4px; }
.dialog .inline { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.dialog .actions { display: flex; justify-content: flex-end; gap: 8px; }
.dialog .error { color: var(--bad); }
.dialog .hint { color: var(--muted); font-size: 12px; }
.dropzone { border: 1px dashed var(--line); border-radius: 8px; padding: 10px; text-align: center; color: var(--muted); }
.dropzone.over { border-color: var(--accent); color: var(--accent); }
.job { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); gap: 16px; height: 100%; min-height: 0; }
.job-left { display: grid; gap: 10px; align-content: start; min-width: 0; }
.job-right { display: grid; grid-template-rows: auto 1fr; min-height: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.player { position: relative; aspect-ratio: 16 / 9; background: #000; border-radius: 8px; overflow: hidden; }
.player:fullscreen { aspect-ratio: auto; border-radius: 0; }
.player iframe, .player video { width: 100%; height: 100%; border: 0; display: block; }
.overlay { position: absolute; left: 0; right: 0; bottom: 8%; text-align: center; padding: 0 6%; pointer-events: none; }
.overlay span { display: inline-block; background: rgb(0 0 0 / 0.72); color: #fff; padding: 2px 10px; border-radius: 4px; margin: 2px 0; font-size: var(--sub-size, 22px); line-height: 1.35; }
.notice { background: var(--panel); border: 1px solid var(--bad); border-radius: 8px; padding: 10px 12px; }
.tabs { display: flex; border-bottom: 1px solid var(--line); }
.tabs button { border: none; border-radius: 0; background: none; padding: 10px 14px; }
.tabs button[aria-selected='true'] { border-bottom: 2px solid var(--accent); font-weight: 600; }
.panel { overflow: auto; padding: 8px; min-height: 0; }
.line { display: grid; grid-template-columns: 64px 1fr; gap: 8px; width: 100%; text-align: left; border: none; border-radius: 6px; background: none; padding: 6px 8px; }
.line.active { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.line .time { color: var(--muted); font-variant-numeric: tabular-nums; }
.line .ja { color: var(--muted); font-size: 12px; }
.summary h3 { margin: 12px 0 4px; font-size: 13px; color: var(--muted); }
.summary p, .summary li { margin: 4px 0; }
.summary .ts { border: none; background: none; color: var(--accent); padding: 0; text-decoration: underline; }
```

- [ ] **Step 4: Run to verify they pass, then check the app builds**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build:app && pnpm smoke:app`
Expected: PASS and `SMOKE OK`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(renderer): app shell, library screen and queue strip

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: New job dialog

**Files:**
- Create: `src/app/renderer/lib/newjob.ts`, `src/app/renderer/components/NewJobDialog.tsx`
- Modify: `src/app/renderer/App.tsx`
- Test: `tests/renderer/newjob.test.ts`, `tests/renderer/new-job-dialog.test.tsx`

**Interfaces:**
- Consumes: `parseTimestamp`, `resolveRange` (`core/time`), `BgtApi`, `SubmitRequest`, `unwrap`, `formatEta`, `useApi`.
- Produces:
  - `interface NewJobForm { source: string; start: string; end: string; translate: boolean; summarize: boolean; skim: boolean; glossaryPath: string | null }`
  - `buildSubmitRequest(form: NewJobForm, durationMs: number | null): { ok: true; request: SubmitRequest } | { ok: false; error: string }` (messages match the CLI's for range errors).
  - `NewJobDialog({ onClose, onSubmitted })`: probes the source on blur / file choice / drop, shows title, duration and estimate, validates through `buildSubmitRequest`, submits via `api.queue.submit`, closes on success.

- [ ] **Step 1: Write the failing tests**

`tests/renderer/newjob.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildSubmitRequest, type NewJobForm } from '../../src/app/renderer/lib/newjob';

const form = (over: Partial<NewJobForm> = {}): NewJobForm => ({
  source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
  start: '',
  end: '',
  translate: true,
  summarize: true,
  skim: false,
  glossaryPath: null,
  ...over,
});

const fail = (r: ReturnType<typeof buildSubmitRequest>) => (r.ok ? '' : r.error);

describe('buildSubmitRequest', () => {
  it('builds a request with defaults for blank start and end', () => {
    expect(buildSubmitRequest(form(), 600_000)).toEqual({
      ok: true,
      request: {
        source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
        startMs: 0,
        endMs: null,
        options: { translate: true, summarize: true, skim: false, glossaryPath: undefined, maxMinutes: 30, model: 'large-v3' },
      },
    });
  });

  it('parses times in the CLI formats and passes the glossary path', () => {
    const r = buildSubmitRequest(form({ start: '1:20:00', end: '1:50:00', glossaryPath: 'C:/g.json' }), 7_200_000);
    expect(r).toMatchObject({ ok: true, request: { startMs: 4_800_000, endMs: 6_600_000, options: { glossaryPath: 'C:/g.json' } } });
  });

  it('rejects an empty source', () => {
    expect(fail(buildSubmitRequest(form({ source: '  ' }), null))).toMatch(/URL or choose a file/i);
  });

  it('rejects skim together with translate', () => {
    expect(fail(buildSubmitRequest(form({ skim: true, translate: true }), 600_000))).toMatch(/skim/i);
    expect(buildSubmitRequest(form({ skim: true, translate: false }), 600_000).ok).toBe(true);
  });

  it('rejects malformed times with the CLI message', () => {
    expect(fail(buildSubmitRequest(form({ start: '90:xx' }), 600_000))).toMatch(/Invalid time/);
  });

  it('rejects a reversed range even when the duration is unknown', () => {
    expect(fail(buildSubmitRequest(form({ start: '5:00', end: '2:00' }), null))).toMatch(/end/i);
  });

  it('enforces the 30 minute cap and the video length once the duration is known', () => {
    expect(buildSubmitRequest(form(), 40 * 60_000)).toMatchObject({ ok: false });
    expect(fail(buildSubmitRequest(form(), 40 * 60_000))).toMatch(/30 min limit/);
    expect(fail(buildSubmitRequest(form({ start: '20:00' }), 600_000))).toMatch(/start/i);
    expect(buildSubmitRequest(form({ start: '10:00', end: '35:00' }), 40 * 60_000).ok).toBe(true);
  });
});
```

`tests/renderer/new-job-dialog.test.tsx`:
```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewJobDialog } from '../../src/app/renderer/components/NewJobDialog';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { BgtApi } from '../../src/app/shared/ipc';

afterEach(cleanup);

function setup(over: Partial<{ probe: BgtApi['source']['probe']; submit: BgtApi['queue']['submit'] }> = {}) {
  const submit = vi.fn(over.submit ?? (async () => ({ ok: true as const, value: { id: 1 } as never })));
  const api = {
    source: {
      probe: over.probe ?? (async () => ({ ok: true as const, value: { title: 'My stream', durationMs: 600_000 } })),
      estimate: async () => ({ ok: true as const, value: 120 }),
    },
    queue: { submit },
    dialog: { pickMedia: async () => ({ ok: true as const, value: 'C:/clip.wav' }), pickGlossary: async () => ({ ok: true as const, value: null }), pathForFile: () => 'C:/dropped.wav' },
  } as unknown as BgtApi;
  const onClose = vi.fn();
  const onSubmitted = vi.fn();
  render(
    <ApiProvider api={api}>
      <NewJobDialog onClose={onClose} onSubmitted={onSubmitted} />
    </ApiProvider>,
  );
  return { submit, onClose, onSubmitted };
}

const url = 'https://www.youtube.com/watch?v=7SHNxjFuw10';

describe('NewJobDialog', () => {
  it('probes the URL on blur and shows the title, duration and estimate', async () => {
    setup();
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: url } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(screen.getByText('My stream')).toBeTruthy();
    expect(screen.getByText(/0:10:00/)).toBeTruthy();
    expect(screen.getByText(/about 2 min/)).toBeTruthy();
  });

  it('shows a probe error without blocking another attempt', async () => {
    setup({ probe: async () => ({ ok: false as const, error: { code: 'DownloadFailed', message: 'blocked by YouTube' } }) });
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: url } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(screen.getByText('blocked by YouTube')).toBeTruthy();
  });

  it('submits a valid request and reports success', async () => {
    const t = setup();
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: url } });
    await act(async () => {
      fireEvent.blur(input);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Add to queue'));
    });
    expect(t.submit).toHaveBeenCalledWith(
      expect.objectContaining({ source: url, startMs: 0, endMs: null, options: expect.objectContaining({ translate: true, summarize: true, skim: false }) }),
    );
    expect(t.onSubmitted).toHaveBeenCalled();
  });

  it('blocks submission with a message for skim + translate', async () => {
    const t = setup();
    fireEvent.change(screen.getByLabelText('YouTube link or file path'), { target: { value: url } });
    fireEvent.click(screen.getByLabelText('Skim (summary only)'));
    await act(async () => {
      fireEvent.click(screen.getByText('Add to queue'));
    });
    expect(t.submit).not.toHaveBeenCalled();
    expect(screen.getByText(/Skim skips full translation/)).toBeTruthy();
  });

  it('fills the source from the file chooser and from a dropped file', async () => {
    setup();
    await act(async () => {
      fireEvent.click(screen.getByText('Choose file'));
    });
    expect((screen.getByLabelText('YouTube link or file path') as HTMLInputElement).value).toBe('C:/clip.wav');
    await act(async () => {
      fireEvent.drop(screen.getByText(/Drop a file here/), { dataTransfer: { files: [new File(['x'], 'dropped.wav')] } });
    });
    expect((screen.getByLabelText('YouTube link or file path') as HTMLInputElement).value).toBe('C:/dropped.wav');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/renderer/newjob.test.ts tests/renderer/new-job-dialog.test.tsx`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

`src/app/renderer/lib/newjob.ts`:
```ts
import { parseTimestamp, resolveRange } from '../../../core/time';
import type { SubmitRequest } from '../../shared/ipc';

export interface NewJobForm {
  source: string;
  start: string;
  end: string;
  translate: boolean;
  summarize: boolean;
  skim: boolean;
  glossaryPath: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function buildSubmitRequest(
  form: NewJobForm,
  durationMs: number | null,
): { ok: true; request: SubmitRequest } | { ok: false; error: string } {
  const source = form.source.trim();
  if (source === '') return { ok: false, error: 'Enter a YouTube URL or choose a file.' };
  if (form.skim && form.translate) {
    return { ok: false, error: 'Skim skips full translation, so it cannot be combined with Translate.' };
  }

  let startMs = 0;
  let endMs: number | null = null;
  try {
    if (form.start.trim() !== '') startMs = parseTimestamp(form.start);
    if (form.end.trim() !== '') endMs = parseTimestamp(form.end);
  } catch (e) {
    return { ok: false, error: message(e) };
  }

  const maxMinutes = 30;
  if (durationMs !== null) {
    try {
      resolveRange({ startMs, endMs, durationMs, maxMinutes });
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  } else if (endMs !== null && endMs <= startMs) {
    return { ok: false, error: 'End must be after start.' };
  }

  return {
    ok: true,
    request: {
      source,
      startMs,
      endMs,
      options: {
        translate: form.translate,
        summarize: form.summarize,
        skim: form.skim,
        glossaryPath: form.glossaryPath ?? undefined,
        maxMinutes,
        model: 'large-v3',
      },
    },
  };
}
```

`src/app/renderer/components/NewJobDialog.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { ProbeResult } from '../../shared/ipc';
import { unwrap, useApi } from '../lib/api';
import { formatClock, formatEta } from '../lib/format';
import { buildSubmitRequest, type NewJobForm } from '../lib/newjob';

interface Props {
  onClose(): void;
  onSubmitted(): void;
}

type ProbeState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; info: ProbeResult } | { kind: 'error'; message: string };

export function NewJobDialog({ onClose, onSubmitted }: Props) {
  const api = useApi();
  const [form, setForm] = useState<NewJobForm>({
    source: '',
    start: '',
    end: '',
    translate: true,
    summarize: true,
    skim: false,
    glossaryPath: null,
  });
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const [eta, setEta] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const probed = useRef('');

  const set = <K extends keyof NewJobForm>(key: K, value: NewJobForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const runProbe = useCallback(
    async (source: string) => {
      const trimmed = source.trim();
      if (trimmed === '' || probed.current === trimmed) return;
      probed.current = trimmed;
      setProbe({ kind: 'loading' });
      const r = await api.source.probe(trimmed);
      if (probed.current !== trimmed) return;
      setProbe(r.ok ? { kind: 'ok', info: r.value } : { kind: 'error', message: r.error.message });
    },
    [api],
  );

  // Recompute the estimate when the probe or the range changes.
  useEffect(() => {
    if (probe.kind !== 'ok') {
      setEta(undefined);
      return;
    }
    let alive = true;
    const built = buildSubmitRequest(form, probe.info.durationMs);
    const startMs = built.ok ? built.request.startMs : 0;
    const endMs = built.ok ? built.request.endMs : null;
    void api.source.estimate({ durationMs: probe.info.durationMs, startMs, endMs }).then((r) => {
      if (alive && r.ok) setEta(r.value);
    });
    return () => {
      alive = false;
    };
  }, [api, probe, form.start, form.end]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseFile = async () => {
    const path = unwrap(await api.dialog.pickMedia());
    if (path) {
      set('source', path);
      await runProbe(path);
    }
  };

  const chooseGlossary = async () => {
    const path = unwrap(await api.dialog.pickGlossary());
    if (path) set('glossaryPath', path);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const path = api.dialog.pathForFile(file);
    set('source', path);
    await runProbe(path);
  };

  const submit = async () => {
    const durationMs = probe.kind === 'ok' ? probe.info.durationMs : null;
    const built = buildSubmitRequest(form, durationMs);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await api.queue.submit(built.request);
    setBusy(false);
    if (r.ok) onSubmitted();
    else setError(r.error.message);
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-label="New job">
        <h2>New job</h2>
        <label>
          YouTube link or file path
          <input
            type="text"
            value={form.source}
            placeholder="https://www.youtube.com/watch?v=..."
            onChange={(e) => {
              set('source', e.target.value);
              setError(null);
            }}
            onBlur={(e) => void runProbe(e.target.value)}
          />
        </label>
        <div
          className={`dropzone${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => void onDrop(e)}
        >
          Drop a file here or <button onClick={() => void chooseFile()}>Choose file</button>
        </div>
        {probe.kind === 'loading' && <div className="hint">Reading the video...</div>}
        {probe.kind === 'error' && <div className="error">{probe.message}</div>}
        {probe.kind === 'ok' && (
          <div>
            <strong>{probe.info.title ?? 'Untitled'}</strong>
            <div className="hint">{`Length ${formatClock(probe.info.durationMs)}${eta !== undefined ? ` - estimated time: ${formatEta(eta)}` : ''}`}</div>
          </div>
        )}
        <div className="inline">
          <label>
            Start (optional)
            <input type="text" value={form.start} placeholder="1:20:00" onChange={(e) => set('start', e.target.value)} />
          </label>
          <label>
            End (optional)
            <input type="text" value={form.end} placeholder="1:50:00" onChange={(e) => set('end', e.target.value)} />
          </label>
        </div>
        <div className="inline">
          <label className="inline">
            <input type="checkbox" checked={form.translate} onChange={(e) => set('translate', e.target.checked)} /> Translate
          </label>
          <label className="inline">
            <input type="checkbox" checked={form.summarize} onChange={(e) => set('summarize', e.target.checked)} /> Summarize
          </label>
          <label className="inline">
            <input type="checkbox" checked={form.skim} onChange={(e) => set('skim', e.target.checked)} /> Skim (summary only)
          </label>
        </div>
        <div className="inline">
          <button onClick={() => void chooseGlossary()}>Glossary file...</button>
          <span className="hint">{form.glossaryPath ?? 'none'}</span>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            Add to queue
          </button>
        </div>
      </div>
    </div>
  );
}
```
The `react-hooks` lint comment above refers to a plugin that is not installed; remove the `// eslint-disable-line` comment so lint does not complain about an unknown rule, and list the dependencies explicitly instead (`[api, probe, form]`).

In `src/app/renderer/App.tsx` replace the placeholder with `{newJobOpen && <NewJobDialog onClose={() => setNewJobOpen(false)} onSubmitted={() => { setNewJobOpen(false); setRoute({ name: 'library' }); }} />}` and add the import.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build:app && pnpm smoke:app`
Expected: PASS and `SMOKE OK`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(renderer): new job dialog with probe, estimate and validation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Players and subtitle overlay

**Files:**
- Create: `src/app/renderer/lib/timesource.ts`, `src/app/renderer/lib/youtube-api.ts`, `src/app/renderer/components/PlayerShell.tsx`, `src/app/renderer/components/YouTubePlayer.tsx`, `src/app/renderer/components/LocalPlayer.tsx`
- Test: `tests/renderer/timesource.test.tsx`, `tests/renderer/player-shell.test.tsx`, `tests/renderer/youtube-player.test.tsx`

**Interfaces:**
- Consumes: `findActiveIndex`, `subtitleText`, `SubtitleMode` (Task 10), `TranscriptLine` (type).
- Produces:
  - `interface TimeSource { getTimeMs(): number; seek(ms: number): void }`
  - `useCurrentTime(source: TimeSource | null, intervalMs?: number): number` (polls; state changes only when the value changes by at least 1 ms)
  - `PlayerShell({ lines, mode, size, timeMs, children, label })`: wraps the player (`children`), draws the overlay for the line active at `timeMs`, and provides the Fullscreen button for its container.
  - `YouTubePlayer({ videoId, startSeconds, onReady(source: TimeSource), onFail(message: string) })`: loads the IFrame API; reports API load failure and player errors 2, 5, 100, 101, 150, 153 through `onFail`.
  - `LocalPlayer({ jobId, startSeconds, onReady(source: TimeSource) })`: `<video src="bgt-media://job/<id>">`.
  - `loadYouTubeApi(): Promise<YTNamespace>`.

- [ ] **Step 1: Write the failing tests**

`tests/renderer/timesource.test.tsx`:
```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurrentTime, type TimeSource } from '../../src/app/renderer/lib/timesource';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Clock({ source }: { source: TimeSource | null }) {
  return <span data-testid="t">{useCurrentTime(source, 100)}</span>;
}

describe('useCurrentTime', () => {
  it('is 0 without a source', () => {
    render(<Clock source={null} />);
    expect(screen.getByTestId('t').textContent).toBe('0');
  });

  it('follows the source on every interval tick', () => {
    let now = 1000;
    const source: TimeSource = { getTimeMs: () => now, seek: () => {} };
    render(<Clock source={source} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId('t').textContent).toBe('1000');
    now = 2500;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId('t').textContent).toBe('2500');
  });

  it('stops polling when unmounted', () => {
    const getTimeMs = vi.fn(() => 5);
    const { unmount } = render(<Clock source={{ getTimeMs, seek: () => {} }} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const calls = getTimeMs.mock.calls.length;
    unmount();
    vi.advanceTimersByTime(1000);
    expect(getTimeMs.mock.calls.length).toBe(calls);
  });

  it('survives a source that throws (player not ready yet)', () => {
    const source: TimeSource = {
      getTimeMs: () => {
        throw new Error('not ready');
      },
      seek: () => {},
    };
    render(<Clock source={source} />);
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(300);
      }),
    ).not.toThrow();
    expect(screen.getByTestId('t').textContent).toBe('0');
  });
});
```

`tests/renderer/player-shell.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerShell } from '../../src/app/renderer/components/PlayerShell';

afterEach(cleanup);

const lines = [
  { id: 1, startMs: 1000, endMs: 2000, ja: 'こんにちは', en: 'Hello' },
  { id: 2, startMs: 3000, endMs: 4000, ja: 'えっと', en: null },
];

describe('PlayerShell', () => {
  it('shows nothing when no line is active', () => {
    render(<PlayerShell lines={lines} mode="both" size="medium" timeMs={2500}><div>player</div></PlayerShell>);
    expect(screen.queryByText('Hello')).toBeNull();
    expect(screen.getByText('player')).toBeTruthy();
  });

  it('shows the active line in English, Japanese or both, with the English fallback', () => {
    const { rerender } = render(<PlayerShell lines={lines} mode="en" size="medium" timeMs={1500}><div /></PlayerShell>);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByText('こんにちは')).toBeNull();
    rerender(<PlayerShell lines={lines} mode="both" size="medium" timeMs={1500}><div /></PlayerShell>);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('こんにちは')).toBeTruthy();
    rerender(<PlayerShell lines={lines} mode="en" size="medium" timeMs={3500}><div /></PlayerShell>);
    expect(screen.getByText('えっと')).toBeTruthy(); // no translation: falls back to Japanese
  });

  it('requests fullscreen on its own container so the overlay stays visible', () => {
    const request = vi.fn();
    render(<PlayerShell lines={lines} mode="en" size="medium" timeMs={0}><div /></PlayerShell>);
    const container = screen.getByTestId('player-container');
    container.requestFullscreen = request;
    fireEvent.click(screen.getByText('Fullscreen'));
    expect(request).toHaveBeenCalled();
  });

  it('applies the chosen subtitle size', () => {
    render(<PlayerShell lines={lines} mode="en" size="large" timeMs={1500}><div /></PlayerShell>);
    expect(screen.getByTestId('player-container').style.getPropertyValue('--sub-size')).toBe('30px');
  });
});
```

`tests/renderer/youtube-player.test.tsx`:
```tsx
// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YouTubePlayer } from '../../src/app/renderer/components/YouTubePlayer';

type Handlers = { onReady?: () => void; onError?: (e: { data: number }) => void };

let handlers: Handlers = {};
let created: { videoId: string; playerVars: Record<string, unknown> } | null = null;
const player = { getCurrentTime: vi.fn(() => 12.5), seekTo: vi.fn(), destroy: vi.fn() };

beforeEach(() => {
  handlers = {};
  created = null;
  (window as unknown as { YT: unknown }).YT = {
    Player: function (_el: unknown, opts: { videoId: string; playerVars: Record<string, unknown>; events: Handlers }) {
      created = { videoId: opts.videoId, playerVars: opts.playerVars };
      handlers = opts.events;
      return player;
    },
  };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { YT?: unknown }).YT;
  vi.clearAllMocks();
});

describe('YouTubePlayer', () => {
  it('creates the player with embed-friendly options and exposes a TimeSource when ready', async () => {
    const onReady = vi.fn();
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={60} onReady={onReady} onFail={() => {}} />);
    await act(async () => {});
    expect(created?.videoId).toBe('7SHNxjFuw10');
    expect(created?.playerVars).toMatchObject({ enablejsapi: 1, fs: 0, rel: 0, start: 60 });
    act(() => handlers.onReady?.());
    const source = onReady.mock.calls[0][0];
    expect(source.getTimeMs()).toBe(12_500);
    source.seek(30_000);
    expect(player.seekTo).toHaveBeenCalledWith(30, true);
  });

  it.each([2, 5, 100, 101, 150, 153])('reports player error %i through onFail', async (code) => {
    const onFail = vi.fn();
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={onFail} />);
    await act(async () => {});
    act(() => handlers.onError?.({ data: code }));
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0]).toMatch(/embed|play|YouTube/i);
  });

  it('reports a failure to load the YouTube API', async () => {
    delete (window as unknown as { YT?: unknown }).YT;
    const onFail = vi.fn();
    const append = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      queueMicrotask(() => (node as HTMLScriptElement).onerror?.(new Event('error')));
      return node;
    });
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={onFail} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onFail).toHaveBeenCalledWith(expect.stringMatching(/load the YouTube player/i));
    append.mockRestore();
  });

  it('destroys the player on unmount', async () => {
    const { unmount } = render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={() => {}} />);
    await act(async () => {});
    unmount();
    expect(player.destroy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/renderer/timesource.test.tsx tests/renderer/player-shell.test.tsx tests/renderer/youtube-player.test.tsx`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

`src/app/renderer/lib/timesource.ts`:
```ts
import { useEffect, useState } from 'react';

export interface TimeSource {
  getTimeMs(): number;
  seek(ms: number): void;
}

/** Polls a player for its current time. State only changes when the value does. */
export function useCurrentTime(source: TimeSource | null, intervalMs = 100): number {
  const [timeMs, setTimeMs] = useState(0);
  useEffect(() => {
    if (!source) {
      setTimeMs(0);
      return;
    }
    const id = setInterval(() => {
      try {
        const next = Math.round(source.getTimeMs());
        setTimeMs((prev) => (next === prev ? prev : next));
      } catch {
        /* the player is not ready yet */
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [source, intervalMs]);
  return timeMs;
}
```

`src/app/renderer/lib/youtube-api.ts`:
```ts
export interface YTPlayer {
  getCurrentTime(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  destroy(): void;
}

export interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      host?: string;
      playerVars: Record<string, unknown>;
      events: { onReady?: () => void; onError?: (e: { data: number }) => void };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!loading) {
    loading = new Promise<YTNamespace>((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve(window.YT as YTNamespace);
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => {
        loading = null;
        reject(new Error('Could not load the YouTube player.'));
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}
```

`src/app/renderer/components/YouTubePlayer.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import type { TimeSource } from '../lib/timesource';
import { loadYouTubeApi } from '../lib/youtube-api';

interface Props {
  videoId: string;
  startSeconds: number;
  onReady(source: TimeSource): void;
  onFail(message: string): void;
}

const ERRORS: Record<number, string> = {
  2: 'YouTube rejected this video link.',
  5: 'The YouTube player hit an error playing this video.',
  100: 'This video was removed or is private.',
  101: 'The owner of this video does not allow it to be embedded.',
  150: 'The owner of this video does not allow it to be embedded.',
  153: 'YouTube refused to play the video inside the app (embed configuration error).',
};

export function YouTubePlayer({ videoId, startSeconds, onReady, onFail }: Props) {
  const host = useRef<HTMLDivElement>(null);
  // Keep the latest callbacks without recreating the player.
  const callbacks = useRef({ onReady, onFail });
  callbacks.current = { onReady, onFail };

  useEffect(() => {
    let destroyed = false;
    let player: { destroy(): void } | null = null;
    const mount = document.createElement('div');
    host.current?.appendChild(mount);

    loadYouTubeApi()
      .then((YT) => {
        if (destroyed) return;
        const created = new YT.Player(mount, {
          videoId,
          host: 'https://www.youtube.com',
          playerVars: {
            enablejsapi: 1,
            fs: 0,
            rel: 0,
            playsinline: 1,
            start: Math.max(0, Math.floor(startSeconds)),
            origin: 'https://bgt.local',
          },
          events: {
            onReady: () =>
              callbacks.current.onReady({
                getTimeMs: () => created.getCurrentTime() * 1000,
                seek: (ms) => created.seekTo(ms / 1000, true),
              }),
            onError: (e) => callbacks.current.onFail(ERRORS[e.data] ?? `The YouTube player reported error ${e.data}.`),
          },
        });
        player = created;
      })
      .catch((err: Error) => {
        if (!destroyed) callbacks.current.onFail(err.message);
      });

    return () => {
      destroyed = true;
      player?.destroy();
      mount.remove();
    };
  }, [videoId, startSeconds]);

  return <div ref={host} style={{ width: '100%', height: '100%' }} />;
}
```

`src/app/renderer/components/LocalPlayer.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import type { TimeSource } from '../lib/timesource';

interface Props {
  jobId: number;
  startSeconds: number;
  onReady(source: TimeSource): void;
}

export function LocalPlayer({ jobId, startSeconds, onReady }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const ready = () => {
      if (startSeconds > 0) video.currentTime = startSeconds;
      onReady({ getTimeMs: () => video.currentTime * 1000, seek: (ms) => (video.currentTime = ms / 1000) });
    };
    video.addEventListener('loadedmetadata', ready, { once: true });
    return () => video.removeEventListener('loadedmetadata', ready);
  }, [jobId, startSeconds, onReady]);
  return <video ref={ref} src={`bgt-media://job/${jobId}`} controls style={{ width: '100%', height: '100%' }} />;
}
```

`src/app/renderer/components/PlayerShell.tsx`:
```tsx
import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { TranscriptLine } from '../../shared/ipc';
import { findActiveIndex, subtitleText, type SubtitleMode } from '../lib/subtitles';

export type SubtitleSize = 'small' | 'medium' | 'large';
const SIZES: Record<SubtitleSize, string> = { small: '16px', medium: '22px', large: '30px' };

interface Props {
  lines: TranscriptLine[];
  mode: SubtitleMode;
  size: SubtitleSize;
  timeMs: number;
  children: ReactNode;
}

export function PlayerShell({ lines, mode, size, timeMs, children }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const active = findActiveIndex(lines, timeMs);
  const text = active >= 0 ? subtitleText(lines[active], mode) : [];

  const toggleFullscreen = () => {
    const el = container.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  return (
    <div>
      <div ref={container} className="player" data-testid="player-container" style={{ ['--sub-size' as string]: SIZES[size] }}>
        {children}
        <div className="overlay" aria-live="off">
          {text.map((t, i) => (
            <div key={i}>
              <span>{t}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="toolbar">
        <button onClick={toggleFullscreen}>Fullscreen</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(renderer): YouTube and local players with subtitle overlay and fullscreen

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Transcript, Summary, and the Job screen

**Files:**
- Create: `src/app/renderer/components/TranscriptPanel.tsx`, `src/app/renderer/components/SummaryPanel.tsx`, `src/app/renderer/components/JobScreen.tsx`, `src/app/renderer/lib/summary.ts`
- Modify: `src/app/renderer/App.tsx`
- Test: `tests/renderer/summary.test.ts`, `tests/renderer/panels.test.tsx`, `tests/renderer/job-screen.test.tsx`

**Interfaces:**
- Consumes: Tasks 10 and 13; `JobDetail`, `SummaryRow`, `TranscriptLine`.
- Produces:
  - `splitTimestamps(text: string): ({ text: string } | { ts: string; ms: number })[]` (finds `[h:mm:ss]` and `[m:ss]`).
  - `TranscriptPanel({ lines, activeIndex, mode, onSeek })`, `SummaryPanel({ summaries, onSeek })`.
  - `JobScreen({ jobId, onBack })`: loads `job.get`; chooses `YouTubePlayer` (URL jobs with a `videoId`), `LocalPlayer` (local-file jobs), or reader mode; owns subtitle mode (default English when any translation exists, else Japanese), size, tab, and `TimeSource`; reader mode shows the notice and "Open on YouTube" for URL jobs; "Open output folder" button.

- [ ] **Step 1: Write the failing tests**

`tests/renderer/summary.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { splitTimestamps } from '../../src/app/renderer/lib/summary';

describe('splitTimestamps', () => {
  it('splits text around [h:mm:ss] and [m:ss] timestamps with their millisecond values', () => {
    expect(splitTimestamps('- [0:01:05] Intro and [12:30] more [1:02:03] end')).toEqual([
      { text: '- ' },
      { ts: '0:01:05', ms: 65_000 },
      { text: ' Intro and ' },
      { ts: '12:30', ms: 750_000 },
      { text: ' more ' },
      { ts: '1:02:03', ms: 3_723_000 },
      { text: ' end' },
    ]);
  });

  it('returns the whole text when there is no timestamp, and ignores look-alikes', () => {
    expect(splitTimestamps('plain')).toEqual([{ text: 'plain' }]);
    expect(splitTimestamps('[abc] [1:2] [99]')).toEqual([{ text: '[abc] [1:2] [99]' }]);
    expect(splitTimestamps('')).toEqual([]);
  });
});
```

`tests/renderer/panels.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SummaryPanel } from '../../src/app/renderer/components/SummaryPanel';
import { TranscriptPanel } from '../../src/app/renderer/components/TranscriptPanel';

afterEach(cleanup);

const lines = [
  { id: 1, startMs: 1000, endMs: 2000, ja: 'こんにちは', en: 'Hello' },
  { id: 2, startMs: 3_723_000, endMs: 3_724_000, ja: 'えっと', en: null },
];

describe('TranscriptPanel', () => {
  it('shows timestamps and text per mode, highlights the active line and seeks on click', () => {
    const onSeek = vi.fn();
    render(<TranscriptPanel lines={lines} activeIndex={0} mode="both" onSeek={onSeek} />);
    expect(screen.getByText('0:00:01')).toBeTruthy();
    expect(screen.getByText('1:02:03')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('こんにちは')).toBeTruthy();
    expect(document.querySelectorAll('.line.active')).toHaveLength(1);
    fireEvent.click(screen.getByText('Hello'));
    expect(onSeek).toHaveBeenCalledWith(1000);
  });

  it('shows Japanese only in ja mode and falls back to Japanese when English is missing', () => {
    render(<TranscriptPanel lines={lines} activeIndex={-1} mode="en" onSeek={() => {}} />);
    expect(screen.getByText('えっと')).toBeTruthy();
    expect(document.querySelectorAll('.line.active')).toHaveLength(0);
  });

  it('shows an empty-state message for a job with no speech', () => {
    render(<TranscriptPanel lines={[]} activeIndex={-1} mode="en" onSeek={() => {}} />);
    expect(screen.getByText(/No speech/)).toBeTruthy();
  });
});

describe('SummaryPanel', () => {
  const summaries = [
    { level: 'overview' as const, idx: 0, startMs: 0, endMs: 600_000, text: 'A cozy stream.' },
    { level: 'window' as const, idx: 0, startMs: 0, endMs: 300_000, text: '- [0:00:10] Intro\n- [0:03:24] Reviews makeup' },
  ];

  it('renders the overview and timeline with clickable timestamps that seek', () => {
    const onSeek = vi.fn();
    render(<SummaryPanel summaries={summaries} onSeek={onSeek} />);
    expect(screen.getByText('A cozy stream.')).toBeTruthy();
    fireEvent.click(screen.getByText('0:03:24'));
    expect(onSeek).toHaveBeenCalledWith(204_000);
  });

  it('shows a message when there is no summary', () => {
    render(<SummaryPanel summaries={[]} onSeek={() => {}} />);
    expect(screen.getByText(/No summary/)).toBeTruthy();
  });
});
```

`tests/renderer/job-screen.test.tsx`:
```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobScreen } from '../../src/app/renderer/components/JobScreen';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { BgtApi, JobDetail } from '../../src/app/shared/ipc';

afterEach(cleanup);

vi.mock('../../src/app/renderer/components/YouTubePlayer', () => ({
  YouTubePlayer: (p: { onFail(m: string): void; videoId: string }) => (
    <div data-testid="yt" data-video={p.videoId}>
      <button onClick={() => p.onFail('The owner of this video does not allow it to be embedded.')}>fail</button>
    </div>
  ),
}));
vi.mock('../../src/app/renderer/components/LocalPlayer', () => ({
  LocalPlayer: (p: { jobId: number }) => <div data-testid="local" data-job={p.jobId} />,
}));

const detail = (over: Partial<JobDetail['item']> = {}, withEnglish = true): JobDetail => ({
  item: {
    jobId: 1,
    title: 'GRWM',
    source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
    videoId: '7SHNxjFuw10',
    status: 'done',
    rangeStartMs: 0,
    rangeEndMs: 557_000,
    createdAt: '2026-10-14T00:00:00Z',
    hasTranslation: withEnglish,
    hasSummary: true,
    isLocalFile: false,
    ...over,
  },
  lines: [{ id: 1, startMs: 1000, endMs: 2000, ja: 'こんにちは', en: withEnglish ? 'Hello' : null }],
  summaries: [{ level: 'overview', idx: 0, startMs: 0, endMs: 1, text: 'Overview text' }],
});

function mount(d: JobDetail | null, openFolder = vi.fn(async () => ({ ok: true as const, value: null }))) {
  const api = {
    job: {
      get: async () => (d ? { ok: true as const, value: d } : { ok: false as const, error: { code: 'InvalidInput', message: 'There is no job 1.' } }),
      openOutputFolder: openFolder,
    },
  } as unknown as BgtApi;
  render(
    <ApiProvider api={api}>
      <JobScreen jobId={1} onBack={() => {}} />
    </ApiProvider>,
  );
  return { openFolder };
}

describe('JobScreen', () => {
  it('uses the YouTube player for URL jobs and the English transcript by default', async () => {
    mount(detail());
    await act(async () => {});
    expect(screen.getByTestId('yt').getAttribute('data-video')).toBe('7SHNxjFuw10');
    expect(screen.getByText('GRWM')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
    expect((screen.getByLabelText('Subtitles') as HTMLSelectElement).value).toBe('en');
  });

  it('defaults to Japanese when nothing was translated', async () => {
    mount(detail({}, false));
    await act(async () => {});
    expect((screen.getByLabelText('Subtitles') as HTMLSelectElement).value).toBe('ja');
  });

  it('uses the local player for local-file jobs', async () => {
    mount(detail({ isLocalFile: true, videoId: null, source: 'C:/clips/a.wav' }));
    await act(async () => {});
    expect(screen.getByTestId('local').getAttribute('data-job')).toBe('1');
  });

  it('switches to reader mode with a notice and an Open on YouTube link when the embed fails', async () => {
    mount(detail());
    await act(async () => {});
    fireEvent.click(screen.getByText('fail'));
    expect(screen.getByText(/does not allow it to be embedded/)).toBeTruthy();
    expect(screen.getByText('Open on YouTube')).toBeTruthy();
    expect(screen.queryByTestId('yt')).toBeNull();
    expect(screen.getByText('Hello')).toBeTruthy(); // transcript still works
  });

  it('shows the summary tab and opens the output folder', async () => {
    const t = mount(detail());
    await act(async () => {});
    fireEvent.click(screen.getByText('Summary'));
    expect(screen.getByText('Overview text')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('Open output folder'));
    });
    expect(t.openFolder).toHaveBeenCalledWith(1);
  });

  it('shows the error when the job cannot be loaded', async () => {
    mount(null);
    await act(async () => {});
    expect(screen.getByText('There is no job 1.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/renderer/summary.test.ts tests/renderer/panels.test.tsx tests/renderer/job-screen.test.tsx`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

`src/app/renderer/lib/summary.ts`:
```ts
export type SummaryPart = { text: string } | { ts: string; ms: number };

const TS = /\[(\d+:\d{2}:\d{2}|\d{1,3}:\d{2})\]/g;

function toMs(ts: string): number {
  const parts = ts.split(':').map(Number);
  const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
  return seconds * 1000;
}

/** Splits summary text around `[h:mm:ss]` / `[m:ss]` timestamps so they can be rendered as links. */
export function splitTimestamps(text: string): SummaryPart[] {
  const out: SummaryPart[] = [];
  let last = 0;
  for (const m of text.matchAll(TS)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ text: text.slice(last, index) });
    out.push({ ts: m[1], ms: toMs(m[1]) });
    last = index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
```

`src/app/renderer/components/TranscriptPanel.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import type { TranscriptLine } from '../../shared/ipc';
import { formatClock } from '../lib/format';
import { subtitleText, type SubtitleMode } from '../lib/subtitles';

interface Props {
  lines: TranscriptLine[];
  activeIndex: number;
  mode: SubtitleMode;
  onSeek(ms: number): void;
}

export function TranscriptPanel({ lines, activeIndex, mode, onSeek }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  if (lines.length === 0) return <div className="panel">No speech was transcribed for this job.</div>;
  return (
    <div className="panel">
      {lines.map((line, i) => {
        const [primary, secondary] = subtitleText(line, mode);
        return (
          <button
            key={line.id}
            ref={i === activeIndex ? activeRef : undefined}
            className={`line${i === activeIndex ? ' active' : ''}`}
            onClick={() => onSeek(line.startMs)}
          >
            <span className="time">{formatClock(line.startMs)}</span>
            <span>
              <span>{primary}</span>
              {secondary && <div className="ja">{secondary}</div>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
```

`src/app/renderer/components/SummaryPanel.tsx`:
```tsx
import type { Fragment, ReactNode } from 'react';
import type { SummaryRow } from '../../shared/ipc';
import { formatClock } from '../lib/format';
import { splitTimestamps } from '../lib/summary';

interface Props {
  summaries: SummaryRow[];
  onSeek(ms: number): void;
}

function Linked({ text, onSeek }: { text: string; onSeek(ms: number): void }): ReactNode {
  return splitTimestamps(text).map((part, i) =>
    'ts' in part ? (
      <button key={i} className="ts" onClick={() => onSeek(part.ms)}>
        {part.ts}
      </button>
    ) : (
      <span key={i}>{part.text}</span>
    ),
  );
}

function Block({ row, onSeek }: { row: SummaryRow; onSeek(ms: number): void }) {
  return (
    <section>
      <h3>{`${formatClock(row.startMs)} to ${formatClock(row.endMs)}`}</h3>
      {row.text.split('\n').map((line, i) => (
        <p key={i}>
          <Linked text={line} onSeek={onSeek} />
        </p>
      ))}
    </section>
  );
}

export function SummaryPanel({ summaries, onSeek }: Props) {
  if (summaries.length === 0) return <div className="panel">No summary for this job. Run it with Summarize or Skim.</div>;
  const of = (level: SummaryRow['level']) => summaries.filter((s) => s.level === level);
  const overview = of('overview')[0];
  return (
    <div className="panel summary">
      {overview && (
        <section>
          <h3>Overview</h3>
          <p>{overview.text}</p>
        </section>
      )}
      {of('section').length > 0 && <h3>Sections</h3>}
      {of('section').map((row) => (
        <Block key={`s${row.idx}`} row={row} onSeek={onSeek} />
      ))}
      {of('window').length > 0 && <h3>Timeline</h3>}
      {of('window').map((row) => (
        <Block key={`w${row.idx}`} row={row} onSeek={onSeek} />
      ))}
    </div>
  );
}
```
(Remove the unused `Fragment` import from the type import line when writing the file: `import type { ReactNode } from 'react';`.)

`src/app/renderer/components/JobScreen.tsx`:
```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobDetail } from '../../shared/ipc';
import { useApi } from '../lib/api';
import { findActiveIndex, type SubtitleMode } from '../lib/subtitles';
import { useCurrentTime, type TimeSource } from '../lib/timesource';
import { LocalPlayer } from './LocalPlayer';
import { PlayerShell, type SubtitleSize } from './PlayerShell';
import { SummaryPanel } from './SummaryPanel';
import { TranscriptPanel } from './TranscriptPanel';
import { YouTubePlayer } from './YouTubePlayer';

interface Props {
  jobId: number;
  onBack(): void;
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; detail: JobDetail };

export function JobScreen({ jobId, onBack }: Props) {
  const api = useApi();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [mode, setMode] = useState<SubtitleMode>('en');
  const [size, setSize] = useState<SubtitleSize>('medium');
  const [tab, setTab] = useState<'transcript' | 'summary'>('transcript');
  const [source, setSource] = useState<TimeSource | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoad({ kind: 'loading' });
    setFailure(null);
    setSource(null);
    void api.job.get(jobId).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setLoad({ kind: 'ok', detail: r.value });
        setMode(r.value.item.hasTranslation ? 'en' : 'ja');
      } else {
        setLoad({ kind: 'error', message: r.error.message });
      }
    });
    return () => {
      alive = false;
    };
  }, [api, jobId]);

  const timeMs = useCurrentTime(source);
  const lines = load.kind === 'ok' ? load.detail.lines : [];
  const activeIndex = useMemo(() => findActiveIndex(lines, timeMs), [lines, timeMs]);
  const seek = useCallback((ms: number) => source?.seek(ms), [source]);
  const onReady = useCallback((s: TimeSource) => setSource(s), []);
  const onFail = useCallback((message: string) => setFailure(message), []);

  if (load.kind === 'loading') return <div>Loading...</div>;
  if (load.kind === 'error') {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div className="notice">{load.message}</div>
      </div>
    );
  }

  const { item, summaries } = load.detail;
  const startSeconds = item.rangeStartMs / 1000;
  const youtubeUrl = item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}&t=${Math.floor(startSeconds)}s` : null;

  return (
    <div className="job">
      <div className="job-left">
        <div className="toolbar">
          <button onClick={onBack}>Back</button>
          <strong>{item.title ?? item.source}</strong>
        </div>
        {failure ? (
          <div className="notice">
            <div>{failure}</div>
            <div>The transcript and summary still work; click a line to see its time.</div>
            {youtubeUrl && (
              <button onClick={() => window.open(youtubeUrl)}>Open on YouTube</button>
            )}
          </div>
        ) : (
          <PlayerShell lines={lines} mode={mode} size={size} timeMs={timeMs}>
            {item.isLocalFile ? (
              <LocalPlayer jobId={item.jobId} startSeconds={startSeconds} onReady={onReady} />
            ) : item.videoId ? (
              <YouTubePlayer videoId={item.videoId} startSeconds={startSeconds} onReady={onReady} onFail={onFail} />
            ) : (
              <div className="notice">This job has no playable video.</div>
            )}
          </PlayerShell>
        )}
        <div className="toolbar">
          <label>
            Subtitles{' '}
            <select aria-label="Subtitles" value={mode} onChange={(e) => setMode(e.target.value as SubtitleMode)}>
              <option value="en">English</option>
              <option value="ja">Japanese</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label>
            Size{' '}
            <select aria-label="Size" value={size} onChange={(e) => setSize(e.target.value as SubtitleSize)}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
          <button onClick={() => void api.job.openOutputFolder(item.jobId)}>Open output folder</button>
          {youtubeUrl && !failure && <button onClick={() => window.open(youtubeUrl)}>Open on YouTube</button>}
        </div>
      </div>
      <div className="job-right">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'transcript'} onClick={() => setTab('transcript')}>
            Transcript
          </button>
          <button role="tab" aria-selected={tab === 'summary'} onClick={() => setTab('summary')}>
            Summary
          </button>
        </div>
        {tab === 'transcript' ? (
          <TranscriptPanel lines={lines} activeIndex={activeIndex} mode={mode} onSeek={seek} />
        ) : (
          <SummaryPanel summaries={summaries} onSeek={seek} />
        )}
      </div>
    </div>
  );
}
```
(`window.open(url)` is intercepted by the main process's window-open handler, which opens it in the system browser. In the job-screen test the "Open on YouTube" text appears once in reader mode; when the player works the toolbar button is shown, so the test that expects a single match only runs in the failed state.)

In `src/app/renderer/App.tsx` replace the job placeholder with `<JobScreen jobId={route.jobId} onBack={() => setRoute({ name: 'library' })} />` and import it.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build:app && pnpm smoke:app`
Expected: PASS and `SMOKE OK`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(renderer): transcript, summary and job screen with reader-mode fallback

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: End-to-end verification with real data and a dev guide

**Files:**
- Create: `docs/development.md`
- Modify (only if verification demands it): any file from Tasks 5 to 14.

**Interfaces:** none new.

This task needs the author's eyes for the parts a script cannot judge (the embed, overlay timing, seeking). Everything else is verified by command.

- [ ] **Step 1: Write the dev guide**

`docs/development.md`:
```markdown
# Development

## Commands
- `pnpm setup:tools` downloads yt-dlp, whisper.cpp, llama.cpp and the models into `resources/` (see `tools.lock.json`).
- `pnpm bgt run <url|file> [--translate --summarize --skim]` is the command-line pipeline.
- `pnpm dev:app` starts the desktop app with hot reload. `pnpm build:app` builds it; `pnpm smoke:app` launches the build headless and checks the window and IPC bridge.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` (BGT_INTEGRATION=1 enables the tests that use the real binaries and models).

## Layout
- `src/core` pipeline, database, tool wrappers; no Electron or React imports.
- `src/app/main` Electron main process (queue, IPC handlers, media protocol); `src/app/preload` the `window.bgt` bridge; `src/app/renderer` the React UI; `src/app/shared` types shared by both.
- Data lives in `data/` (SQLite, work files) and `output/` (subtitles, summaries). The app and the CLI share them.
```

- [ ] **Step 2: Automated checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build:app && pnpm smoke:app`
Expected: all green and `SMOKE OK`. Also `BGT_INTEGRATION=1 pnpm test tests/integration` still passes (the real database adapter and LLM path).

- [ ] **Step 3: Existing jobs open in the app (needs the author)**

Run `pnpm dev:app`. Confirm the library lists jobs 2 and 3 (titles show as the source because they predate title storage), open job 2 and check: the YouTube video plays, the English overlay follows the speech, clicking a transcript line seeks the video, clicking a summary timestamp seeks the video, the subtitle mode switch changes the overlay. If the YouTube player shows an error (for example the 153 configuration error), try in this order and re-test after each: (a) change `REFERER` in `main/index.ts` and the `origin` in `YouTubePlayer.tsx` to the same `https://` value of a real site you control or `https://www.youtube.com/`; (b) switch the iframe host to `https://www.youtube-nocookie.com`; (c) serve the renderer from a local `http://127.0.0.1` server and use that origin. Record what worked in `docs/development.md`.

- [ ] **Step 4: A fresh job through the UI (needs the author)**

In the app: New job, paste a YouTube URL (a short one), confirm the title, length and estimate appear, leave Translate and Summarize checked, Add to queue. Watch the queue strip move through downloading, transcribing, finding names, translating and summarizing; confirm the job appears in the library and opens with English subtitles. Then: queue a second job and Cancel it while running (it ends `Cancelled`, with `Resume` available); start a third and quit the app mid-translation, reopen it, confirm it shows `Interrupted` and `Resume` continues without redoing finished work. After quitting, check Task Manager (or `tasklist`) shows no `whisper-cli`, `llama-server`, `yt-dlp` or `ffmpeg` left running.

- [ ] **Step 5: Local file job**

Drop a local audio or video file onto the New job dialog (not a YouTube video): confirm the file path fills in, probe shows its length, submit, and confirm the finished job plays in the local player with a working overlay.

- [ ] **Step 6: Fix pass and commit**

Fix anything found, with a failing test first where the problem is testable (queue, validation, subtitle logic); manual-only fixes (CSS, embed settings) get a line in `docs/development.md`. Then:

```bash
git add -A
git commit -m "docs: development guide and fixes from the end-to-end check

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `node:sqlite` adapter; `better-sqlite3` removed; tests still green | 1 |
| Migration 3: `jobs.title/video_id`, `submissions` | 2 |
| `parseYoutubeId`, probe with title, title/video id stored | 3 |
| Progress events, `onJob`, shared DB handle, `BGT_PROJECT_ROOT` | 4 |
| electron-vite scaffold, sandboxed preload, smoke test, lint boundaries | 5 |
| IPC contract, argument validation, library/job detail service | 6 |
| Sequential queue: cancel, resume, startup recovery, shutdown | 7 |
| Submission -> `runJob` -> LLM stages, early glossary check, chunk failure | 8 |
| Handlers, media protocol authorization, preload, lifecycle (single instance, close confirm, quit cleanup), referrer fix, CSP | 9 |
| API hooks, formatting, `findActiveIndex`, subtitle modes | 10 |
| Library screen, queue strip, app shell | 11 |
| New job: probe, estimate, validation, file choose/drop | 12 |
| YouTube and local players, overlay, own fullscreen, embed-failure reporting | 13 |
| Transcript/summary panels with seeking, job screen, reader-mode fallback | 14 |
| Existing jobs open, real embed, cancel/resume, no orphan processes, local file | 15 |
