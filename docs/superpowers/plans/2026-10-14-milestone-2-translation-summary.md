# Milestone 2 Translation and Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resumable glossary, English translation, and hierarchical summary stages (local `llama-server`, Hy-MT2-7B for translation, a Qwen3-8B general model for glossary and summaries) after the Milestone 1 transcription pipeline, with English, bilingual, and summary outputs.

**Architecture:** Stage runners in `src/core/pipeline/*-job.ts` read segments from SQLite, call an `LlmChat` (OpenAI-compatible HTTP client) served by a managed `llama-server` process, and persist per-batch results so a killed run resumes. A `ModelPool` guarantees only one model is loaded at a time; `runLlmStages` sequences glossary, translate, summarize. Pure prompt builders and reply parsers carry the model-facing logic.

**Tech Stack:** Existing (Node 23, TypeScript ESM, pnpm, vitest, better-sqlite3, commander) plus llama.cpp `llama-server` (CUDA 12.4 Windows build), Hy-MT2-7B Q4_K_M GGUF, Qwen3-8B Q4_K_M GGUF. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-milestone-2-translation-summary-design.md` (builds on the Milestone 1 spec and code already on `master`).

## Global Constraints

- `src/core/` must never import `electron`, `react`, `react-dom`, or anything under `src/cli`, `src/main`, `src/preload`, `src/renderer` (ESLint enforces it).
- Local and free by default; no cloud backend (Gemini is out of scope).
- Only one model loaded at a time: Whisper and the LLM never share VRAM; translation model and general model never run together.
- Translation model: Tencent Hy-MT2-7B, file `Hy-MT2-7B-Q4_K_M.gguf` from `tencent/Hy-MT2-7B-GGUF` (Apache-2.0). General model: `Qwen3-8B-Q4_K_M.gguf` from `Qwen/Qwen3-8B-GGUF`. Both are config values (lock ids `model-translate`, `model-general`).
- Translation batches of about 25 segments; the reply must have exactly one line per input line; mismatch is retried (2 retries), then translated line by line; a line that still fails is stored empty and logged, never invented.
- Summary windows of about 5 minutes; 2 to 4 bullets per window; a section level (groups of 6 windows) is added only above 12 windows; summaries use the English translation when it exists, otherwise the Japanese text.
- Segments in the DB are relative to the extracted audio (0 = range start); every output adds the job's `rangeStartMs`. Summary rows store absolute (video) times.
- Outputs: `job-N.en.srt`, `job-N.bi.srt` (English line then Japanese line), `job-N.summary.md`.
- New error codes `LlmServerFailed` and `LlmFailed`. Ctrl+C aborts in-flight requests and stops `llama-server` before exiting.
- Database migration 2 (`PRAGMA user_version = 2`) adds `glossary`, `translations`, `summaries`, `stages`. Existing tables and Milestone 1 behavior stay unchanged.
- Windows first. Never commit models, binaries, media, transcripts, or the SQLite file.

## Deviations from the spec (intentional)

- `llama-server` is resolved from `resources/llama` (recursive search) then `PATH`.
- Model file paths come from `tools.lock.json` entries by id, because the exact file names are only fixed at pin time.
- The pin script now preserves existing lock entries (yt-dlp, whisper.cpp, large-v3 keep their pinned versions) and only adds missing ones unless run with `--update`.
- `StageOptions.batchSize` exists (default 25) so tests can exercise batching with small data.

## Review Focus

1. **Model replies with the wrong number of lines, merged lines, or extra chatter** must never produce misaligned subtitles: wrong count means retry, then line-by-line, then blank. Pinned in Task 7.
2. **Reasoning blocks (`<think>`) and markdown code fences in replies** are stripped before parsing. Pinned in Tasks 3 and 6.
3. **A job with no segments** (silent video) skips translation and summaries without starting any model. Pinned in Task 11.
4. **Abort during server startup or an in-flight request** leaves no orphaned `llama-server` process. Pinned in Task 6.
5. **Re-transcribed chunks** drop their old translations (no stale or misattributed English), and a malformed `--glossary` file is a clear `InvalidInput`. Pinned in Tasks 2 and 12.

---

## File Structure

```
src/core/errors.ts                          # + LlmServerFailed, LlmFailed
src/core/tools/paths.ts                     # + llama-server tool
src/core/tools/lock.ts                      # + merge flag, lockedModelPath
src/core/tools/fetch.ts                     # merge-aware zip extraction
src/core/tools/process.ts                   # export killTree
src/core/db/schema.ts                       # migration 2
src/core/db/repo.ts                         # + listSegmentsWithId, cascade translation deletes
src/core/db/stage-repo.ts                   # StageRepo (glossary, translations, summaries, stages)
src/core/llm/parse.ts                       # stripThinking, parseNumberedLines, parseGlossaryJson
src/core/llm/prompts.ts                     # message builders
src/core/llm/windows.ts                     # splitWindows, renderWindow
src/core/llm/client.ts                      # LlmChat, LlmClient
src/core/llm/llama-server.ts                # LlamaServer
src/core/llm/glossary-file.ts               # loadGlossaryFile
src/core/backends/translate/hymt.ts         # HyMtTranslator, BatchTranslator
src/core/pipeline/glossary-job.ts, translate-job.ts, summarize-job.ts
src/core/subtitles/bilingual.ts, summary-md.ts
src/core/pipeline/llm-outputs.ts            # writeLlmOutputs
src/core/pipeline/stages.ts                 # runLlmStages, ModelPool
src/core/pipeline/real-llm.ts               # createRealModelPool
src/core/pipeline/real-deps.ts              # + stages (StageRepo) in the return value
src/cli/run.ts, src/cli/llm.ts, src/cli/index.ts, src/cli/doctor.ts
scripts/pin-tools.ts                        # rewritten: preserves existing entries
tests/fixtures/fake-llama-server.mjs
tests/helpers/fakes.ts (+ memoryRepos, seedJob), tests/helpers/llm-fakes.ts
tests/core/*.test.ts, tests/integration/llm.integration.test.ts
```

---

### Task 1: Error codes, llama-server path resolution, model lookup by lock id

**Files:**
- Modify: `src/core/errors.ts`, `src/core/tools/paths.ts`, `src/core/tools/lock.ts`
- Test: `tests/core/paths.test.ts` (extend), `tests/core/lock.test.ts` (create), `tests/core/errors.test.ts` (extend)

**Interfaces:**
- Consumes: `BgtError`.
- Produces: `ErrorCode` gains `'LlmServerFailed' | 'LlmFailed'`; `ToolName` gains `'llama-server'` (bundled under `resources/llama`, recursive search); `LockEntry.merge?: boolean`; `lockedModelPath(id: string, lock: Lock, resources: string): string` (throws `ToolMissing` if the id is not in the lock or the file is missing).

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/errors.test.ts` inside the `describe('BgtError', ...)` block:
```ts
  it('supports the LLM error codes', () => {
    expect(new BgtError('LlmServerFailed', 'x').code).toBe('LlmServerFailed');
    expect(new BgtError('LlmFailed', 'x').name).toBe('LlmFailed');
  });
```

Append to `tests/core/paths.test.ts` inside `describe('resolveTool', ...)`:
```ts
  it('finds llama-server in a nested folder of the extracted archive', () => {
    const nested = touch('res', 'llama', 'build', exeName('llama-server'));
    expect(resolveTool('llama-server', { resourcesDir: path.join(root, 'res'), pathEnv: '' })).toBe(nested);
  });
```

Create `tests/core/lock.test.ts`:
```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockedModelPath, type Lock } from '../../src/core/tools/lock';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-lock-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lock: Lock = {
  platform: 'win32-x64',
  tools: [
    { id: 'model-translate', version: '1', url: 'u', sha256: 's', kind: 'file', dest: 'models/t.gguf' },
  ],
};

describe('lockedModelPath', () => {
  it('returns the resources path of a locked model that exists', () => {
    mkdirSync(path.join(root, 'models'), { recursive: true });
    writeFileSync(path.join(root, 'models', 't.gguf'), 'x');
    expect(lockedModelPath('model-translate', lock, root)).toBe(path.join(root, 'models', 't.gguf'));
  });

  it('throws ToolMissing for an unknown id or a missing file', () => {
    expect(() => lockedModelPath('nope', lock, root)).toThrow(expect.objectContaining({ code: 'ToolMissing' }));
    expect(() => lockedModelPath('model-translate', lock, root)).toThrow(
      expect.objectContaining({ code: 'ToolMissing', message: expect.stringContaining('setup:tools') }),
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/core/errors.test.ts tests/core/paths.test.ts tests/core/lock.test.ts`
Expected: FAIL (type/resolve errors, missing `lockedModelPath`).

- [ ] **Step 3: Implement**

In `src/core/errors.ts` extend the union:
```ts
export type ErrorCode =
  | 'ToolMissing'
  | 'DownloadFailed'
  | 'TranscribeFailed'
  | 'OverCap'
  | 'InvalidInput'
  | 'LlmServerFailed'
  | 'LlmFailed';
```

In `src/core/tools/paths.ts` change `ToolName`, `BUNDLED_DIR` and the bundled lookup:
```ts
export type ToolName = 'yt-dlp' | 'ffmpeg' | 'whisper-cli' | 'llama-server';
```
```ts
const BUNDLED_DIR: Record<ToolName, string> = {
  'yt-dlp': 'bin',
  ffmpeg: 'bin',
  'whisper-cli': 'whisper',
  'llama-server': 'llama',
};
```
and in `resolveTool` replace `name === 'whisper-cli'` with `name === 'whisper-cli' || name === 'llama-server'`.

Replace `src/core/tools/lock.ts` with:
```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../errors';

export interface LockEntry {
  id: string;
  version: string;
  url: string;
  sha256: string;
  kind: 'file' | 'zip';
  /** Path relative to the resources directory (a file for 'file', a folder for 'zip'). */
  dest: string;
  /** zip only: extract into `dest` without wiping what other archives put there. */
  merge?: boolean;
}

export interface Lock {
  platform: 'win32-x64';
  tools: LockEntry[];
}

export function loadLock(file: string): Lock {
  return JSON.parse(readFileSync(file, 'utf8')) as Lock;
}

export function lockedModelPath(id: string, lock: Lock, resources: string): string {
  const entry = lock.tools.find((t) => t.id === id);
  if (!entry) throw new BgtError('ToolMissing', `"${id}" is not listed in tools.lock.json. Run "pnpm pin:tools".`);
  const file = path.join(resources, entry.dest);
  if (!existsSync(file)) throw new BgtError('ToolMissing', `Model file ${file} is missing. Run "pnpm setup:tools".`);
  return file;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(core): LLM error codes, llama-server resolution, lock model lookup

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Merge-aware zip extraction

**Files:**
- Modify: `src/core/tools/fetch.ts`
- Test: `tests/core/fetch-zip.test.ts` (create)

**Interfaces:**
- Consumes: `LockEntry.merge` (Task 1), `fetchEntry`.
- Produces: zip entries with `merge: true` extract into `dest` without deleting existing content and use the marker file `.<id>.sha256`; entries without `merge` behave exactly as before (marker `.sha256`, destination wiped first).

- [ ] **Step 1: Write the failing test**

`tests/core/fetch-zip.test.ts`:
```ts
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchEntry } from '../../src/core/tools/fetch';
import type { LockEntry } from '../../src/core/tools/lock';

/** Minimal "stored" (uncompressed) zip writer, enough for extract-zip. */
function makeZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const zips: Record<string, Buffer> = {
  '/main.zip': makeZip([{ name: 'llama-server.exe', data: 'server' }]),
  '/cudart.zip': makeZip([{ name: 'cudart64.dll', data: 'dll' }]),
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let server: http.Server;
let base: string;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-zip-'));
  server = http.createServer((req, res) => {
    const body = zips[req.url ?? ''];
    if (!body) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-length', body.length);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const entry = (id: string, url: string, over: Partial<LockEntry> = {}): LockEntry => ({
  id,
  version: '1',
  url: `${base}${url}`,
  sha256: sha(zips[url]),
  kind: 'zip',
  dest: 'llama',
  ...over,
});

describe('fetchEntry zip merge', () => {
  it('extracts a zip and skips it when its marker matches', async () => {
    await fetchEntry(entry('main', '/main.zip'), dir, () => {});
    expect(readFileSync(path.join(dir, 'llama', 'llama-server.exe'), 'utf8')).toBe('server');
    expect(existsSync(path.join(dir, 'llama', '.sha256'))).toBe(true);
  });

  it('merges a second archive into the same folder without wiping the first', async () => {
    await fetchEntry(entry('main', '/main.zip', { merge: true }), dir, () => {});
    await fetchEntry(entry('cudart', '/cudart.zip', { merge: true }), dir, () => {});
    expect(existsSync(path.join(dir, 'llama', 'llama-server.exe'))).toBe(true);
    expect(existsSync(path.join(dir, 'llama', 'cudart64.dll'))).toBe(true);
    expect(existsSync(path.join(dir, 'llama', '.cudart.sha256'))).toBe(true);
  });

  it('a non-merge zip still replaces the destination', async () => {
    await fetchEntry(entry('main', '/main.zip', { merge: true }), dir, () => {});
    await fetchEntry(entry('cudart', '/cudart.zip'), dir, () => {});
    expect(existsSync(path.join(dir, 'llama', 'llama-server.exe'))).toBe(false);
    expect(existsSync(path.join(dir, 'llama', 'cudart64.dll'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/fetch-zip.test.ts`
Expected: FAIL: the merge test fails because the first archive is wiped (and the `.cudart.sha256` marker does not exist).

- [ ] **Step 3: Implement**

In `src/core/tools/fetch.ts`, replace the zip half of `fetchEntry` (from `const marker = ...` to the end of the function) with:
```ts
  const marker = path.join(dest, entry.merge ? `.${entry.id}.sha256` : '.sha256');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === entry.sha256) {
    log(`${entry.id}: up to date`);
    return;
  }
  log(`${entry.id}: downloading ${entry.version}`);
  const zip = path.join(resources, `${entry.id}.zip`);
  await downloadFile(entry.url, zip, onProgress);
  await verified(zip, entry);
  if (!entry.merge) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  await extract(zip, { dir: path.resolve(dest) });
  writeFileSync(marker, entry.sha256);
  rmSync(zip, { force: true });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS (including the Milestone 1 fetch tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/fetch.ts tests/core/fetch-zip.test.ts
git commit -m "feat(tools): merge-aware zip extraction for split archives

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Database migration 2 and StageRepo

**Files:**
- Modify: `src/core/db/schema.ts`, `src/core/db/repo.ts`, `tests/core/repo.test.ts`
- Create: `src/core/db/stage-repo.ts`
- Test: `tests/core/repo.test.ts` (extend), `tests/core/stage-repo.test.ts` (create)

**Interfaces:**
- Consumes: `Repo`, `Segment`.
- Produces:
  - `Repo.listSegmentsWithId(jobId: number): (Segment & { id: number })[]` (ordered by `start_ms, id`).
  - `completeChunk` also deletes translations of the segments it replaces, and deletes translations of the later-chunk segments it trims.
  - `type GlossarySource = 'auto' | 'user'`, `interface GlossaryEntry { ja: string; en: string; source: GlossarySource }`
  - `type StageName = 'glossary' | 'translate' | 'summarize'`, `type StageStatus = 'pending' | 'running' | 'done' | 'failed'`
  - `type SummaryLevel = 'window' | 'section' | 'overview'`, `interface SummaryRow { level: SummaryLevel; idx: number; startMs: number; endMs: number; text: string }`
  - `class StageRepo(db)`: `upsertGlossary(jobId, entries: GlossaryEntry[])` (a `user` entry overwrites any entry; an `auto` entry never overwrites an existing one), `listGlossary(jobId): GlossaryEntry[]`, `saveTranslations(jobId, batchIdx: number, items: { segmentId: number; text: string }[])`, `listTranslations(jobId): Map<number, string>`, `saveSummary(jobId, row: SummaryRow)`, `listSummaries(jobId, level?: SummaryLevel): SummaryRow[]` (ordered level window, section, overview then idx), `setStage(jobId, stage, status)`, `getStage(jobId, stage): StageStatus | undefined`.

- [ ] **Step 1: Write the failing tests**

In `tests/core/repo.test.ts` change the migrate test to expect version 2:
```ts
    expect(db.pragma('user_version', { simple: true })).toBe(2);
```
and append to the `describe('segments', ...)` block:
```ts
  it('listSegmentsWithId returns ids in time order', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [{ idx: 0, startMs: 0, endMs: 1000 }]);
    repo.completeChunk(job.id, 0, [seg('b', 500, 600), seg('a', 100, 200)]);
    const rows = repo.listSegmentsWithId(job.id);
    expect(rows.map((r) => r.text)).toEqual(['a', 'b']);
    expect(rows.every((r) => Number.isInteger(r.id))).toBe(true);
  });
```

Create `tests/core/stage-repo.test.ts`:
```ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../../src/core/db/repo';
import { migrate } from '../../src/core/db/schema';
import { StageRepo } from '../../src/core/db/stage-repo';
import type { Segment } from '../../src/core/types';

const seg = (text: string, startMs: number, endMs: number): Segment => ({ startMs, endMs, text, lang: 'ja' });
const settings = { model: 'large-v3', language: 'ja', maxMinutes: 30 };

let repo: Repo;
let stages: StageRepo;
let jobId: number;
beforeEach(() => {
  const db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  stages = new StageRepo(db);
  jobId = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 10_000, settings }).id;
  repo.insertChunks(jobId, [
    { idx: 0, startMs: 0, endMs: 5000 },
    { idx: 1, startMs: 4000, endMs: 10_000 },
  ]);
});

describe('glossary', () => {
  it('auto entries never overwrite; user entries always win', () => {
    stages.upsertGlossary(jobId, [{ ja: 'ゆりまる', en: 'Yurimaru', source: 'auto' }]);
    stages.upsertGlossary(jobId, [{ ja: 'ゆりまる', en: 'Yuri-maru', source: 'auto' }]);
    expect(stages.listGlossary(jobId)).toEqual([{ ja: 'ゆりまる', en: 'Yurimaru', source: 'auto' }]);
    stages.upsertGlossary(jobId, [{ ja: 'ゆりまる', en: 'Yurimaru-chan', source: 'user' }]);
    stages.upsertGlossary(jobId, [{ ja: 'ゆりまる', en: 'again', source: 'auto' }]);
    expect(stages.listGlossary(jobId)).toEqual([{ ja: 'ゆりまる', en: 'Yurimaru-chan', source: 'user' }]);
  });
});

describe('translations', () => {
  it('saves, replaces and lists by segment id', () => {
    repo.completeChunk(jobId, 0, [seg('a', 0, 1000), seg('b', 1000, 2000)]);
    const [a, b] = repo.listSegmentsWithId(jobId);
    stages.saveTranslations(jobId, 0, [{ segmentId: a.id, text: 'A' }, { segmentId: b.id, text: 'B' }]);
    stages.saveTranslations(jobId, 1, [{ segmentId: b.id, text: 'B2' }]);
    expect(stages.listTranslations(jobId)).toEqual(new Map([[a.id, 'A'], [b.id, 'B2']]));
  });

  it('are dropped when their chunk is re-transcribed', () => {
    repo.completeChunk(jobId, 0, [seg('a', 0, 1000)]);
    const [a] = repo.listSegmentsWithId(jobId);
    stages.saveTranslations(jobId, 0, [{ segmentId: a.id, text: 'A' }]);
    repo.completeChunk(jobId, 0, [seg('a2', 0, 1000)]);
    expect(stages.listTranslations(jobId).size).toBe(0);
  });

  it('are dropped for later-chunk segments trimmed as overlap by an earlier chunk', () => {
    repo.completeChunk(jobId, 1, [seg('dup', 4200, 4800), seg('keep', 6000, 7000)]);
    const [dup, keep] = repo.listSegmentsWithId(jobId);
    stages.saveTranslations(jobId, 0, [
      { segmentId: dup.id, text: 'DUP' },
      { segmentId: keep.id, text: 'KEEP' },
    ]);
    repo.completeChunk(jobId, 0, [seg('first', 0, 5000)]);
    expect(repo.listSegments(jobId).map((s) => s.text)).toEqual(['first', 'keep']);
    expect([...stages.listTranslations(jobId).values()]).toEqual(['KEEP']);
  });
});

describe('summaries and stages', () => {
  it('lists summaries ordered by level then index and replaces on re-save', () => {
    stages.saveSummary(jobId, { level: 'overview', idx: 0, startMs: 0, endMs: 9, text: 'O' });
    stages.saveSummary(jobId, { level: 'window', idx: 1, startMs: 5, endMs: 9, text: 'W1' });
    stages.saveSummary(jobId, { level: 'window', idx: 0, startMs: 0, endMs: 5, text: 'W0' });
    stages.saveSummary(jobId, { level: 'window', idx: 0, startMs: 0, endMs: 5, text: 'W0b' });
    expect(stages.listSummaries(jobId).map((s) => s.text)).toEqual(['W0b', 'W1', 'O']);
    expect(stages.listSummaries(jobId, 'overview')).toHaveLength(1);
  });

  it('tracks stage status', () => {
    expect(stages.getStage(jobId, 'translate')).toBeUndefined();
    stages.setStage(jobId, 'translate', 'running');
    stages.setStage(jobId, 'translate', 'done');
    expect(stages.getStage(jobId, 'translate')).toBe('done');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/core/repo.test.ts tests/core/stage-repo.test.ts`
Expected: FAIL (user_version is 1; modules missing).

- [ ] **Step 3: Implement**

In `src/core/db/schema.ts` append a second migration string to `MIGRATIONS`:
```ts
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
```

In `src/core/db/repo.ts` add the method (next to `listSegments`):
```ts
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
```
and rewrite the transaction body of `completeChunk` so translations are removed together with their segments:
```ts
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
```
(The existing statements in that method stay; this block replaces the whole transaction callback.)

Create `src/core/db/stage-repo.ts`:
```ts
import type Database from 'better-sqlite3';

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
  constructor(private readonly db: Database.Database) {}

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
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS (all Milestone 1 repo tests included).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(db): migration 2 and StageRepo for glossary, translations, summaries, stages

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reply parsers

**Files:**
- Create: `src/core/llm/parse.ts`
- Test: `tests/core/llm-parse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `stripThinking(text: string): string` (removes `<think>...</think>` blocks, and everything before a lone `</think>`, then trims)
  - `parseNumberedLines(reply: string, expected: number): string[] | null` (lines `[n] text`, continuation lines join the previous entry; returns exactly `expected` strings in order, or `null` on any count/numbering mismatch or duplicate number)
  - `interface GlossaryItem { ja: string; en: string }`, `parseGlossaryJson(reply: string): GlossaryItem[]` (accepts an array of `{ja, en}` or an object map; tolerates fences/prose/think blocks; drops empty, over-long (`ja` > 30 or `en` > 80 chars) or identical pairs; dedupes by `ja`; returns `[]` on anything unparseable)

- [ ] **Step 1: Write the failing tests**

`tests/core/llm-parse.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseGlossaryJson, parseNumberedLines, stripThinking } from '../../src/core/llm/parse';

describe('stripThinking', () => {
  it('removes think blocks and an orphan closing tag', () => {
    expect(stripThinking('<think>hmm\nmore</think>\nAnswer')).toBe('Answer');
    expect(stripThinking('reasoning here</think>Answer')).toBe('Answer');
    expect(stripThinking('  plain  ')).toBe('plain');
  });
});

describe('parseNumberedLines', () => {
  it('parses one line per number', () => {
    expect(parseNumberedLines('[1] Hello\n[2] World', 2)).toEqual(['Hello', 'World']);
  });

  it('ignores think blocks and code fences', () => {
    const reply = '<think>x</think>\n```\n[1] A\n[2] B\n```';
    expect(parseNumberedLines(reply, 2)).toEqual(['A', 'B']);
  });

  it('joins continuation lines to the previous entry', () => {
    expect(parseNumberedLines('[1] First part\nsecond part\n[2] Next', 2)).toEqual([
      'First part second part',
      'Next',
    ]);
  });

  it('allows an empty translation for a number', () => {
    expect(parseNumberedLines('[1] \n[2] B', 2)).toEqual(['', 'B']);
  });

  it.each([
    ['missing a line', '[1] A', 2],
    ['an extra line', '[1] A\n[2] B\n[3] C', 2],
    ['a gap in numbering', '[1] A\n[3] C', 2],
    ['a duplicated number', '[1] A\n[1] B', 2],
    ['no markers at all', 'Just a sentence.', 1],
  ])('returns null for %s', (_name, reply, expected) => {
    expect(parseNumberedLines(reply, expected)).toBeNull();
  });
});

describe('parseGlossaryJson', () => {
  it('reads an array of pairs, even inside fences and prose', () => {
    const reply = 'Here you go:\n```json\n[{"ja":"ゆりまる","en":"Yurimaru"},{"ja":"道の駅","en":"roadside station"}]\n```';
    expect(parseGlossaryJson(reply)).toEqual([
      { ja: 'ゆりまる', en: 'Yurimaru' },
      { ja: '道の駅', en: 'roadside station' },
    ]);
  });

  it('reads an object map', () => {
    expect(parseGlossaryJson('{"運動会":"sports day"}')).toEqual([{ ja: '運動会', en: 'sports day' }]);
  });

  it('drops invalid entries and duplicates', () => {
    const reply = JSON.stringify([
      { ja: 'A', en: '' },
      { ja: '', en: 'x' },
      { ja: 'same', en: 'same' },
      { ja: 'x'.repeat(31), en: 'long' },
      { ja: 'ok', en: 'fine' },
      { ja: 'ok', en: 'again' },
      { ja: 5, en: 'num' },
    ]);
    expect(parseGlossaryJson(reply)).toEqual([{ ja: 'ok', en: 'fine' }]);
  });

  it('returns an empty list for unparseable replies', () => {
    expect(parseGlossaryJson('no json here')).toEqual([]);
    expect(parseGlossaryJson('[{"ja": "broken"')).toEqual([]);
    expect(parseGlossaryJson('<think>[1]</think>nothing')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/llm-parse.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement**

`src/core/llm/parse.ts`:
```ts
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}

function stripFences(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*```/.test(line))
    .join('\n');
}

export function parseNumberedLines(reply: string, expected: number): string[] | null {
  const text = stripFences(stripThinking(reply));
  const found = new Map<number, string>();
  let current: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*\[(\d+)\]\s*(.*)$/.exec(raw);
    if (m) {
      current = Number(m[1]);
      if (found.has(current)) return null;
      found.set(current, m[2].trim());
    } else if (current !== null && raw.trim() !== '') {
      found.set(current, `${found.get(current)} ${raw.trim()}`.trim());
    }
  }
  if (found.size !== expected) return null;
  const out: string[] = [];
  for (let i = 1; i <= expected; i++) {
    const value = found.get(i);
    if (value === undefined) return null;
    out.push(value);
  }
  return out;
}

export interface GlossaryItem {
  ja: string;
  en: string;
}

export function parseGlossaryJson(reply: string): GlossaryItem[] {
  const text = stripFences(stripThinking(reply));
  const start = text.search(/[[{]/);
  if (start < 0) return [];
  const close = text[start] === '[' ? ']' : '}';
  const end = text.lastIndexOf(close);
  if (end < start) return [];

  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  const pairs: [unknown, unknown][] = Array.isArray(data)
    ? data.map((item) => [(item as { ja?: unknown })?.ja, (item as { en?: unknown })?.en])
    : data && typeof data === 'object'
      ? Object.entries(data as Record<string, unknown>)
      : [];

  const seen = new Set<string>();
  const out: GlossaryItem[] = [];
  for (const [rawJa, rawEn] of pairs) {
    if (typeof rawJa !== 'string' || typeof rawEn !== 'string') continue;
    const ja = rawJa.trim();
    const en = rawEn.trim();
    if (ja.length < 1 || ja.length > 30 || en.length < 1 || en.length > 80 || ja === en) continue;
    if (seen.has(ja)) continue;
    seen.add(ja);
    out.push({ ja, en });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/llm tests/core/llm-parse.test.ts
git commit -m "feat(llm): tolerant parsers for numbered translations and glossary JSON

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Prompt builders and summary windows

**Files:**
- Create: `src/core/llm/prompts.ts`, `src/core/llm/windows.ts`
- Test: `tests/core/llm-prompts.test.ts`, `tests/core/llm-windows.test.ts`

**Interfaces:**
- Consumes: `GlossaryEntry` (Task 3), `formatClock` (Milestone 1 `time.ts`).
- Produces:
  - `interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }` (defined in `prompts.ts`)
  - `relevantGlossary(glossary: GlossaryEntry[], lines: string[]): GlossaryEntry[]` (entries whose `ja` occurs in any line)
  - `translationMessages(a: { lines: string[]; glossary: GlossaryEntry[]; context: string[] }): ChatMessage[]`
  - `glossaryMessages(text: string): ChatMessage[]`
  - `windowSummaryMessages(a: { text: string; language: 'en' | 'ja'; glossary: GlossaryEntry[] }): ChatMessage[]`
  - `rollupMessages(a: { kind: 'section' | 'overview'; items: string }): ChatMessage[]`
  - `interface TextSegment { startMs: number; endMs: number; text: string }`, `interface SummaryWindow { idx: number; startMs: number; endMs: number; segments: TextSegment[] }`
  - `splitWindows(segments: TextSegment[], windowMs?: number): SummaryWindow[]` (default 300000; groups by `floor(startMs / windowMs)`, skips empty groups, renumbers `idx` from 0)
  - `renderWindow(w: SummaryWindow, offsetMs: number): string` (one `[h:mm:ss] text` line per segment, time = `startMs + offsetMs`)

- [ ] **Step 1: Write the failing tests**

`tests/core/llm-prompts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  glossaryMessages,
  relevantGlossary,
  rollupMessages,
  translationMessages,
  windowSummaryMessages,
} from '../../src/core/llm/prompts';
import type { GlossaryEntry } from '../../src/core/db/stage-repo';

const glossary: GlossaryEntry[] = [
  { ja: 'ゆりまる', en: 'Yurimaru', source: 'auto' },
  { ja: '運動会', en: 'sports day', source: 'user' },
];

describe('relevantGlossary', () => {
  it('keeps only entries that occur in the given lines', () => {
    expect(relevantGlossary(glossary, ['来週の運動会', 'はい'])).toEqual([glossary[1]]);
    expect(relevantGlossary(glossary, ['はい'])).toEqual([]);
  });
});

describe('translationMessages', () => {
  it('numbers the lines, lists only relevant terms, and includes context', () => {
    const [msg] = translationMessages({
      lines: ['ゆりまるです', '運動会があります'],
      glossary,
      context: ['Previous line.'],
    });
    expect(msg.role).toBe('user');
    expect(msg.content).toContain('ゆりまる translates to Yurimaru');
    expect(msg.content).toContain('運動会 translates to sports day');
    expect(msg.content).toContain('Previous line.');
    expect(msg.content).toContain('[1] ゆりまるです\n[2] 運動会があります');
    expect(msg.content).toMatch(/ONLY output the translated result/);
  });

  it('omits the terminology and context blocks when empty', () => {
    const [msg] = translationMessages({ lines: ['はい'], glossary, context: [] });
    expect(msg.content).not.toContain('translates to');
    expect(msg.content).not.toContain('For context');
  });
});

describe('other prompts', () => {
  it('glossary prompt asks for a JSON array and embeds the text', () => {
    const [msg] = glossaryMessages('こんにちは');
    expect(msg.content).toContain('JSON array');
    expect(msg.content).toContain('こんにちは');
  });

  it('window summary prompt states the source language and timestamp format', () => {
    const [en] = windowSummaryMessages({ text: '[0:00:01] hi', language: 'en', glossary: [] });
    expect(en.content).toContain('translated into English');
    expect(en.content).toContain('- [h:mm:ss]');
    const [ja] = windowSummaryMessages({ text: '[0:00:01] ゆりまるです', language: 'ja', glossary: glossary });
    expect(ja.content).toContain('in Japanese');
    expect(ja.content).toContain('ゆりまる = Yurimaru');
  });

  it('rollup prompts differ by kind', () => {
    expect(rollupMessages({ kind: 'section', items: 'x' })[0].content).toContain('Merge');
    expect(rollupMessages({ kind: 'overview', items: 'x' })[0].content).toContain('overview');
  });
});
```

`tests/core/llm-windows.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { renderWindow, splitWindows } from '../../src/core/llm/windows';

const s = (startMs: number, text: string) => ({ startMs, endMs: startMs + 1000, text });

describe('splitWindows', () => {
  it('groups by window, skips empty windows and renumbers', () => {
    const windows = splitWindows(
      [s(1000, 'a'), s(299_000, 'b'), s(300_000, 'c'), s(1_000_000, 'd')],
      300_000,
    );
    expect(windows.map((w) => w.segments.map((x) => x.text))).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(windows.map((w) => w.idx)).toEqual([0, 1, 2]);
    expect(windows[0]).toMatchObject({ startMs: 1000, endMs: 300_000 });
  });

  it('returns nothing for no segments', () => {
    expect(splitWindows([])).toEqual([]);
  });
});

describe('renderWindow', () => {
  it('prefixes each line with its absolute video time', () => {
    const [w] = splitWindows([s(1000, 'a'), s(65_000, 'b')]);
    expect(renderWindow(w, 3_600_000)).toBe('[1:00:01] a\n[1:01:05] b');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/core/llm-prompts.test.ts tests/core/llm-windows.test.ts`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

`src/core/llm/prompts.ts`:
```ts
import type { GlossaryEntry } from '../db/stage-repo';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function relevantGlossary(glossary: GlossaryEntry[], lines: string[]): GlossaryEntry[] {
  const haystack = lines.join('\n');
  return glossary.filter((g) => haystack.includes(g.ja));
}

export function translationMessages(a: {
  lines: string[];
  glossary: GlossaryEntry[];
  context: string[];
}): ChatMessage[] {
  const parts: string[] = [];
  const terms = relevantGlossary(a.glossary, a.lines);
  if (terms.length > 0) {
    parts.push(
      `Reference the following translations:\n${terms.map((t) => `${t.ja} translates to ${t.en}`).join('\n')}`,
    );
  }
  if (a.context.length > 0) {
    parts.push(
      `For context, the preceding subtitle lines were translated as follows (do not repeat them):\n${a.context.join('\n')}`,
    );
  }
  parts.push(
    'Translate the following Japanese subtitle lines into English. Note that you must ONLY output the translated result without any additional explanation. ' +
      'Output exactly one line per input line and keep each [n] marker unchanged at the start of its line:\n\n' +
      a.lines.map((line, i) => `[${i + 1}] ${line}`).join('\n'),
  );
  return [{ role: 'user', content: parts.join('\n\n') }];
}

export function glossaryMessages(text: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content:
        'Below is a transcript of a Japanese YouTube video or livestream. List the recurring proper nouns and terms that need a consistent English rendering: ' +
        'people and channel/handle names, game or place names, and distinctive slang. Use Hepburn romanization for personal names. ' +
        'Reply with ONLY a JSON array of objects like {"ja": "ゆりまる", "en": "Yurimaru"}, at most 25 items, no commentary.\n\nTranscript:\n' +
        text,
    },
  ];
}

export function windowSummaryMessages(a: {
  text: string;
  language: 'en' | 'ja';
  glossary: GlossaryEntry[];
}): ChatMessage[] {
  const source = a.language === 'en' ? 'translated into English' : 'in Japanese';
  const names = relevantGlossary(a.glossary, [a.text]);
  const nameBlock =
    names.length > 0 ? `\nUse these English names: ${names.map((g) => `${g.ja} = ${g.en}`).join('; ')}.` : '';
  return [
    {
      role: 'user',
      content:
        `Below is a stretch of a Japanese YouTube video or livestream, ${source}, one line per spoken segment with its timestamp. ` +
        `Write 2 to 4 bullet points in English summarizing what happens, so a viewer can decide whether to watch it. ` +
        `Start each bullet with "- [h:mm:ss] " using the timestamp of the moment it describes. Be concrete, no preamble.${nameBlock}\n\n${a.text}`,
    },
  ];
}

export function rollupMessages(a: { kind: 'section' | 'overview'; items: string }): ChatMessage[] {
  const instruction =
    a.kind === 'section'
      ? 'Merge the following bullet summaries into 3 to 5 bullets in the same format ("- [h:mm:ss] text"), keeping the timestamps. No preamble.'
      : 'Write a 2 to 4 sentence overview in English of the whole video from the following summaries. Output only the overview.';
  return [{ role: 'user', content: `${instruction}\n\n${a.items}` }];
}
```

`src/core/llm/windows.ts`:
```ts
import { formatClock } from '../time';

export interface TextSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SummaryWindow {
  idx: number;
  startMs: number;
  endMs: number;
  segments: TextSegment[];
}

export function splitWindows(segments: TextSegment[], windowMs = 300_000): SummaryWindow[] {
  const groups = new Map<number, TextSegment[]>();
  for (const seg of segments) {
    const key = Math.floor(seg.startMs / windowMs);
    const group = groups.get(key);
    if (group) group.push(seg);
    else groups.set(key, [seg]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, segs], idx) => ({
      idx,
      startMs: segs[0].startMs,
      endMs: segs.reduce((max, s) => Math.max(max, s.endMs), 0),
      segments: segs,
    }));
}

export function renderWindow(w: SummaryWindow, offsetMs: number): string {
  return w.segments.map((s) => `[${formatClock(s.startMs + offsetMs)}] ${s.text}`).join('\n');
}
```
Note: the first test expects `windows[0].endMs` to be 300_000, which is the max `endMs` of the group (`299_000 + 1000`).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/llm tests/core
git commit -m "feat(llm): prompt builders and summary windows

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: LlmClient and LlamaServer

**Files:**
- Create: `src/core/llm/client.ts`, `src/core/llm/llama-server.ts`, `tests/fixtures/fake-llama-server.mjs`
- Modify: `src/core/tools/process.ts` (export `killTree`)
- Test: `tests/core/llm-client.test.ts`, `tests/core/llama-server.test.ts`

**Interfaces:**
- Consumes: `BgtError`, `ChatMessage` (Task 5), `stripThinking` (Task 4), `killTree`.
- Produces:
  - `interface ChatOptions { temperature?: number; maxTokens?: number; signal?: AbortSignal }`
  - `interface LlmChat { chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> }`
  - `class LlmClient implements LlmChat` with `constructor(cfg: { baseUrl: string; model?: string; timeoutMs?: number; retries?: number; backoffMs?: number })`. POSTs `${baseUrl}/v1/chat/completions` with `chat_template_kwargs: { enable_thinking: false }`; retries network errors, timeouts, 5xx and 429 (default 2 retries); 4xx (except 429) fails immediately with `LlmFailed`; aborts reject with `signal.reason`; returns the message content passed through `stripThinking`.
  - `interface LlamaServerConfig { serverPath: string; modelPath: string; contextSize?: number; gpuLayers?: number; startupTimeoutMs?: number; argsPrefix?: string[] }`
  - `buildServerArgs(cfg: LlamaServerConfig, port: number): string[]`
  - `class LlamaServer { readonly baseUrl: string; static start(cfg, signal?): Promise<LlamaServer>; stop(): Promise<void> }` (`start` waits for `/health` 200, rejects `LlmServerFailed` with the process output tail if the child exits early or times out, kills the child on abort/failure).

- [ ] **Step 1: Write the failing tests**

`tests/fixtures/fake-llama-server.mjs`:
```js
import http from 'node:http';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);

if (process.env.FAKE_LLAMA_MODE === 'crash') {
  console.error('error: failed to load model');
  process.exit(1);
}

const readyAt = Date.now() + 400;
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = Date.now() < readyAt ? 503 : 200;
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(port, '127.0.0.1');
```

`tests/core/llm-client.test.ts`:
```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmClient } from '../../src/core/llm/client';

let server: http.Server;
let baseUrl: string;
let handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
let requests: { url: string; body: string }[];

beforeEach(async () => {
  requests = [];
  handler = (_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
  };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const client = (over = {}) => new LlmClient({ baseUrl, backoffMs: 1, ...over });
const messages = [{ role: 'user' as const, content: 'hi' }];

describe('LlmClient', () => {
  it('posts the chat request and returns the content', async () => {
    expect(await client().chat(messages, { temperature: 0.1, maxTokens: 50 })).toBe('hello');
    const sent = JSON.parse(requests[0].body);
    expect(requests[0].url).toBe('/v1/chat/completions');
    expect(sent).toMatchObject({
      messages,
      temperature: 0.1,
      max_tokens: 50,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('strips reasoning blocks from the reply', async () => {
    handler = (_r, _b, res) => res.end(JSON.stringify({ choices: [{ message: { content: '<think>x</think>Answer' } }] }));
    expect(await client().chat(messages)).toBe('Answer');
  });

  it('retries a 500 and then succeeds', async () => {
    let calls = 0;
    handler = (_r, _b, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    };
    expect(await client().chat(messages)).toBe('ok');
    expect(calls).toBe(2);
  });

  it('fails with LlmFailed after the retries are used up', async () => {
    handler = (_r, _b, res) => {
      res.statusCode = 503;
      res.end('nope');
    };
    await expect(client({ retries: 1 }).chat(messages)).rejects.toMatchObject({ code: 'LlmFailed' });
    expect(requests).toHaveLength(2);
  });

  it('does not retry a 400', async () => {
    handler = (_r, _b, res) => {
      res.statusCode = 400;
      res.end('bad request');
    };
    await expect(client().chat(messages)).rejects.toMatchObject({ code: 'LlmFailed' });
    expect(requests).toHaveLength(1);
  });

  it('rejects with the abort reason when aborted', async () => {
    handler = () => {
      /* never answers */
    };
    const controller = new AbortController();
    const pending = client({ timeoutMs: 10_000 }).chat(messages, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats a missing message content as a failure', async () => {
    handler = (_r, _b, res) => res.end(JSON.stringify({ choices: [] }));
    await expect(client({ retries: 0 }).chat(messages)).rejects.toMatchObject({ code: 'LlmFailed' });
  });
});
```

`tests/core/llama-server.test.ts`:
```ts
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServerArgs, LlamaServer, type LlamaServerConfig } from '../../src/core/llm/llama-server';

const fixture = path.resolve('tests/fixtures/fake-llama-server.mjs');
const cfg: LlamaServerConfig = {
  serverPath: process.execPath,
  argsPrefix: [fixture],
  modelPath: 'model.gguf',
  startupTimeoutMs: 15_000,
};

afterEach(() => {
  delete process.env.FAKE_LLAMA_MODE;
});

describe('buildServerArgs', () => {
  it('passes model, port, context and GPU layers', () => {
    const args = buildServerArgs({ ...cfg, argsPrefix: undefined, contextSize: 8192, gpuLayers: 40 }, 8123);
    expect(args).toEqual(['-m', 'model.gguf', '--host', '127.0.0.1', '--port', '8123', '-c', '8192', '-ngl', '40']);
  });
});

describe('LlamaServer', () => {
  it('waits until healthy, serves, and stops (port released)', async () => {
    const server = await LlamaServer.start(cfg);
    const ok = await fetch(`${server.baseUrl}/health`);
    expect(ok.status).toBe(200);
    await server.stop();
    await expect(fetch(`${server.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).rejects.toBeDefined();
  });

  it('reports the process output when the server dies during startup', async () => {
    process.env.FAKE_LLAMA_MODE = 'crash';
    await expect(LlamaServer.start(cfg)).rejects.toMatchObject({
      code: 'LlmServerFailed',
      message: expect.stringContaining('failed to load model'),
    });
  });

  it('times out when the server never becomes healthy', async () => {
    await expect(LlamaServer.start({ ...cfg, startupTimeoutMs: 100 })).rejects.toMatchObject({
      code: 'LlmServerFailed',
      message: expect.stringContaining('did not become ready'),
    });
  });

  it('kills the child and rejects when aborted during startup', async () => {
    const controller = new AbortController();
    const pending = LlamaServer.start(cfg, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/core/llm-client.test.ts tests/core/llama-server.test.ts`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

In `src/core/tools/process.ts` change `function killTree` to `export function killTree`.

`src/core/llm/client.ts`:
```ts
import { setTimeout as sleep } from 'node:timers/promises';
import { BgtError } from '../errors';
import { stripThinking } from './parse';
import type { ChatMessage } from './prompts';

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmChat {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

export interface LlmClientConfig {
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

export class LlmClient implements LlmChat {
  constructor(private readonly cfg: LlmClientConfig) {}

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const retries = this.cfg.retries ?? 2;
    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      opts.signal?.throwIfAborted();
      try {
        const signals = [AbortSignal.timeout(this.cfg.timeoutMs ?? 300_000)];
        if (opts.signal) signals.push(opts.signal);
        const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.cfg.model ?? 'local',
            messages,
            temperature: opts.temperature ?? 0.2,
            max_tokens: opts.maxTokens ?? 2048,
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.any(signals),
        });
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          const body = (await res.text()).slice(0, 300);
          throw new BgtError('LlmFailed', `The LLM server rejected the request (HTTP ${res.status}): ${body}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('the response had no message content');
        return stripThinking(content);
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (err instanceof BgtError) throw err;
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < retries) await sleep((this.cfg.backoffMs ?? 500) * (attempt + 1));
      }
    }
    throw new BgtError('LlmFailed', `The LLM request failed after ${retries + 1} attempts: ${lastError}`);
  }
}
```

`src/core/llm/llama-server.ts`:
```ts
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { BgtError } from '../errors';
import { killTree } from '../tools/process';

export interface LlamaServerConfig {
  serverPath: string;
  modelPath: string;
  contextSize?: number;
  gpuLayers?: number;
  startupTimeoutMs?: number;
  /** Arguments placed before the server flags (tests run a node script as the "server"). */
  argsPrefix?: string[];
}

export function buildServerArgs(cfg: LlamaServerConfig, port: number): string[] {
  return [
    ...(cfg.argsPrefix ?? []),
    '-m',
    cfg.modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-c',
    String(cfg.contextSize ?? 4096),
    '-ngl',
    String(cfg.gpuLayers ?? 99),
  ];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const tailLines = (text: string, n = 12) => text.trim().split(/\r?\n/).slice(-n).join('\n');

export class LlamaServer {
  private constructor(
    readonly baseUrl: string,
    private readonly child: ChildProcess,
  ) {}

  static async start(cfg: LlamaServerConfig, signal?: AbortSignal): Promise<LlamaServer> {
    const port = await freePort();
    const child = spawn(cfg.serverPath, buildServerArgs(cfg, port), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (d: string) => {
      output = (output + d).slice(-8000);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let exited = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    child.on('exit', () => (exited = true));
    child.on('error', (err: NodeJS.ErrnoException) => (spawnError = err));

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (cfg.startupTimeoutMs ?? 120_000);
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (spawnError) {
          throw new BgtError(
            spawnError.code === 'ENOENT' ? 'ToolMissing' : 'LlmServerFailed',
            `Cannot start llama-server at "${cfg.serverPath}": ${spawnError.message}`,
          );
        }
        if (exited) {
          throw new BgtError('LlmServerFailed', `llama-server exited during startup:\n${tailLines(output)}`);
        }
        if (Date.now() > deadline) {
          throw new BgtError(
            'LlmServerFailed',
            `llama-server did not become ready within ${(cfg.startupTimeoutMs ?? 120_000) / 1000}s:\n${tailLines(output)}`,
          );
        }
        try {
          const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
          if (res.ok) break;
        } catch {
          /* not listening yet */
        }
        await sleep(150);
      }
    } catch (err) {
      killTree(child);
      throw err;
    }
    return new LlamaServer(baseUrl, child);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => this.child.once('close', () => resolve()));
    killTree(this.child);
    await Promise.race([closed, sleep(5000)]);
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(llm): OpenAI-compatible client and managed llama-server process

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Hy-MT2 batch translator

**Files:**
- Create: `src/core/backends/translate/hymt.ts`, `tests/helpers/llm-fakes.ts`
- Test: `tests/core/hymt.test.ts`

**Interfaces:**
- Consumes: `LlmChat` (Task 6), `translationMessages` (Task 5), `parseNumberedLines` (Task 4), `GlossaryEntry` (Task 3), `Translator` and `Segment` (Milestone 1).
- Produces:
  - `interface BatchTranslator { translateBatch(lines: string[], glossary: GlossaryEntry[], context: string[], signal?: AbortSignal): Promise<string[]> }` (always returns `lines.length` strings; `''` for lines that could not be translated)
  - `class HyMtTranslator implements Translator, BatchTranslator` with `constructor(llm: LlmChat, opts?: { batchSize?: number; maxRetries?: number })` (defaults 25 and 2); `translate(segments, glossary: Record<string, string>)` returns new segments with translated `text`.
  - Test helpers in `tests/helpers/llm-fakes.ts`: `scriptedChat(handler: (messages: ChatMessage[], call: number) => string | Error): LlmChat & { calls: ChatMessage[][] }`, and `echoTranslate(prefix?: string): (messages: ChatMessage[]) => string` which answers `[n] <prefix><text>` for every `[n] text` line of the last message.

- [ ] **Step 1: Write the helpers and failing tests**

`tests/helpers/llm-fakes.ts`:
```ts
import type { ChatOptions, LlmChat } from '../../src/core/llm/client';
import type { ChatMessage } from '../../src/core/llm/prompts';

export type ScriptedChat = LlmChat & { calls: ChatMessage[][] };

export function scriptedChat(handler: (messages: ChatMessage[], call: number) => string | Error): ScriptedChat {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async chat(messages: ChatMessage[], opts?: ChatOptions) {
      opts?.signal?.throwIfAborted();
      calls.push(messages);
      const result = handler(messages, calls.length);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** Answers `[n] <prefix><text>` for each `[n] text` line in the last message. */
export function echoTranslate(prefix = 'EN:'): (messages: ChatMessage[]) => string {
  return (messages) => {
    const content = messages[messages.length - 1].content;
    const lines = [...content.matchAll(/^\[(\d+)\] (.*)$/gm)];
    return lines.map((m) => `[${m[1]}] ${prefix}${m[2]}`).join('\n');
  };
}
```

`tests/core/hymt.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { HyMtTranslator } from '../../src/core/backends/translate/hymt';
import { BgtError } from '../../src/core/errors';
import { echoTranslate, scriptedChat } from '../helpers/llm-fakes';

const lines = ['一行目', '二行目', '三行目'];

describe('HyMtTranslator.translateBatch', () => {
  it('returns one translation per line from a well-formed reply', async () => {
    const llm = scriptedChat(echoTranslate());
    const out = await new HyMtTranslator(llm).translateBatch(lines, [], []);
    expect(out).toEqual(['EN:一行目', 'EN:二行目', 'EN:三行目']);
    expect(llm.calls).toHaveLength(1);
  });

  it('retries a batch whose reply has the wrong number of lines', async () => {
    const llm = scriptedChat((m, call) => (call === 1 ? '[1] only one' : echoTranslate()(m)));
    const out = await new HyMtTranslator(llm).translateBatch(lines, [], []);
    expect(out).toEqual(['EN:一行目', 'EN:二行目', 'EN:三行目']);
    expect(llm.calls).toHaveLength(2);
  });

  it('falls back to line-by-line after the retries and never misaligns lines', async () => {
    const llm = scriptedChat((m) => {
      const content = m[m.length - 1].content;
      const numbered = [...content.matchAll(/^\[(\d+)\] /gm)].length;
      return numbered > 1 ? '[1] merged everything into one line' : echoTranslate()(m);
    });
    const out = await new HyMtTranslator(llm).translateBatch(lines, [], []);
    expect(out).toEqual(['EN:一行目', 'EN:二行目', 'EN:三行目']);
    expect(llm.calls).toHaveLength(3 + 3); // 1 + 2 retries, then one call per line
  });

  it('leaves a line empty when even the single-line request fails', async () => {
    const llm = scriptedChat((m) => {
      const content = m[m.length - 1].content;
      if ([...content.matchAll(/^\[(\d+)\] /gm)].length > 1) return 'garbage';
      if (content.includes('二行目')) return new BgtError('LlmFailed', 'down');
      return echoTranslate()(m);
    });
    const out = await new HyMtTranslator(llm).translateBatch(lines, [], []);
    expect(out).toEqual(['EN:一行目', '', 'EN:三行目']);
  });

  it('puts only relevant glossary terms and the context into the prompt', async () => {
    const llm = scriptedChat(echoTranslate());
    await new HyMtTranslator(llm).translateBatch(
      ['ゆりまるです'],
      [
        { ja: 'ゆりまる', en: 'Yurimaru', source: 'auto' },
        { ja: '運動会', en: 'sports day', source: 'auto' },
      ],
      ['Earlier line.'],
    );
    const prompt = llm.calls[0][0].content;
    expect(prompt).toContain('ゆりまる translates to Yurimaru');
    expect(prompt).not.toContain('運動会');
    expect(prompt).toContain('Earlier line.');
  });

  it('stops immediately when aborted instead of falling back', async () => {
    const controller = new AbortController();
    const llm = scriptedChat(() => {
      controller.abort();
      return 'garbage';
    });
    await expect(
      new HyMtTranslator(llm).translateBatch(lines, [], [], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(llm.calls).toHaveLength(1);
  });
});

describe('HyMtTranslator.translate (Translator interface)', () => {
  it('translates segments in batches, keeping timing and passing earlier output as context', async () => {
    const llm = scriptedChat(echoTranslate());
    const translator = new HyMtTranslator(llm, { batchSize: 2 });
    const segments = ['あ', 'い', 'う'].map((text, i) => ({
      startMs: i * 1000,
      endMs: i * 1000 + 500,
      text,
      lang: 'ja',
    }));
    const out = await translator.translate(segments, { あ: 'A' });
    expect(out.map((s) => [s.startMs, s.endMs, s.text])).toEqual([
      [0, 500, 'EN:あ'],
      [1000, 1500, 'EN:い'],
      [2000, 2500, 'EN:う'],
    ]);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1][0].content).toContain('EN:い');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/hymt.test.ts`
Expected: FAIL, cannot resolve `hymt`.

- [ ] **Step 3: Implement**

`src/core/backends/translate/hymt.ts`:
```ts
import type { GlossaryEntry } from '../../db/stage-repo';
import type { Translator } from '../../interfaces';
import { BgtError } from '../../errors';
import type { LlmChat } from '../../llm/client';
import { parseNumberedLines } from '../../llm/parse';
import { translationMessages } from '../../llm/prompts';
import type { Segment } from '../../types';

export interface BatchTranslator {
  /** Always returns `lines.length` strings; '' for a line that could not be translated. */
  translateBatch(
    lines: string[],
    glossary: GlossaryEntry[],
    context: string[],
    signal?: AbortSignal,
  ): Promise<string[]>;
}

export class HyMtTranslator implements Translator, BatchTranslator {
  private readonly batchSize: number;
  private readonly maxRetries: number;

  constructor(
    private readonly llm: LlmChat,
    opts: { batchSize?: number; maxRetries?: number } = {},
  ) {
    this.batchSize = opts.batchSize ?? 25;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  async translateBatch(
    lines: string[],
    glossary: GlossaryEntry[],
    context: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const reply = await this.llm.chat(translationMessages({ lines, glossary, context }), { signal });
        const parsed = parseNumberedLines(reply, lines.length);
        if (parsed) return parsed;
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (!(err instanceof BgtError)) throw err;
      }
      if (signal?.aborted) throw signal.reason;
    }

    // The model keeps breaking the numbering: translate each line on its own so lines never shift.
    const out: string[] = [];
    for (const line of lines) {
      signal?.throwIfAborted();
      try {
        const reply = await this.llm.chat(translationMessages({ lines: [line], glossary, context }), { signal });
        out.push(parseNumberedLines(reply, 1)?.[0] ?? '');
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (!(err instanceof BgtError)) throw err;
        out.push('');
      }
    }
    return out;
  }

  async translate(segments: Segment[], glossary: Record<string, string>): Promise<Segment[]> {
    const entries: GlossaryEntry[] = Object.entries(glossary).map(([ja, en]) => ({ ja, en, source: 'user' }));
    const out: Segment[] = [];
    for (let i = 0; i < segments.length; i += this.batchSize) {
      const batch = segments.slice(i, i + this.batchSize);
      const context = out.slice(-3).map((s) => s.text).filter((t) => t !== '');
      const translated = await this.translateBatch(
        batch.map((s) => s.text),
        entries,
        context,
      );
      batch.forEach((s, k) => out.push({ ...s, text: translated[k] ?? '' }));
    }
    return out;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(translate): Hy-MT2 batch translator with retry and line-by-line fallback

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Glossary and translate stages

**Files:**
- Create: `src/core/pipeline/glossary-job.ts`, `src/core/pipeline/translate-job.ts`
- Modify: `tests/helpers/fakes.ts` (add `memoryRepos`, `seedJob`)
- Test: `tests/core/glossary-job.test.ts`, `tests/core/translate-job.test.ts`

**Interfaces:**
- Consumes: `Repo`, `StageRepo`, `LlmChat`, `BatchTranslator`, `splitWindows`, `glossaryMessages`, `parseGlossaryJson`.
- Produces:
  - `runGlossaryStage(a: { repo: Repo; stages: StageRepo; llm: LlmChat; jobId: number; userGlossary: Record<string, string>; signal?: AbortSignal; log: (m: string) => void }): Promise<void>` (user entries are upserted on every call; the model pass is skipped when the stage is already `done`; a window whose request or parsing fails is logged and skipped)
  - `runTranslateStage(a: { repo: Repo; stages: StageRepo; translator: BatchTranslator; jobId: number; batchSize?: number; signal?: AbortSignal; log: (m: string) => void; onBatch?: () => void }): Promise<void>` (skips when `done`; translates only segments without a stored translation, in batches of `batchSize` (default 25), saving after each batch; context is the last 3 non-empty translations preceding the batch; abort rethrows and leaves the stage `running`)
  - Test helpers: `memoryRepos(): { repo: Repo; stages: StageRepo }`, `seedJob(repo: Repo, texts: string[], opts?: { stepMs?: number; rangeStartMs?: number }): JobRow` (one finished chunk with segments at `i * stepMs` (default 2000), 1500 ms long, lang `ja`; job status `done`).

- [ ] **Step 1: Add the helpers**

Append to `tests/helpers/fakes.ts`:
```ts
import { StageRepo } from '../../src/core/db/stage-repo';
import type { JobRow } from '../../src/core/db/repo';

export function memoryRepos(): { repo: Repo; stages: StageRepo } {
  const db = new Database(':memory:');
  migrate(db);
  return { repo: new Repo(db), stages: new StageRepo(db) };
}

export function seedJob(
  repo: Repo,
  texts: string[],
  opts: { stepMs?: number; rangeStartMs?: number } = {},
): JobRow {
  const step = opts.stepMs ?? 2000;
  const rangeStartMs = opts.rangeStartMs ?? 0;
  const job = repo.createJob({
    source: 'seed',
    rangeStartMs,
    rangeEndMs: rangeStartMs + Math.max(texts.length, 1) * step,
    settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 },
  });
  repo.insertChunks(job.id, [{ idx: 0, startMs: 0, endMs: Math.max(texts.length, 1) * step }]);
  repo.completeChunk(
    job.id,
    0,
    texts.map((text, i) => ({ startMs: i * step, endMs: i * step + 1500, text, lang: 'ja' })),
  );
  repo.setJobStatus(job.id, 'done');
  return repo.getJob(job.id) as JobRow;
}
```
(Merge the new imports into the existing import block at the top of the file rather than leaving them mid-file.)

- [ ] **Step 2: Write the failing tests**

`tests/core/glossary-job.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BgtError } from '../../src/core/errors';
import { runGlossaryStage } from '../../src/core/pipeline/glossary-job';
import { scriptedChat } from '../helpers/llm-fakes';
import { memoryRepos, seedJob } from '../helpers/fakes';

const base = (llm: ReturnType<typeof scriptedChat>) => {
  const { repo, stages } = memoryRepos();
  const job = seedJob(repo, ['ゆりまるです', '運動会の話']);
  return { repo, stages, job, llm, log: () => {} };
};

describe('runGlossaryStage', () => {
  it('merges model proposals; user entries override and are applied first', async () => {
    const llm = scriptedChat(() => '[{"ja":"ゆりまる","en":"Yurimaru"},{"ja":"運動会","en":"sports meet"}]');
    const ctx = base(llm);
    await runGlossaryStage({
      repo: ctx.repo,
      stages: ctx.stages,
      llm,
      jobId: ctx.job.id,
      userGlossary: { 運動会: 'sports day' },
      log: ctx.log,
    });
    const glossary = Object.fromEntries(ctx.stages.listGlossary(ctx.job.id).map((g) => [g.ja, g.en]));
    expect(glossary).toEqual({ ゆりまる: 'Yurimaru', 運動会: 'sports day' });
    expect(ctx.stages.getStage(ctx.job.id, 'glossary')).toBe('done');
  });

  it('skips a window whose reply is unusable and still finishes', async () => {
    const llm = scriptedChat(() => 'I cannot help with that.');
    const ctx = base(llm);
    await runGlossaryStage({ repo: ctx.repo, stages: ctx.stages, llm, jobId: ctx.job.id, userGlossary: {}, log: ctx.log });
    expect(ctx.stages.listGlossary(ctx.job.id)).toEqual([]);
    expect(ctx.stages.getStage(ctx.job.id, 'glossary')).toBe('done');
  });

  it('logs and continues when a request fails', async () => {
    const llm = scriptedChat(() => new BgtError('LlmFailed', 'down'));
    const ctx = base(llm);
    const logs: string[] = [];
    await runGlossaryStage({ repo: ctx.repo, stages: ctx.stages, llm, jobId: ctx.job.id, userGlossary: {}, log: (m) => logs.push(m) });
    expect(logs.join('\n')).toContain('down');
  });

  it('does not call the model again when already done, but still applies new user entries', async () => {
    const llm = scriptedChat(() => '[]');
    const ctx = base(llm);
    const args = { repo: ctx.repo, stages: ctx.stages, llm, jobId: ctx.job.id, log: ctx.log };
    await runGlossaryStage({ ...args, userGlossary: {} });
    await runGlossaryStage({ ...args, userGlossary: { 新: 'new' } });
    expect(llm.calls).toHaveLength(1);
    expect(ctx.stages.listGlossary(ctx.job.id)).toEqual([{ ja: '新', en: 'new', source: 'user' }]);
  });

  it('rethrows an abort', async () => {
    const controller = new AbortController();
    const llm = scriptedChat(() => {
      controller.abort();
      return '[]';
    });
    const ctx = base(llm);
    await expect(
      runGlossaryStage({ repo: ctx.repo, stages: ctx.stages, llm, jobId: ctx.job.id, userGlossary: {}, signal: controller.signal, log: ctx.log }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
```

`tests/core/translate-job.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { HyMtTranslator } from '../../src/core/backends/translate/hymt';
import { runTranslateStage } from '../../src/core/pipeline/translate-job';
import { echoTranslate, scriptedChat } from '../helpers/llm-fakes';
import { memoryRepos, seedJob } from '../helpers/fakes';

const texts = ['あ', 'い', 'う', 'え', 'お'];

describe('runTranslateStage', () => {
  it('translates every segment in batches and records the translations', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, texts);
    const llm = scriptedChat(echoTranslate());
    const batches: number[] = [];
    await runTranslateStage({
      repo,
      stages,
      translator: new HyMtTranslator(llm),
      jobId: job.id,
      batchSize: 2,
      log: () => {},
      onBatch: () => batches.push(stages.listTranslations(job.id).size),
    });
    const byText = repo.listSegmentsWithId(job.id).map((s) => stages.listTranslations(job.id).get(s.id));
    expect(byText).toEqual(['EN:あ', 'EN:い', 'EN:う', 'EN:え', 'EN:お']);
    expect(batches).toEqual([2, 4, 5]);
    expect(stages.getStage(job.id, 'translate')).toBe('done');
  });

  it('resumes after an abort without re-translating finished batches', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, texts);
    const controller = new AbortController();
    const first = scriptedChat((m, call) => {
      if (call === 2) {
        controller.abort();
        return 'ignored';
      }
      return echoTranslate()(m);
    });
    await expect(
      runTranslateStage({
        repo,
        stages,
        translator: new HyMtTranslator(first),
        jobId: job.id,
        batchSize: 2,
        signal: controller.signal,
        log: () => {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(stages.listTranslations(job.id).size).toBe(2);
    expect(stages.getStage(job.id, 'translate')).toBe('running');

    const second = scriptedChat(echoTranslate());
    await runTranslateStage({
      repo,
      stages,
      translator: new HyMtTranslator(second),
      jobId: job.id,
      batchSize: 2,
      log: () => {},
    });
    expect(second.calls).toHaveLength(2); // 3 remaining segments = 2 batches, not 3
    expect(stages.listTranslations(job.id).size).toBe(5);
    expect(second.calls[0][0].content).toContain('EN:い'); // context from the finished batch
  });

  it('stores empty strings for untranslatable lines, logs them, and still completes', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ']);
    const logs: string[] = [];
    await runTranslateStage({
      repo,
      stages,
      translator: { translateBatch: async (lines) => lines.map(() => '') },
      jobId: job.id,
      log: (m) => logs.push(m),
    });
    expect([...stages.listTranslations(job.id).values()]).toEqual(['']);
    expect(logs.join('\n')).toMatch(/1 line/);
    expect(stages.getStage(job.id, 'translate')).toBe('done');
  });

  it('does nothing for a job without segments', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, []);
    const llm = scriptedChat(echoTranslate());
    await runTranslateStage({ repo, stages, translator: new HyMtTranslator(llm), jobId: job.id, log: () => {} });
    expect(llm.calls).toHaveLength(0);
    expect(stages.getStage(job.id, 'translate')).toBe('done');
  });

  it('skips a stage that is already done', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, texts);
    stages.setStage(job.id, 'translate', 'done');
    const llm = scriptedChat(echoTranslate());
    await runTranslateStage({ repo, stages, translator: new HyMtTranslator(llm), jobId: job.id, log: () => {} });
    expect(llm.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm test tests/core/glossary-job.test.ts tests/core/translate-job.test.ts`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 4: Implement**

`src/core/pipeline/glossary-job.ts`:
```ts
import type { Repo } from '../db/repo';
import type { StageRepo } from '../db/stage-repo';
import type { LlmChat } from '../llm/client';
import { parseGlossaryJson } from '../llm/parse';
import { glossaryMessages } from '../llm/prompts';
import { splitWindows } from '../llm/windows';

export async function runGlossaryStage(a: {
  repo: Repo;
  stages: StageRepo;
  llm: LlmChat;
  jobId: number;
  userGlossary: Record<string, string>;
  signal?: AbortSignal;
  log: (message: string) => void;
}): Promise<void> {
  const { repo, stages, llm, jobId, signal, log } = a;
  // User entries always apply, even when the model pass already ran earlier.
  stages.upsertGlossary(
    jobId,
    Object.entries(a.userGlossary).map(([ja, en]) => ({ ja, en, source: 'user' as const })),
  );
  if (stages.getStage(jobId, 'glossary') === 'done') return;

  stages.setStage(jobId, 'glossary', 'running');
  const windows = splitWindows(repo.listSegments(jobId));
  for (const window of windows) {
    signal?.throwIfAborted();
    try {
      const reply = await llm.chat(glossaryMessages(window.segments.map((s) => s.text).join('\n')), {
        signal,
        maxTokens: 1024,
      });
      signal?.throwIfAborted(); // never persist work finished after an abort
      stages.upsertGlossary(
        jobId,
        parseGlossaryJson(reply).map((item) => ({ ...item, source: 'auto' as const })),
      );
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      log(`Glossary: skipped window ${window.idx + 1}/${windows.length}: ${err instanceof Error ? err.message : err}`);
    }
  }
  stages.setStage(jobId, 'glossary', 'done');
}
```

`src/core/pipeline/translate-job.ts`:
```ts
import type { BatchTranslator } from '../backends/translate/hymt';
import type { Repo } from '../db/repo';
import type { StageRepo } from '../db/stage-repo';

export async function runTranslateStage(a: {
  repo: Repo;
  stages: StageRepo;
  translator: BatchTranslator;
  jobId: number;
  batchSize?: number;
  signal?: AbortSignal;
  log: (message: string) => void;
  onBatch?: () => void;
}): Promise<void> {
  const { repo, stages, translator, jobId, signal, log } = a;
  if (stages.getStage(jobId, 'translate') === 'done') return;
  stages.setStage(jobId, 'translate', 'running');

  const batchSize = a.batchSize ?? 25;
  const segments = repo.listSegmentsWithId(jobId);
  const translated = stages.listTranslations(jobId);
  const glossary = stages.listGlossary(jobId);
  const pending = segments.filter((s) => !translated.has(s.id));
  const totalBatches = Math.ceil(pending.length / batchSize);

  for (let i = 0, batchIdx = 0; i < pending.length; i += batchSize, batchIdx++) {
    signal?.throwIfAborted();
    const batch = pending.slice(i, i + batchSize);
    const first = segments.findIndex((s) => s.id === batch[0].id);
    const context = segments
      .slice(Math.max(0, first - 3), first)
      .map((s) => translated.get(s.id) ?? '')
      .filter((t) => t !== '');

    log(`Translating batch ${batchIdx + 1}/${totalBatches} (${batch.length} lines)`);
    const out = await translator.translateBatch(
      batch.map((s) => s.text),
      glossary,
      context,
      signal,
    );
    const items = batch.map((s, k) => ({ segmentId: s.id, text: out[k] ?? '' }));
    stages.saveTranslations(jobId, batchIdx, items);
    for (const item of items) translated.set(item.segmentId, item.text);
    const blank = items.filter((item) => item.text === '').length;
    if (blank > 0) log(`Translation: ${blank} line${blank === 1 ? '' : 's'} in this batch could not be translated and were left blank.`);
    a.onBatch?.();
  }
  stages.setStage(jobId, 'translate', 'done');
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "feat(pipeline): resumable glossary and translate stages

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Summarize stage

**Files:**
- Create: `src/core/pipeline/summarize-job.ts`
- Test: `tests/core/summarize-job.test.ts`

**Interfaces:**
- Consumes: `Repo`, `StageRepo`, `LlmChat`, `splitWindows`/`renderWindow`, `windowSummaryMessages`/`rollupMessages`.
- Produces: `runSummarizeStage(a: { repo: Repo; stages: StageRepo; llm: LlmChat; jobId: number; rangeStartMs: number; signal?: AbortSignal; log: (m: string) => void }): Promise<void>`. Text source: translation if non-empty else Japanese; summary language `'en'` when the `translate` stage is `done`, else `'ja'`. Saves `window` rows (absolute times, `idx` = window index), then `section` rows (groups of 6 windows) only when there are more than 12 windows, then one `overview` row (idx 0, spanning all windows) built from sections (if any) or windows. Existing rows are reused on resume. A window whose request fails is logged and skipped (it is simply missing from the summary); the overview is skipped when no window summaries exist. Stage ends `done`.

- [ ] **Step 1: Write the failing tests**

`tests/core/summarize-job.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BgtError } from '../../src/core/errors';
import { runSummarizeStage } from '../../src/core/pipeline/summarize-job';
import { scriptedChat } from '../helpers/llm-fakes';
import { memoryRepos, seedJob } from '../helpers/fakes';

// 3 segments per 5-minute window: stepMs 100_000 puts segments 0..2 in window 0, 3..5 in window 1, ...
const STEP = 100_000;
const kind = (content: string) =>
  content.includes('Merge the following') ? 'section' : content.includes('overview in English') ? 'overview' : 'window';
const answer = (m: { content: string }[]) => {
  const content = m[m.length - 1].content;
  return `${kind(content)} summary`;
};

const run = async (texts: string[], over: Partial<Parameters<typeof runSummarizeStage>[0]> = {}) => {
  const { repo, stages } = memoryRepos();
  const job = seedJob(repo, texts, { stepMs: STEP, rangeStartMs: 3_600_000 });
  const llm = scriptedChat(answer);
  await runSummarizeStage({ repo, stages, llm, jobId: job.id, rangeStartMs: job.rangeStartMs, log: () => {}, ...over });
  return { repo, stages, job, llm };
};

describe('runSummarizeStage', () => {
  it('writes window summaries with absolute times and an overview', async () => {
    const { stages, job, llm } = await run(['a', 'b', 'c', 'd', 'e', 'f']);
    const windows = stages.listSummaries(job.id, 'window');
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ idx: 0, startMs: 3_600_000, text: 'window summary' });
    expect(stages.listSummaries(job.id, 'section')).toHaveLength(0);
    expect(stages.listSummaries(job.id, 'overview')).toMatchObject([
      { idx: 0, startMs: 3_600_000, text: 'overview summary' },
    ]);
    expect(llm.calls).toHaveLength(3);
    expect(stages.getStage(job.id, 'summarize')).toBe('done');
  });

  it('adds a section level only above 12 windows', async () => {
    const texts = Array.from({ length: 13 * 3 }, (_, i) => `t${i}`);
    const { stages, job } = await run(texts);
    expect(stages.listSummaries(job.id, 'window')).toHaveLength(13);
    expect(stages.listSummaries(job.id, 'section')).toHaveLength(3); // 6 + 6 + 1
    expect(stages.listSummaries(job.id, 'overview')).toHaveLength(1);
  });

  it('summarizes the English translation when the translate stage is done, else the Japanese text', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['こんにちは']);
    const [seg] = repo.listSegmentsWithId(job.id);
    stages.saveTranslations(job.id, 0, [{ segmentId: seg.id, text: 'Hello there' }]);
    stages.setStage(job.id, 'translate', 'done');
    const llm = scriptedChat(answer);
    await runSummarizeStage({ repo, stages, llm, jobId: job.id, rangeStartMs: 0, log: () => {} });
    expect(llm.calls[0][0].content).toContain('translated into English');
    expect(llm.calls[0][0].content).toContain('Hello there');

    const other = memoryRepos();
    const job2 = seedJob(other.repo, ['こんにちは']);
    const llm2 = scriptedChat(answer);
    await runSummarizeStage({ repo: other.repo, stages: other.stages, llm: llm2, jobId: job2.id, rangeStartMs: 0, log: () => {} });
    expect(llm2.calls[0][0].content).toContain('in Japanese');
    expect(llm2.calls[0][0].content).toContain('こんにちは');
  });

  it('falls back to the Japanese text for a line whose translation is empty', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['こんにちは']);
    const [seg] = repo.listSegmentsWithId(job.id);
    stages.saveTranslations(job.id, 0, [{ segmentId: seg.id, text: '' }]);
    stages.setStage(job.id, 'translate', 'done');
    const llm = scriptedChat(answer);
    await runSummarizeStage({ repo, stages, llm, jobId: job.id, rangeStartMs: 0, log: () => {} });
    expect(llm.calls[0][0].content).toContain('こんにちは');
  });

  it('resumes: finished windows are not summarized again', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['a', 'b', 'c', 'd', 'e', 'f'], { stepMs: STEP });
    const controller = new AbortController();
    const first = scriptedChat((m, call) => {
      if (call === 2) {
        controller.abort();
        return 'x';
      }
      return answer(m);
    });
    await expect(
      runSummarizeStage({ repo, stages, llm: first, jobId: job.id, rangeStartMs: 0, signal: controller.signal, log: () => {} }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(stages.listSummaries(job.id, 'window')).toHaveLength(1);

    const second = scriptedChat(answer);
    await runSummarizeStage({ repo, stages, llm: second, jobId: job.id, rangeStartMs: 0, log: () => {} });
    expect(second.calls).toHaveLength(2); // window 1 + overview
    expect(stages.listSummaries(job.id, 'window')).toHaveLength(2);
  });

  it('skips a failed window, and does nothing for an empty job', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['a']);
    const logs: string[] = [];
    await runSummarizeStage({
      repo,
      stages,
      llm: scriptedChat(() => new BgtError('LlmFailed', 'down')),
      jobId: job.id,
      rangeStartMs: 0,
      log: (m) => logs.push(m),
    });
    expect(stages.listSummaries(job.id)).toEqual([]);
    expect(logs.join('\n')).toContain('down');

    const empty = memoryRepos();
    const job2 = seedJob(empty.repo, []);
    const llm = scriptedChat(answer);
    await runSummarizeStage({ repo: empty.repo, stages: empty.stages, llm, jobId: job2.id, rangeStartMs: 0, log: () => {} });
    expect(llm.calls).toHaveLength(0);
    expect(empty.stages.getStage(job2.id, 'summarize')).toBe('done');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/summarize-job.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement**

`src/core/pipeline/summarize-job.ts`:
```ts
import type { Repo } from '../db/repo';
import type { StageRepo, SummaryRow } from '../db/stage-repo';
import type { LlmChat } from '../llm/client';
import { rollupMessages, windowSummaryMessages } from '../llm/prompts';
import { renderWindow, splitWindows } from '../llm/windows';

const SECTION_THRESHOLD = 12;
const SECTION_SIZE = 6;

export async function runSummarizeStage(a: {
  repo: Repo;
  stages: StageRepo;
  llm: LlmChat;
  jobId: number;
  rangeStartMs: number;
  signal?: AbortSignal;
  log: (message: string) => void;
}): Promise<void> {
  const { repo, stages, llm, jobId, rangeStartMs, signal, log } = a;
  if (stages.getStage(jobId, 'summarize') === 'done') return;
  stages.setStage(jobId, 'summarize', 'running');

  const translations = stages.listTranslations(jobId);
  const language = stages.getStage(jobId, 'translate') === 'done' ? 'en' : 'ja';
  const glossary = stages.listGlossary(jobId);
  const segments = repo.listSegmentsWithId(jobId).map((s) => ({
    startMs: s.startMs,
    endMs: s.endMs,
    text: translations.get(s.id) || s.text,
  }));
  const windows = splitWindows(segments);

  const have = (level: SummaryRow['level']) => new Map(stages.listSummaries(jobId, level).map((r) => [r.idx, r]));
  const windowRows = have('window');

  for (const window of windows) {
    signal?.throwIfAborted();
    if (windowRows.has(window.idx)) continue;
    log(`Summarizing window ${window.idx + 1}/${windows.length}`);
    try {
      const text = await llm.chat(
        windowSummaryMessages({ text: renderWindow(window, rangeStartMs), language, glossary }),
        { signal, maxTokens: 600 },
      );
      signal?.throwIfAborted(); // never persist work finished after an abort
      const row: SummaryRow = {
        level: 'window',
        idx: window.idx,
        startMs: window.startMs + rangeStartMs,
        endMs: window.endMs + rangeStartMs,
        text,
      };
      stages.saveSummary(jobId, row);
      windowRows.set(window.idx, row);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      log(`Summary: skipped window ${window.idx + 1}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const windowList = [...windowRows.values()].sort((x, y) => x.idx - y.idx);
  let rollupSource = windowList;

  if (windows.length > SECTION_THRESHOLD) {
    const sectionRows = have('section');
    for (let g = 0; g * SECTION_SIZE < windowList.length; g++) {
      signal?.throwIfAborted();
      const group = windowList.slice(g * SECTION_SIZE, (g + 1) * SECTION_SIZE);
      if (!sectionRows.has(g)) {
        try {
          const text = await llm.chat(rollupMessages({ kind: 'section', items: group.map((r) => r.text).join('\n') }), {
            signal,
            maxTokens: 600,
          });
          signal?.throwIfAborted();
          sectionRows.set(g, {
            level: 'section',
            idx: g,
            startMs: group[0].startMs,
            endMs: group[group.length - 1].endMs,
            text,
          });
          stages.saveSummary(jobId, sectionRows.get(g) as SummaryRow);
        } catch (err) {
          if (signal?.aborted) throw signal.reason;
          log(`Summary: skipped section ${g + 1}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    rollupSource = [...sectionRows.values()].sort((x, y) => x.idx - y.idx);
  }

  if (rollupSource.length > 0 && !have('overview').has(0)) {
    signal?.throwIfAborted();
    try {
      const text = await llm.chat(rollupMessages({ kind: 'overview', items: rollupSource.map((r) => r.text).join('\n') }), {
        signal,
        maxTokens: 400,
      });
      signal?.throwIfAborted();
      stages.saveSummary(jobId, {
        level: 'overview',
        idx: 0,
        startMs: windowList[0].startMs,
        endMs: windowList[windowList.length - 1].endMs,
        text,
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      log(`Summary: could not write the overview: ${err instanceof Error ? err.message : err}`);
    }
  }
  stages.setStage(jobId, 'summarize', 'done');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(pipeline): hierarchical resumable summarize stage

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Output writers

**Files:**
- Create: `src/core/subtitles/bilingual.ts`, `src/core/subtitles/summary-md.ts`, `src/core/pipeline/llm-outputs.ts`
- Test: `tests/core/llm-outputs.test.ts`

**Interfaces:**
- Consumes: `toSrt`, `Repo`, `StageRepo`, `JobRow`, `SummaryRow`, `formatClock`.
- Produces:
  - `toBilingualSrt(rows: { startMs: number; endMs: number; en: string; ja: string }[]): string` (cue text is `en` then `ja` on the next line; just `ja` when `en` is empty)
  - `toSummaryMarkdown(rows: SummaryRow[]): string` (`# Summary`, `## Overview`, then `## Sections` if any, then `## Timeline`; each block headed `### h:mm:ss to h:mm:ss`; empty string for no rows)
  - `writeLlmOutputs(repo: Repo, stages: StageRepo, job: JobRow, outDir: string): string[]` (returns the paths written; `job-N.en.srt` and `job-N.bi.srt` only when at least one translation exists, with `en.srt` skipping empty translations; `job-N.summary.md` only when summaries exist; times add `job.rangeStartMs` to segments, summaries are already absolute)

- [ ] **Step 1: Write the failing tests**

`tests/core/llm-outputs.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLlmOutputs } from '../../src/core/pipeline/llm-outputs';
import { toBilingualSrt } from '../../src/core/subtitles/bilingual';
import { toSummaryMarkdown } from '../../src/core/subtitles/summary-md';
import { memoryRepos, seedJob } from '../helpers/fakes';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-llmout-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('toBilingualSrt', () => {
  it('puts English first, Japanese second, and falls back to Japanese alone', () => {
    const out = toBilingualSrt([
      { startMs: 0, endMs: 1000, en: 'Hello', ja: 'こんにちは' },
      { startMs: 1000, endMs: 2000, en: '', ja: 'えっと' },
    ]);
    expect(out).toBe(
      '1\n00:00:00,000 --> 00:00:01,000\nHello\nこんにちは\n\n2\n00:00:01,000 --> 00:00:02,000\nえっと\n',
    );
  });
});

describe('toSummaryMarkdown', () => {
  it('renders overview, optional sections, then the timeline', () => {
    const md = toSummaryMarkdown([
      { level: 'window', idx: 0, startMs: 3_600_000, endMs: 3_900_000, text: '- [1:00:05] Intro' },
      { level: 'overview', idx: 0, startMs: 3_600_000, endMs: 3_900_000, text: 'A short stream.' },
    ]);
    expect(md).toContain('# Summary');
    expect(md).toContain('## Overview\n\nA short stream.');
    expect(md).not.toContain('## Sections');
    expect(md).toContain('## Timeline\n\n### 1:00:00 to 1:05:00\n\n- [1:00:05] Intro');
    expect(toSummaryMarkdown([])).toBe('');
  });
});

describe('writeLlmOutputs', () => {
  it('writes nothing when there are no translations or summaries', () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ']);
    expect(writeLlmOutputs(repo, stages, job, dir)).toEqual([]);
  });

  it('writes en/bi SRTs with the range offset and the summary file', () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い'], { rangeStartMs: 60_000 });
    const [a, b] = repo.listSegmentsWithId(job.id);
    stages.saveTranslations(job.id, 0, [{ segmentId: a.id, text: 'A' }, { segmentId: b.id, text: '' }]);
    stages.saveSummary(job.id, { level: 'overview', idx: 0, startMs: 60_000, endMs: 64_000, text: 'Overview' });

    const written = writeLlmOutputs(repo, stages, job, dir);
    expect(written.map((p) => path.basename(p)).sort()).toEqual([
      `job-${job.id}.bi.srt`,
      `job-${job.id}.en.srt`,
      `job-${job.id}.summary.md`,
    ]);
    const en = readFileSync(path.join(dir, `job-${job.id}.en.srt`), 'utf8');
    expect(en).toBe('1\n00:01:00,000 --> 00:01:01,500\nA\n'); // the empty translation is skipped
    const bi = readFileSync(path.join(dir, `job-${job.id}.bi.srt`), 'utf8');
    expect(bi).toContain('00:01:00,000 --> 00:01:01,500\nA\nあ');
    expect(bi).toContain('00:01:02,000 --> 00:01:03,500\nい');
    expect(existsSync(path.join(dir, `job-${job.id}.summary.md`))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/llm-outputs.test.ts`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

`src/core/subtitles/bilingual.ts`:
```ts
import { toSrt } from './srt';

export function toBilingualSrt(
  rows: { startMs: number; endMs: number; en: string; ja: string }[],
): string {
  return toSrt(
    rows.map((r) => ({
      startMs: r.startMs,
      endMs: r.endMs,
      text: r.en.trim() === '' ? r.ja : `${r.en.trim()}\n${r.ja}`,
    })),
  );
}
```

`src/core/subtitles/summary-md.ts`:
```ts
import type { SummaryRow } from '../db/stage-repo';
import { formatClock } from '../time';

const heading = (r: SummaryRow) => `### ${formatClock(r.startMs)} to ${formatClock(r.endMs)}`;

export function toSummaryMarkdown(rows: SummaryRow[]): string {
  if (rows.length === 0) return '';
  const of = (level: SummaryRow['level']) => rows.filter((r) => r.level === level).sort((a, b) => a.idx - b.idx);
  const parts = ['# Summary'];
  const overview = of('overview')[0];
  if (overview) parts.push(`## Overview\n\n${overview.text.trim()}`);
  const sections = of('section');
  if (sections.length > 0) {
    parts.push(`## Sections\n\n${sections.map((r) => `${heading(r)}\n\n${r.text.trim()}`).join('\n\n')}`);
  }
  const windows = of('window');
  if (windows.length > 0) {
    parts.push(`## Timeline\n\n${windows.map((r) => `${heading(r)}\n\n${r.text.trim()}`).join('\n\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}
```

`src/core/pipeline/llm-outputs.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JobRow, Repo } from '../db/repo';
import type { StageRepo } from '../db/stage-repo';
import { toBilingualSrt } from '../subtitles/bilingual';
import { toSrt } from '../subtitles/srt';
import { toSummaryMarkdown } from '../subtitles/summary-md';

/** Writes whichever of `.en.srt`, `.bi.srt` and `.summary.md` have content. Returns the paths written. */
export function writeLlmOutputs(repo: Repo, stages: StageRepo, job: JobRow, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `job-${job.id}`);
  const written: string[] = [];

  const translations = stages.listTranslations(job.id);
  if (translations.size > 0) {
    const rows = repo.listSegmentsWithId(job.id).map((s) => ({
      startMs: s.startMs + job.rangeStartMs,
      endMs: s.endMs + job.rangeStartMs,
      en: translations.get(s.id) ?? '',
      ja: s.text,
    }));
    writeFileSync(`${base}.en.srt`, toSrt(rows.filter((r) => r.en.trim() !== '').map((r) => ({ ...r, text: r.en }))));
    writeFileSync(`${base}.bi.srt`, toBilingualSrt(rows));
    written.push(`${base}.en.srt`, `${base}.bi.srt`);
  }

  const summaries = stages.listSummaries(job.id);
  if (summaries.length > 0) {
    writeFileSync(`${base}.summary.md`, toSummaryMarkdown(summaries));
    written.push(`${base}.summary.md`);
  }
  return written;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(subtitles): English, bilingual and summary output writers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Stage orchestrator with model pool

**Files:**
- Create: `src/core/pipeline/stages.ts`
- Test: `tests/core/stages.test.ts`

**Interfaces:**
- Consumes: all stage runners (Tasks 8, 9), `HyMtTranslator`, `writeLlmOutputs`, `LlmChat`, `JobRow`, `Repo`, `StageRepo`.
- Produces:
  - `type ModelRole = 'general' | 'translate'`
  - `interface ModelPool { use(role: ModelRole, signal?: AbortSignal): Promise<LlmChat>; stopAll(): Promise<void> }` (`use` of a different role must stop the current model before starting the next)
  - `interface StageOptions { translate: boolean; summarize: boolean; skim: boolean; userGlossary: Record<string, string>; batchSize?: number }`
  - `runLlmStages(ctx: { repo: Repo; stages: StageRepo; job: JobRow; outDir: string; pool: ModelPool; log: (m: string) => void; signal?: AbortSignal }, opts: StageOptions): Promise<string[]>` (returns written output paths). Order: glossary (when `translate` or `skim`) on `general`, translate (when `translate`) on `translate`, summarize (when `summarize` or `skim`) on `general`. A job with no segments returns without using the pool. `pool.stopAll()` always runs. A stage that throws is marked `failed` (aborts leave `running`) and the error is rethrown. Outputs are written after every translated batch and at the end.

- [ ] **Step 1: Write the failing tests**

`tests/core/stages.test.ts`:
```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmChat } from '../../src/core/llm/client';
import { runLlmStages, type ModelPool, type ModelRole } from '../../src/core/pipeline/stages';
import { echoTranslate, scriptedChat } from '../helpers/llm-fakes';
import { memoryRepos, seedJob } from '../helpers/fakes';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-stages-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Fake model pool that mirrors the real pool's start/stop behaviour. */
function fakePool(chats: Record<ModelRole, LlmChat>) {
  const started: ModelRole[] = [];
  const pool: ModelPool & { started: ModelRole[]; stopped: number; uses: ModelRole[] } = {
    started,
    stopped: 0,
    uses: [],
    async use(role) {
      pool.uses.push(role);
      if (started[started.length - 1] !== role) started.push(role);
      return chats[role];
    },
    async stopAll() {
      pool.stopped++;
    },
  };
  return pool;
}

const generalAnswer = (messages: { content: string }[]) => {
  const content = messages[messages.length - 1].content;
  if (content.includes('JSON array')) return '[{"ja":"あ","en":"Ah"}]';
  if (content.includes('overview in English')) return 'Overview text';
  return '- [0:00:00] Something happens';
};

const opts = { translate: false, summarize: false, skim: false, userGlossary: {} };

describe('runLlmStages', () => {
  it('runs glossary, translate, summarize in order, swapping models between them', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い', 'う']);
    const translate = scriptedChat(echoTranslate());
    const pool = fakePool({ general: scriptedChat(generalAnswer), translate });
    const written = await runLlmStages(
      { repo, stages, job, outDir: dir, pool, log: () => {} },
      { ...opts, translate: true, summarize: true },
    );
    expect(pool.started).toEqual(['general', 'translate', 'general']);
    expect(pool.stopped).toBe(1);
    expect(written.map((p) => path.basename(p)).sort()).toEqual([
      `job-${job.id}.bi.srt`,
      `job-${job.id}.en.srt`,
      `job-${job.id}.summary.md`,
    ]);
    expect(stages.listGlossary(job.id)).toEqual([{ ja: 'あ', en: 'Ah', source: 'auto' }]);
    expect(translate.calls[0][0].content).toContain('あ translates to Ah');
    for (const stage of ['glossary', 'translate', 'summarize'] as const) {
      expect(stages.getStage(job.id, stage)).toBe('done');
    }
  });

  it('skim mode runs glossary and summarize on the general model only, with no translation', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い']);
    const translate = scriptedChat(echoTranslate());
    const pool = fakePool({ general: scriptedChat(generalAnswer), translate });
    const written = await runLlmStages({ repo, stages, job, outDir: dir, pool, log: () => {} }, { ...opts, skim: true });
    expect(pool.started).toEqual(['general']);
    expect(translate.calls).toHaveLength(0);
    expect(stages.getStage(job.id, 'translate')).toBeUndefined();
    expect(written.map((p) => path.basename(p))).toEqual([`job-${job.id}.summary.md`]);
  });

  it('does nothing and never starts a model for a job without segments', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, []);
    const pool = fakePool({ general: scriptedChat(generalAnswer), translate: scriptedChat(echoTranslate()) });
    const written = await runLlmStages(
      { repo, stages, job, outDir: dir, pool, log: () => {} },
      { ...opts, translate: true, summarize: true },
    );
    expect(written).toEqual([]);
    expect(pool.uses).toEqual([]);
  });

  it('resumes translation after an abort without redoing finished batches, and stops the models', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い', 'う', 'え']);
    const controller = new AbortController();
    const first = scriptedChat((m, call) => {
      if (call === 2) {
        controller.abort();
        return 'x';
      }
      return echoTranslate()(m);
    });
    const pool1 = fakePool({ general: scriptedChat(generalAnswer), translate: first });
    await expect(
      runLlmStages(
        { repo, stages, job, outDir: dir, pool: pool1, log: () => {}, signal: controller.signal },
        { ...opts, translate: true, batchSize: 2 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool1.stopped).toBe(1);
    expect(stages.getStage(job.id, 'translate')).toBe('running');
    expect(existsSync(path.join(dir, `job-${job.id}.en.srt`))).toBe(true); // written after batch 1

    const second = scriptedChat(echoTranslate());
    const pool2 = fakePool({ general: scriptedChat(generalAnswer), translate: second });
    await runLlmStages({ repo, stages, job, outDir: dir, pool: pool2, log: () => {} }, { ...opts, translate: true, batchSize: 2 });
    expect(second.calls).toHaveLength(1);
    expect(stages.listTranslations(job.id).size).toBe(4);
  });

  it('marks a failing stage failed and rethrows', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ']);
    const boom = new Error('boom');
    const pool = fakePool({
      general: scriptedChat(() => '[]'),
      translate: { chat: async () => { throw boom; } },
    });
    await expect(
      runLlmStages({ repo, stages, job, outDir: dir, pool, log: () => {} }, { ...opts, translate: true }),
    ).rejects.toBe(boom);
    expect(stages.getStage(job.id, 'translate')).toBe('failed');
    expect(pool.stopped).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/stages.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement**

`src/core/pipeline/stages.ts`:
```ts
import { HyMtTranslator } from '../backends/translate/hymt';
import type { JobRow, Repo } from '../db/repo';
import type { StageName, StageRepo } from '../db/stage-repo';
import type { LlmChat } from '../llm/client';
import { runGlossaryStage } from './glossary-job';
import { writeLlmOutputs } from './llm-outputs';
import { runSummarizeStage } from './summarize-job';
import { runTranslateStage } from './translate-job';

export type ModelRole = 'general' | 'translate';

export interface ModelPool {
  /** Returns a chat client for the role, stopping any other loaded model first. */
  use(role: ModelRole, signal?: AbortSignal): Promise<LlmChat>;
  stopAll(): Promise<void>;
}

export interface StageOptions {
  translate: boolean;
  summarize: boolean;
  skim: boolean;
  userGlossary: Record<string, string>;
  batchSize?: number;
}

export interface StageContext {
  repo: Repo;
  stages: StageRepo;
  job: JobRow;
  outDir: string;
  pool: ModelPool;
  log: (message: string) => void;
  signal?: AbortSignal;
}

export async function runLlmStages(ctx: StageContext, opts: StageOptions): Promise<string[]> {
  const { repo, stages, job, pool, log, signal } = ctx;
  if (repo.listSegments(job.id).length === 0) {
    log('No speech was transcribed, so there is nothing to translate or summarize.');
    return [];
  }

  const wantGlossary = opts.translate || opts.skim;
  const wantSummary = opts.summarize || opts.skim;

  const guard = async (stage: StageName, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      if (!signal?.aborted) stages.setStage(job.id, stage, 'failed');
      throw err;
    }
  };

  try {
    if (wantGlossary) {
      await guard('glossary', async () => {
        log('Extracting names and terms...');
        const llm = await pool.use('general', signal);
        await runGlossaryStage({ repo, stages, llm, jobId: job.id, userGlossary: opts.userGlossary, signal, log });
      });
    }
    if (opts.translate) {
      await guard('translate', async () => {
        log('Translating...');
        const llm = await pool.use('translate', signal);
        await runTranslateStage({
          repo,
          stages,
          translator: new HyMtTranslator(llm),
          jobId: job.id,
          batchSize: opts.batchSize,
          signal,
          log,
          onBatch: () => writeLlmOutputs(repo, stages, job, ctx.outDir),
        });
      });
    }
    if (wantSummary) {
      await guard('summarize', async () => {
        log('Summarizing...');
        const llm = await pool.use('general', signal);
        await runSummarizeStage({ repo, stages, llm, jobId: job.id, rangeStartMs: job.rangeStartMs, signal, log });
      });
    }
  } finally {
    await pool.stopAll();
  }
  return writeLlmOutputs(repo, stages, job, ctx.outDir);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(pipeline): LLM stage orchestrator with one-model-at-a-time pool

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Real model pool, glossary file, CLI

**Files:**
- Create: `src/core/llm/glossary-file.ts`, `src/core/pipeline/real-llm.ts`, `src/cli/llm.ts`
- Modify: `src/core/pipeline/real-deps.ts` (also return `stages`), `src/cli/run.ts`, `src/cli/index.ts`, `src/cli/doctor.ts`
- Test: `tests/core/glossary-file.test.ts`

**Interfaces:**
- Consumes: `LlamaServer`, `LlmClient`, `resolveTool`, `loadLock`/`lockedModelPath`, `projectRoot`/`resourcesDir`, `runLlmStages`, `StageRepo`.
- Produces:
  - `loadGlossaryFile(file: string): Record<string, string>` (JSON object of string to string; anything else throws `InvalidInput` naming the file)
  - `createRealModelPool(a: { log: (m: string) => void; lockFile?: string }): ModelPool` (roles map to lock ids `model-general` / `model-translate`, context sizes 8192 / 4096; starts `llama-server` via `resolveTool('llama-server')`)
  - `createRealDeps` now returns `{ deps, stages, workRoot, close }`
  - CLI: `kikitori run ... --translate --summarize --skim --glossary <file>`; `kikitori translate <jobId> [--glossary f] [--out dir]`; `kikitori summarize <jobId> [--out dir]`. `--skim` with `--translate` is `InvalidInput`. LLM stages run only after a fully successful transcription.

- [ ] **Step 1: Write the failing test**

`tests/core/glossary-file.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGlossaryFile } from '../../src/core/llm/glossary-file';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-gloss-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (content: string) => {
  const file = path.join(dir, 'glossary.json');
  writeFileSync(file, content);
  return file;
};

describe('loadGlossaryFile', () => {
  it('reads a flat object of strings', () => {
    expect(loadGlossaryFile(write('{"ゆりまる":"Yurimaru"}'))).toEqual({ ゆりまる: 'Yurimaru' });
  });

  it.each([
    ['not json', '{oops'],
    ['an array', '["a"]'],
    ['non-string values', '{"a": 1}'],
  ])('rejects %s with InvalidInput', (_n, content) => {
    expect(() => loadGlossaryFile(write(content))).toThrow(
      expect.objectContaining({ code: 'InvalidInput', message: expect.stringContaining('glossary.json') }),
    );
  });

  it('rejects a missing file with InvalidInput', () => {
    expect(() => loadGlossaryFile(path.join(dir, 'nope.json'))).toThrow(
      expect.objectContaining({ code: 'InvalidInput' }),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/glossary-file.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement the core pieces**

`src/core/llm/glossary-file.ts`:
```ts
import { readFileSync } from 'node:fs';
import { BgtError } from '../errors';

export function loadGlossaryFile(file: string): Record<string, string> {
  const bad = (why: string) => new BgtError('InvalidInput', `Glossary file "${file}": ${why}`);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw bad('cannot be read.');
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw bad('is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw bad('must be a JSON object mapping Japanese terms to English.');
  }
  const out: Record<string, string> = {};
  for (const [ja, en] of Object.entries(data)) {
    if (typeof en !== 'string') throw bad(`the value for "${ja}" must be a string.`);
    out[ja] = en;
  }
  return out;
}
```

`src/core/pipeline/real-llm.ts`:
```ts
import path from 'node:path';
import { LlmClient } from '../llm/client';
import { LlamaServer } from '../llm/llama-server';
import { loadLock, lockedModelPath } from '../tools/lock';
import { projectRoot, resolveTool, resourcesDir } from '../tools/paths';
import type { ModelPool, ModelRole } from './stages';

const MODEL_ID: Record<ModelRole, string> = { general: 'model-general', translate: 'model-translate' };
const CONTEXT: Record<ModelRole, number> = { general: 8192, translate: 4096 };

export function createRealModelPool(a: { log: (message: string) => void; lockFile?: string }): ModelPool {
  let current: { role: ModelRole; server: LlamaServer; client: LlmClient } | null = null;

  const stopAll = async () => {
    const running = current;
    current = null;
    if (running) await running.server.stop();
  };

  return {
    async use(role, signal) {
      if (current?.role === role) return current.client;
      await stopAll();
      const lock = loadLock(a.lockFile ?? path.join(projectRoot(), 'tools.lock.json'));
      a.log(`Starting the ${role === 'translate' ? 'translation' : 'general'} model...`);
      const server = await LlamaServer.start(
        {
          serverPath: resolveTool('llama-server'),
          modelPath: lockedModelPath(MODEL_ID[role], lock, resourcesDir()),
          contextSize: CONTEXT[role],
        },
        signal,
      );
      current = { role, server, client: new LlmClient({ baseUrl: server.baseUrl }) };
      return current.client;
    },
    stopAll,
  };
}
```

In `src/core/pipeline/real-deps.ts`: import `StageRepo` from `'../db/stage-repo'`, construct it from the same `db`, and change the return type and value to include it:
```ts
}): { deps: PipelineDeps; stages: StageRepo; workRoot: string; close(): void } {
```
```ts
  return { deps, stages: new StageRepo(db), workRoot: path.join(a.dataDir, 'work'), close: () => db.close() };
```

- [ ] **Step 4: Run to verify the test passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Implement the CLI**

`src/cli/llm.ts`:
```ts
import path from 'node:path';
import { BgtError } from '../core/errors';
import { loadGlossaryFile } from '../core/llm/glossary-file';
import { createRealDeps } from '../core/pipeline/real-deps';
import { createRealModelPool } from '../core/pipeline/real-llm';
import { runLlmStages, type StageOptions } from '../core/pipeline/stages';
import { dataDir } from '../core/tools/paths';

export interface LlmCliOptions {
  translate?: boolean;
  summarize?: boolean;
  skim?: boolean;
  glossary?: string;
  out: string;
}

export function wantsLlm(o: LlmCliOptions): boolean {
  return Boolean(o.translate || o.summarize || o.skim);
}

export function validateLlmOptions(o: LlmCliOptions): void {
  if (o.skim && o.translate) {
    throw new BgtError('InvalidInput', '--skim skips full translation, so it cannot be combined with --translate.');
  }
}

export function stageOptions(o: LlmCliOptions): StageOptions {
  return {
    translate: Boolean(o.translate),
    summarize: Boolean(o.summarize),
    skim: Boolean(o.skim),
    userGlossary: o.glossary ? loadGlossaryFile(o.glossary) : {},
  };
}

/** Runs the LLM stages on an already transcribed job and prints the output paths. */
export async function runStagesForJob(
  jobId: number,
  o: LlmCliOptions,
  signal?: AbortSignal,
  reuse?: ReturnType<typeof createRealDeps>,
): Promise<void> {
  validateLlmOptions(o);
  const opts = stageOptions(o);
  const handle = reuse ?? createRealDeps({ dataDir: dataDir(), model: 'large-v3', log: console.log });
  try {
    const job = handle.deps.repo.getJob(jobId);
    if (!job) throw new BgtError('InvalidInput', `There is no job ${jobId}.`);
    if (job.status !== 'done') {
      throw new BgtError('InvalidInput', `Job ${jobId} has not finished transcribing. Re-run its "kikitori run" command first.`);
    }
    const written = await runLlmStages(
      {
        repo: handle.deps.repo,
        stages: handle.stages,
        job,
        outDir: path.resolve(o.out),
        pool: createRealModelPool({ log: console.log }),
        log: console.log,
        signal,
      },
      opts,
    );
    for (const file of written) console.log(`Wrote ${file}`);
  } finally {
    if (!reuse) handle.close();
  }
}

export async function llmCommand(jobIdText: string, o: LlmCliOptions, mode: 'translate' | 'summarize'): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => {
    console.log('\nStopping... run the same command again to resume.');
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  try {
    const jobId = Number(jobIdText);
    if (!Number.isInteger(jobId) || jobId < 1) throw new BgtError('InvalidInput', `"${jobIdText}" is not a job id.`);
    await runStagesForJob(jobId, { ...o, translate: mode === 'translate' ? true : o.translate, summarize: mode === 'summarize' ? true : o.summarize }, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      process.exitCode = 130;
      return;
    }
    if (err instanceof BgtError) {
      console.error(`${err.code}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
```

In `src/cli/run.ts`: extend the options and call the stages after a successful transcription.
- Add to `RunCliOptions`: `translate?: boolean; summarize?: boolean; skim?: boolean; glossary?: string;`
- Add imports: `import { runStagesForJob, validateLlmOptions, wantsLlm } from './llm';`
- Right after the `maxMinutes` validation add `validateLlmOptions(opts);` and, before `createRealDeps`, `const llmWanted = wantsLlm(opts);`
- Change the `createRealDeps` destructuring to `const handle = createRealDeps({...}); const { deps, workRoot, close } = handle;` (keeping `closeDeps = close;`).
- After the two `console.log` lines that print the SRT paths, add:
```ts
    if (result.status === 'done' && llmWanted) {
      await runStagesForJob(result.jobId, opts, controller.signal, handle);
    } else if (result.status !== 'done' && llmWanted) {
      console.log('Skipping translation/summary because some chunks failed. Re-run the command to retry them.');
    }
```

In `src/cli/index.ts` add to the `run` command, before `.action(runCommand)`:
```ts
  .option('--translate', 'translate to English (Hy-MT2) after transcribing')
  .option('--summarize', 'write a timestamped English summary')
  .option('--skim', 'summarize without a full translation (cannot be combined with --translate)')
  .option('--glossary <file>', 'JSON file mapping Japanese terms to English')
```
and register two commands (import `llmCommand` from `./llm`):
```ts
program
  .command('translate')
  .argument('<jobId>', 'id of a finished job')
  .option('--glossary <file>', 'JSON file mapping Japanese terms to English')
  .option('--summarize', 'also write a summary')
  .option('--out <dir>', 'output directory', 'output')
  .action((jobId, o) => llmCommand(jobId, o, 'translate'));

program
  .command('summarize')
  .argument('<jobId>', 'id of a finished job')
  .option('--out <dir>', 'output directory', 'output')
  .action((jobId, o) => llmCommand(jobId, o, 'summarize'));
```

In `src/cli/doctor.ts` add `'llama-server'` to the tool loop, and after the VAD model line add checks for the two models using the lock:
```ts
import path from 'node:path';
import { loadLock, lockedModelPath } from '../core/tools/lock';
import { projectRoot, resourcesDir } from '../core/tools/paths';
```
```ts
  try {
    const lock = loadLock(path.join(projectRoot(), 'tools.lock.json'));
    for (const id of ['model-translate', 'model-general']) {
      try {
        line(id, lockedModelPath(id, lock, resourcesDir()), true);
      } catch (err) {
        line(id, err instanceof Error ? err.message : String(err), false);
      }
    }
  } catch {
    line('tools.lock.json', 'cannot be read (run "pnpm pin:tools")', false);
  }
```
(`resolved` is typed `Partial<Record<ToolName, string>>`, so adding `'llama-server'` to the loop needs no other change.)

- [ ] **Step 6: Verify the CLI surface**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm kikitori --help
pnpm kikitori run x.wav --skim --translate
pnpm kikitori translate abc
```
Expected: checks pass; help lists `run`, `doctor`, `update-ytdlp`, `translate`, `summarize`; the second prints `InvalidInput: --skim skips full translation...`; the third prints `InvalidInput: "abc" is not a job id.`

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat(cli): translate, summarize, skim and glossary options with real model pool

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Pin and fetch the LLM tools, integration test, real-quality run

This task needs the network (about 12 GB of downloads: llama.cpp ~0.5 GB, Hy-MT2 ~4.7 GB, Qwen3-8B ~5 GB) and uses the finished jobs from Milestone 1 stored in `data/bgt.sqlite`.

**Files:**
- Modify: `scripts/pin-tools.ts` (rewrite), `tools.lock.json` (generated)
- Create: `tests/integration/llm.integration.test.ts`
- Modify (only if verification demands it): `src/core/llm/prompts.ts`, `src/core/pipeline/stages.ts` constants

**Interfaces:**
- Consumes: everything.
- Produces: a lock that pins llama.cpp (+ cudart), `model-translate`, `model-general` while keeping the existing pinned entries; a green opt-in integration test; the author's quality verdict on real output.

- [ ] **Step 1: Rewrite the pin script so existing entries are preserved**

Replace `scripts/pin-tools.ts` with:
```ts
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadLock, type Lock, type LockEntry } from '../src/core/tools/lock';
import { projectRoot } from '../src/core/tools/paths';

const headers = { 'User-Agent': 'kikitori', Accept: 'application/json' };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function sha256OfUrl(url: string): Promise<string> {
  console.log(`  hashing ${url} ...`);
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status}`);
  const hash = createHash('sha256');
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
  return hash.digest('hex');
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}
interface GhRelease {
  tag_name: string;
  assets: GhAsset[];
}
interface HfTreeItem {
  path: string;
  lfs?: { oid: string };
}

const assetSha = async (a: GhAsset) =>
  a.digest?.startsWith('sha256:') ? a.digest.slice(7) : sha256OfUrl(a.browser_download_url);

async function hfFile(repo: string, pick: (name: string) => boolean) {
  const info = await getJson<{ sha: string }>(`https://huggingface.co/api/models/${repo}`);
  const tree = await getJson<HfTreeItem[]>(`https://huggingface.co/api/models/${repo}/tree/${info.sha}`);
  const item = tree.filter((t) => t.lfs && pick(t.path)).sort((a, b) => a.path.localeCompare(b.path)).at(-1);
  if (!item?.lfs) throw new Error(`No matching file in ${repo}`);
  return {
    name: item.path,
    url: `https://huggingface.co/${repo}/resolve/${info.sha}/${item.path}`,
    sha256: item.lfs.oid,
    rev: info.sha.slice(0, 7),
  };
}

async function pinYtDlp(): Promise<LockEntry> {
  const yt = await getJson<GhRelease>('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
  const sums = await getText(`https://github.com/yt-dlp/yt-dlp/releases/download/${yt.tag_name}/SHA2-256SUMS`);
  const sha = sums
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === 'yt-dlp.exe')?.[0];
  if (!sha) throw new Error('yt-dlp.exe not found in SHA2-256SUMS');
  return {
    id: 'yt-dlp',
    version: yt.tag_name,
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${yt.tag_name}/yt-dlp.exe`,
    sha256: sha,
    kind: 'file',
    dest: 'bin/yt-dlp.exe',
  };
}

async function pinWhisper(): Promise<LockEntry> {
  // Binaries live on separate "bNNNN" releases; prefer the newest release with a CUDA build.
  const releases = await getJson<GhRelease[]>('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15');
  const cudaPatterns = [/^whisper-bin-win-cuda-([\d.]+)-x64\.zip$/, /^whisper-cublas-([\d.]+)-bin-x64\.zip$/];
  const cudaVersion = (name: string) => cudaPatterns.map((p) => p.exec(name)?.[1]).find(Boolean) ?? '0';
  const byVersion = (x: GhAsset, y: GhAsset) =>
    cudaVersion(x.name).localeCompare(cudaVersion(y.name), undefined, { numeric: true });
  for (const release of releases) {
    const cuda = release.assets.filter((a) => cudaPatterns.some((p) => p.test(a.name))).sort(byVersion).at(-1);
    const cpu = release.assets.find((a) => a.name === 'whisper-bin-x64.zip');
    const asset = cuda ?? cpu;
    if (!asset) continue;
    if (!cuda) console.warn('WARNING: no CUDA build in this whisper.cpp release; pinning the CPU build.');
    return {
      id: 'whisper.cpp',
      version: `${release.tag_name} (${asset.name})`,
      url: asset.browser_download_url,
      sha256: await assetSha(asset),
      kind: 'zip',
      dest: 'whisper',
    };
  }
  throw new Error('No Windows x64 whisper.cpp asset found in the 15 most recent releases.');
}

async function pinLlama(): Promise<LockEntry[]> {
  const releases = await getJson<GhRelease[]>('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8');
  const main = /^llama-b\d+-bin-win-cuda-12\.4-x64\.zip$/;
  const cudart = /^cudart-llama-bin-win-cuda-12\.4-x64\.zip$/;
  for (const release of releases) {
    const a = release.assets.find((x) => main.test(x.name));
    const rt = release.assets.find((x) => cudart.test(x.name));
    if (!a || !rt) continue;
    return [
      { id: 'llama.cpp', version: `${release.tag_name} (${a.name})`, url: a.browser_download_url, sha256: await assetSha(a), kind: 'zip', dest: 'llama', merge: true },
      { id: 'llama-cudart', version: `${release.tag_name} (${rt.name})`, url: rt.browser_download_url, sha256: await assetSha(rt), kind: 'zip', dest: 'llama', merge: true },
    ];
  }
  throw new Error('No llama.cpp release with a CUDA 12.4 x64 build and its cudart zip was found.');
}

async function pinModel(id: string, repo: string, file: string): Promise<LockEntry> {
  const f = await hfFile(repo, (n) => n === file);
  return { id, version: f.rev, url: f.url, sha256: f.sha256, kind: 'file', dest: `models/${f.name}` };
}

async function pinVad(): Promise<LockEntry> {
  const f = await hfFile('ggml-org/whisper-vad', (n) => /^ggml-silero-v[\d.]+\.bin$/.test(n));
  return { id: 'vad-silero', version: f.rev, url: f.url, sha256: f.sha256, kind: 'file', dest: `models/${f.name}` };
}

async function main() {
  const file = path.join(projectRoot(), 'tools.lock.json');
  const update = process.argv.includes('--update');
  const existing: LockEntry[] = !update && existsSync(file) ? loadLock(file).tools : [];
  const have = new Set(existing.map((t) => t.id));
  const tools = [...existing];
  const add = async (ids: string[], make: () => Promise<LockEntry | LockEntry[]>) => {
    if (ids.every((id) => have.has(id))) return;
    const made = await make();
    for (const entry of Array.isArray(made) ? made : [made]) {
      const i = tools.findIndex((t) => t.id === entry.id);
      if (i >= 0) tools[i] = entry;
      else tools.push(entry);
    }
  };

  await add(['yt-dlp'], pinYtDlp);
  await add(['whisper.cpp'], pinWhisper);
  await add(['model-large-v3'], () => pinModel('model-large-v3', 'ggerganov/whisper.cpp', 'ggml-large-v3.bin'));
  await add(['vad-silero'], pinVad);
  await add(['llama.cpp', 'llama-cudart'], pinLlama);
  await add(['model-translate'], () => pinModel('model-translate', 'tencent/Hy-MT2-7B-GGUF', 'Hy-MT2-7B-Q4_K_M.gguf'));
  await add(['model-general'], () => pinModel('model-general', 'Qwen/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf'));

  const lock: Lock = { platform: 'win32-x64', tools };
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Wrote ${file}${update ? ' (all entries refreshed)' : ' (existing entries kept)'}`);
  for (const t of tools) console.log(`  ${t.id}  ${t.version}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 2: Pin, then check the lock kept the old entries**

Run: `pnpm pin:tools`
Expected: lists all 9 entries; `yt-dlp`, `whisper.cpp` (still `b5454 ...`), `model-large-v3`, `vad-silero` unchanged from the existing lock (compare with `git diff tools.lock.json`: only additions).

- [ ] **Step 3: Download**

Run: `pnpm setup:tools`
Expected: the four old entries report `up to date`; `llama.cpp`, `llama-cudart`, `model-translate`, `model-general` download. Re-running reports everything up to date.

- [ ] **Step 4: Doctor, then start the real server once by hand**

Run: `pnpm kikitori doctor`
Expected: all rows `OK`, including `llama-server`, `model-translate`, `model-general`.

Then verify the server starts on the GPU (writes to the scratchpad nothing; output only):
```bash
LLAMA=$(find resources/llama -name llama-server.exe | head -1)
"$LLAMA" --version 2>&1 | head -3
```
Expected: prints a version and `ggml_cuda_init: found 1 CUDA devices`. If the CUDA runtime DLLs are missing the process exits with an error naming a DLL; in that case stop and report.

- [ ] **Step 5: Write the opt-in integration test**

`tests/integration/llm.integration.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { HyMtTranslator } from '../../src/core/backends/translate/hymt';
import { createRealModelPool } from '../../src/core/pipeline/real-llm';
import { parseGlossaryJson } from '../../src/core/llm/parse';
import { glossaryMessages } from '../../src/core/llm/prompts';

// Opt in with BGT_INTEGRATION=1. Requires `pnpm setup:tools` (about 10 GB of models).
describe.skipIf(!process.env.BGT_INTEGRATION)('real llama-server', () => {
  it('translates Japanese lines with Hy-MT2 and extracts glossary JSON with the general model', async () => {
    const pool = createRealModelPool({ log: () => {} });
    try {
      const translate = await pool.use('translate');
      const out = await new HyMtTranslator(translate).translateBatch(
        ['こんにちは、ゆりまるです', '今日は運動会の話をします', 'ありがとうございました'],
        [{ ja: 'ゆりまる', en: 'Yurimaru', source: 'user' }],
        [],
      );
      expect(out).toHaveLength(3);
      expect(out.every((line) => /[A-Za-z]/.test(line))).toBe(true);
      expect(out[0]).toContain('Yurimaru');

      const general = await pool.use('general');
      const reply = await general.chat(glossaryMessages('ゆりまるです。道の駅キラリアサヒでシャインマスカットを買いました。ゆりまるは運動会に出ます。'));
      expect(parseGlossaryJson(reply).length).toBeGreaterThan(0);
    } finally {
      await pool.stopAll();
    }
  }, 600_000);
});

```

Run: `BGT_INTEGRATION=1 pnpm test tests/integration/llm`
Expected: PASS. If `out[0]` lacks `Yurimaru` or a line is empty, adjust `translationMessages` wording (terminology block format) in `src/core/llm/prompts.ts`, update the matching assertions in `tests/core/llm-prompts.test.ts`, and re-run all tests.

Run without the variable: `pnpm test && pnpm typecheck && pnpm lint`
Expected: the integration tests are skipped; everything else passes.

- [ ] **Step 6: Commit**

```bash
git add scripts tools.lock.json tests
git commit -m "feat(tools): pin llama.cpp and the translation/general models; add LLM integration test

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Real quality run on the author's videos (needs the author's judgment)**

The two Milestone 1 jobs are in `data/bgt.sqlite` (job 2: the 9-minute video; job 3: minutes 20 to 28 of the long one). Run:
```bash
pnpm kikitori translate 2 --summarize
pnpm kikitori translate 3 --summarize
```
Report: the time each took (and the model-start log lines), the output paths (`output/job-2.en.srt`, `.bi.srt`, `.summary.md`, same for job 3), the glossary the model extracted (`sqlite3` is not required: print it with a one-off `node -e` using better-sqlite3 against `data/bgt.sqlite`, table `glossary`), and the count of blank translations if any. Ask the author to read the bilingual SRT beside the video and the summary, and judge: wrong or inconsistent names, mistranslated slang, hallucinated lines, summary usefulness.

Tune only what the evidence points to, one change at a time, re-running on a copy of the job (delete that job's rows from `translations`, `summaries`, `stages` first): prompt wording in `src/core/llm/prompts.ts`, `batchSize`, context lines, `temperature`. Re-run `pnpm test` after each change.

- [ ] **Step 8: Final verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && git status --short`
Expected: all green; the working tree has no models, binaries, `data/`, or `output/` content tracked.

```bash
git add -A
git commit -m "chore: tune prompts from real-video quality run

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(Skip this commit if Step 7 changed nothing.)

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| llama-server pinned/downloaded like whisper.cpp, incl. split cudart zip | 1, 2, 13 |
| `LlmClient` over OpenAI-compatible API, retry/abort/timeout | 6 |
| `LlamaServer` lifecycle, health polling, failure messages, kill tree | 6 |
| Hy-MT2 translation with terminology prompt, batches of ~25, context, exact-line-count check, retry, line-by-line fallback, blank never invented | 5, 7, 8 |
| Glossary: model extraction, user file overrides, first proposal wins | 3, 4, 8, 12 |
| Summaries: 5-minute windows, 2 to 4 bullets, overview, sections above 12 windows, English text or Japanese fallback | 5, 9 |
| Skim mode | 11, 12 |
| One model at a time, role swap, `stopAll` always | 11, 12 |
| Migration 2 tables; translations dropped with re-transcribed segments | 3 |
| Outputs `.en.srt`, `.bi.srt`, `.summary.md`, offsets | 10 |
| New error codes; Ctrl+C stops server | 1, 6, 12 |
| CLI `--translate --summarize --skim --glossary`, `kikitori translate`, `kikitori summarize` | 12 |
| `doctor` reports new binaries and models | 12 |
| Unit tests with fakes, resume tests, fake server tests, opt-in integration test, manual quality check | 3 to 13 |
