# Milestone 1 Core Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `bgt` CLI that turns a Japanese YouTube URL (or local audio/video file) plus an optional time range into a resumable, chunked whisper.cpp transcription written as a Japanese SRT.

**Architecture:** An Electron-free core in `src/core/` (pipeline, SQLite state, tool wrappers, whisper.cpp backend) behind the `Transcriber` / `Translator` / `Summarizer` interfaces. A thin `commander` CLI in `src/cli/` wires real dependencies into `runJob`. Every process (yt-dlp, ffmpeg, whisper-cli) is spawned without a shell; per-chunk state lives in SQLite so a killed run resumes.

**Tech Stack:** Node 23 / TypeScript (ESM), pnpm, vitest, ESLint (typescript-eslint), better-sqlite3, commander, extract-zip, tsx. External binaries: yt-dlp, ffmpeg, whisper.cpp (`whisper-cli`), `large-v3` ggml model, Silero VAD ggml model.

**Spec:** `docs/superpowers/specs/2026-10-14-milestone-1-pipeline-design.md`

## Global Constraints

- `src/core/` must never import `electron`, `react`, `react-dom`, or anything under `src/cli`, `src/main`, `src/preload`, `src/renderer` (ESLint `no-restricted-imports` enforces it).
- Single package (no monorepo), TypeScript, ESM, pnpm, vitest, ESLint.
- Transcription engine: whisper.cpp `whisper-cli`, **spawned once per chunk**, JSON output parsed. Model `large-v3` (ggml), name is a config value. Silero VAD enabled via `--vad`.
- Storage: SQLite via `better-sqlite3`; tables `jobs`, `chunks`, `segments` only; migrations via `PRAGMA user_version`.
- Per-job cap 30 minutes by default, overridable with `--max-minutes`; over-cap fails with `OverCap`.
- Chunks ~15 minutes, cut at the silence nearest the target, ~2 s overlap, earlier chunk wins on overlap.
- Failed chunk: retried twice (3 attempts total), then marked `failed`; job continues; re-run processes only non-`done` chunks.
- Ctrl+C terminates the child process and leaves the job resumable.
- Working files in `work/<jobId>/` (here: `data/work/<jobId>/`), removed on success unless `--keep-work`.
- Windows first. Never commit downloaded media, models, transcripts, work dirs, or the SQLite file.
- Whisper only ever sees ASCII paths we control (`data/work/<id>/chunk-000.wav`); user-supplied paths go to ffmpeg only.
- Time values everywhere are integer milliseconds (`startMs`, `endMs`). Segments in the DB are relative to the extracted audio (0 = range start); SRT/JSON output adds the job's `rangeStartMs` so subtitles line up with the full video.

## Deviations from the spec (intentional, flag to the user at handoff)

- `electron`, `electron-vite`, `react` are **not installed** in Milestone 1 (no code uses them; multi-hundred-MB download). They are added in Milestone 3. The folder layout and ESLint boundary rule are in place now.
- ffmpeg is resolved from `resources/bin` then `PATH` only; auto-download is deferred to Milestone 4 (the user already has ffmpeg on PATH).
- One extra error code, `InvalidInput`, for bad timestamps/ranges/sources (spec lists four).
- The CLI is run as `pnpm bgt ...` (a `bin` entry is not published yet).

## Review Focus

Input classes the spec implies but does not spell out, most likely first. Each has a pinning test in the task named.

1. **YouTube URL with `&list=...` playlist parameter** must download only that video, never the playlist. Pinned in Task 10 (`--no-playlist` in both the probe and download args).
2. **A chunk that is all music/silence** (whisper returns zero segments) must complete normally, mark the chunk `done`, and still write a valid (possibly empty) SRT. Pinned in Task 13.
3. **Bad ranges:** start at or beyond the video length, end before start, end beyond the video (clamped), over-cap, unparseable timestamps. Each gives a clear error or a documented clamp, never a download. Pinned in Task 3.
4. **Paths with spaces and Japanese filenames** (local source `テスト 音声.wav`, output dir with a space). Pinned in Task 8 (args with spaces reach the child intact) and Task 15 (integration run).
5. **Process killed mid-chunk** leaves no half-written segments and no truncated `audio.wav` mistaken for complete. Pinned in Task 7 (`completeChunk` replaces atomically) and Task 13 (abort-then-resume test; partial audio file renamed only after a successful fetch).

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, eslint.config.js, .gitignore, tools.lock.json (Task 15)
scripts/fetch-tools.ts          # CLI wrapper around core/tools/fetch.ts
scripts/pin-tools.ts            # resolves latest releases -> tools.lock.json
src/core/errors.ts              # BgtError + codes
src/core/types.ts               # Segment
src/core/interfaces.ts          # Transcriber / Translator / Summarizer / Summary
src/core/time.ts                # parseTimestamp, formatClock(Ms), resolveRange
src/core/subtitles/srt.ts       # toSrt
src/core/pipeline/chunker.ts    # planChunks (pure)
src/core/pipeline/segment-cleanup.ts  # dropOverlapping, filterHallucinations
src/core/pipeline/estimate.ts   # estimateSeconds, formatDuration, perf store
src/core/pipeline/outputs.ts    # writeOutputs (srt + json)
src/core/pipeline/run.ts        # runJob + PipelineDeps
src/core/pipeline/real-deps.ts  # createRealDeps (wires binaries)
src/core/db/schema.ts           # migrate()
src/core/db/repo.ts             # Repo
src/core/db/index.ts            # openDb()
src/core/tools/paths.ts         # resources/data dirs, resolveTool, model paths
src/core/tools/process.ts       # runProcess (abortable, no shell)
src/core/tools/ffmpeg.ts        # probe, convert, silencedetect, cut
src/core/tools/ytdlp.ts         # probe duration, download, update
src/core/tools/lock.ts          # tools.lock.json types + loader
src/core/tools/fetch.ts         # sha256, download, extract
src/core/backends/transcribe/whispercpp.ts
src/cli/index.ts, src/cli/run.ts, src/cli/doctor.ts
tests/core/*.test.ts, tests/helpers/fakes.ts, tests/integration/pipeline.integration.test.ts
```

---

### Task 1: Scaffold the package, tooling, and git hygiene

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `pnpm test`, `pnpm lint`, `pnpm typecheck` scripts; the `src/core` import boundary.

- [ ] **Step 1: Install pnpm**

Run: `npm install -g pnpm` then `pnpm --version`
Expected: prints a version number (10.x or later).

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "bg-auto-translator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "bgt": "tsx src/cli/index.ts",
    "setup:tools": "tsx scripts/fetch-tools.ts",
    "pin:tools": "tsx scripts/pin-tools.ts",
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3", "esbuild"]
  }
}
```

- [ ] **Step 3: Install dependencies**

Run:
```bash
pnpm add better-sqlite3 commander extract-zip
pnpm add -D typescript tsx vitest eslint typescript-eslint @types/node @types/better-sqlite3
```
Expected: installs without errors. If `better-sqlite3` fails to build, stop and report the error (it needs a prebuilt binary for the installed Node version or a C++ toolchain).

- [ ] **Step 4: Write config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "tests", "*.config.ts", "*.config.js"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 20_000,
  },
});
```

`eslint.config.js`:
```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'resources', 'data', 'output', 'dist'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
              message: 'src/core must stay free of Electron and React.',
            },
            {
              group: ['**/cli/*', '**/main/*', '**/preload/*', '**/renderer/*'],
              message: 'src/core must not depend on app layers.',
            },
          ],
        },
      ],
    },
  },
);
```

`.gitignore`:
```
node_modules/
resources/
data/
output/
dist/
.env
*.wav
*.mp3
*.m4a
*.opus
*.mp4
*.webm
*.srt
*.vtt
*.bin
*.part
```

- [ ] **Step 5: Verify the toolchain and the import boundary**

Run:
```bash
pnpm typecheck
pnpm lint
pnpm test
node -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1');console.log('sqlite ok')"
mkdir -p src/core && printf "import 'electron';\n" > src/core/__lintcheck.ts
pnpm lint
```
Expected: the first three succeed (test run reports no test files, exit 0); `sqlite ok` prints; the final `pnpm lint` **fails** with `src/core must stay free of Electron and React.`

Then remove the probe file: `rm src/core/__lintcheck.ts` and re-run `pnpm lint` (passes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold package, tooling, and core import boundary

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Types, interfaces, and errors

**Files:**
- Create: `src/core/errors.ts`, `src/core/types.ts`, `src/core/interfaces.ts`
- Test: `tests/core/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ErrorCode = 'ToolMissing' | 'DownloadFailed' | 'TranscribeFailed' | 'OverCap' | 'InvalidInput'`
  - `class BgtError extends Error { readonly code: ErrorCode; constructor(code, message, options?: ErrorOptions) }`
  - `interface Segment { startMs: number; endMs: number; text: string; lang: string; avgLogprob?: number | null }`
  - `interface TranscribeOptions { language: string; signal?: AbortSignal }`
  - `interface Transcriber { transcribe(audioPath: string, opts: TranscribeOptions): Promise<Segment[]> }`
  - `interface Translator { translate(segments: Segment[], glossary: Record<string, string>): Promise<Segment[]> }`
  - `interface Summary { overview: string; sections: { startMs: number; endMs: number; text: string }[] }`
  - `interface Summarizer { summarize(segments: Segment[]): Promise<Summary> }`

- [ ] **Step 1: Write the failing test**

`tests/core/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BgtError } from '../../src/core/errors';

describe('BgtError', () => {
  it('carries a code, a message, and is an Error', () => {
    const err = new BgtError('OverCap', 'too long');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('OverCap');
    expect(err.name).toBe('OverCap');
    expect(err.message).toBe('too long');
  });

  it('preserves the cause', () => {
    const cause = new Error('root');
    expect(new BgtError('ToolMissing', 'x', { cause }).cause).toBe(cause);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/errors.test.ts`
Expected: FAIL, cannot resolve `../../src/core/errors`.

- [ ] **Step 3: Implement**

`src/core/errors.ts`:
```ts
export type ErrorCode =
  | 'ToolMissing'
  | 'DownloadFailed'
  | 'TranscribeFailed'
  | 'OverCap'
  | 'InvalidInput';

export class BgtError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = code;
  }
}
```

`src/core/types.ts`:
```ts
/** A timed piece of text. All times are integer milliseconds. */
export interface Segment {
  startMs: number;
  endMs: number;
  text: string;
  lang: string;
  /** Mean token log-probability reported by the recognizer, when available. */
  avgLogprob?: number | null;
}
```

`src/core/interfaces.ts`:
```ts
import type { Segment } from './types';

export interface TranscribeOptions {
  language: string;
  signal?: AbortSignal;
}

export interface Transcriber {
  transcribe(audioPath: string, opts: TranscribeOptions): Promise<Segment[]>;
}

/** Milestone 2. */
export interface Translator {
  translate(segments: Segment[], glossary: Record<string, string>): Promise<Segment[]>;
}

export interface Summary {
  overview: string;
  sections: { startMs: number; endMs: number; text: string }[];
}

/** Milestone 2. */
export interface Summarizer {
  summarize(segments: Segment[]): Promise<Summary>;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/errors.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core tests/core
git commit -m "feat(core): add error type, Segment, and backend interfaces

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Timestamps and range resolution

**Files:**
- Create: `src/core/time.ts`
- Test: `tests/core/time.test.ts`

**Interfaces:**
- Consumes: `BgtError` (Task 2).
- Produces:
  - `parseTimestamp(input: string): number` (ms; accepts `S`, `S.mmm`, `M:SS`, `H:MM:SS`, with optional `.mmm`; throws `InvalidInput`)
  - `formatClock(ms: number): string` → `H:MM:SS`
  - `formatClockMs(ms: number): string` → `H:MM:SS.mmm`
  - `resolveRange(input: { startMs: number; endMs: number | null; durationMs: number; maxMinutes: number }): { startMs: number; endMs: number }`

- [ ] **Step 1: Write the failing tests**

`tests/core/time.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatClock, formatClockMs, parseTimestamp, resolveRange } from '../../src/core/time';

describe('parseTimestamp', () => {
  it.each([
    ['90', 90_000],
    ['1:30', 90_000],
    ['80:00', 4_800_000],
    ['1:20:00', 4_800_000],
    ['0:00:01.5', 1_500],
    ['12.25', 12_250],
    ['  1:00  ', 60_000],
  ])('parses %s', (input, expected) => {
    expect(parseTimestamp(input)).toBe(expected);
  });

  it.each(['', 'abc', '1:2:3:4', '1:75', '1:20:99', '-5', '1.', '1.2345', '1..2', '1:00:00:00'])(
    'rejects %j',
    (input) => {
      expect(() => parseTimestamp(input)).toThrow(/Invalid time/);
    },
  );
});

describe('formatClock', () => {
  it('formats without and with milliseconds', () => {
    expect(formatClock(4_800_000)).toBe('1:20:00');
    expect(formatClock(61_005)).toBe('0:01:01');
    expect(formatClockMs(61_005)).toBe('0:01:01.005');
  });
});

describe('resolveRange', () => {
  const base = { durationMs: 3_600_000, maxMinutes: 30 };

  it('defaults the end to the video duration when it fits the cap', () => {
    expect(resolveRange({ ...base, durationMs: 600_000, startMs: 0, endMs: null })).toEqual({
      startMs: 0,
      endMs: 600_000,
    });
  });

  it('keeps an explicit range', () => {
    expect(resolveRange({ ...base, startMs: 60_000, endMs: 360_000 })).toEqual({
      startMs: 60_000,
      endMs: 360_000,
    });
  });

  it('clamps an end beyond the video to the duration', () => {
    expect(resolveRange({ ...base, durationMs: 600_000, startMs: 0, endMs: 9_999_000 }).endMs).toBe(
      600_000,
    );
  });

  it('rejects start at or beyond the duration', () => {
    expect(() => resolveRange({ ...base, startMs: 3_600_000, endMs: null })).toThrow(/start/i);
    expect(() => resolveRange({ ...base, startMs: 4_000_000, endMs: null })).toThrow(/start/i);
  });

  it('rejects end <= start', () => {
    expect(() => resolveRange({ ...base, startMs: 100_000, endMs: 100_000 })).toThrow(/end/i);
    expect(() => resolveRange({ ...base, startMs: 100_000, endMs: 50_000 })).toThrow(/end/i);
  });

  it('fails with OverCap when the range exceeds the cap, including an open-ended range', () => {
    expect(() => resolveRange({ ...base, startMs: 0, endMs: 1_801_000 })).toThrow(
      expect.objectContaining({ code: 'OverCap' }),
    );
    expect(() => resolveRange({ ...base, startMs: 0, endMs: null })).toThrow(
      expect.objectContaining({ code: 'OverCap' }),
    );
  });

  it('allows exactly the cap', () => {
    expect(resolveRange({ ...base, startMs: 0, endMs: 1_800_000 }).endMs).toBe(1_800_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/time.test.ts`
Expected: FAIL, cannot resolve `../../src/core/time`.

- [ ] **Step 3: Implement**

`src/core/time.ts`:
```ts
import { BgtError } from './errors';

export function parseTimestamp(input: string): number {
  const text = input.trim();
  const bad = () =>
    new BgtError(
      'InvalidInput',
      `Invalid time "${input}". Use seconds, M:SS or H:MM:SS (optionally with .mmm).`,
    );

  const dotParts = text.split('.');
  if (dotParts.length > 2) throw bad();
  const [main, frac = ''] = dotParts;
  if (!/^\d+(:\d+){0,2}$/.test(main) || !/^\d{0,3}$/.test(frac)) throw bad();
  if (dotParts.length === 2 && frac === '') throw bad();

  const parts = main.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) throw bad();
  const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
  return seconds * 1000 + Number(frac.padEnd(3, '0'));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function split(ms: number) {
  const total = Math.max(0, Math.round(ms));
  return {
    h: Math.floor(total / 3_600_000),
    m: Math.floor((total % 3_600_000) / 60_000),
    s: Math.floor((total % 60_000) / 1000),
    milli: total % 1000,
  };
}

export function formatClock(ms: number): string {
  const { h, m, s } = split(ms);
  return `${h}:${pad2(m)}:${pad2(s)}`;
}

export function formatClockMs(ms: number): string {
  const { milli } = split(ms);
  return `${formatClock(ms)}.${String(milli).padStart(3, '0')}`;
}

export interface RangeInput {
  startMs: number;
  endMs: number | null;
  durationMs: number;
  maxMinutes: number;
}

export function resolveRange(input: RangeInput): { startMs: number; endMs: number } {
  const { startMs, durationMs, maxMinutes } = input;
  if (startMs >= durationMs) {
    throw new BgtError(
      'InvalidInput',
      `Start (${formatClock(startMs)}) is at or beyond the end of the video (${formatClock(durationMs)}).`,
    );
  }
  const endMs = Math.min(input.endMs ?? durationMs, durationMs);
  if (endMs <= startMs) {
    throw new BgtError(
      'InvalidInput',
      `End (${formatClock(endMs)}) must be after start (${formatClock(startMs)}).`,
    );
  }
  if (endMs - startMs > maxMinutes * 60_000) {
    throw new BgtError(
      'OverCap',
      `Requested ${Math.round((endMs - startMs) / 60_000)} min exceeds the ${maxMinutes} min limit. ` +
        `Pick a smaller range with --start/--end, or raise the limit with --max-minutes.`,
    );
  }
  return { startMs, endMs };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/time.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/time.ts tests/core/time.test.ts
git commit -m "feat(core): timestamp parsing and range resolution

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: SRT writer

**Files:**
- Create: `src/core/subtitles/srt.ts`
- Test: `tests/core/srt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toSrt(segments: { startMs: number; endMs: number; text: string }[]): string`

- [ ] **Step 1: Write the failing tests**

`tests/core/srt.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { toSrt } from '../../src/core/subtitles/srt';

describe('toSrt', () => {
  it('numbers cues and formats HH:MM:SS,mmm', () => {
    const out = toSrt([
      { startMs: 1_000, endMs: 3_500, text: 'こんにちは' },
      { startMs: 3_723_004, endMs: 3_725_000, text: 'もう一度' },
    ]);
    expect(out).toBe(
      '1\n00:00:01,000 --> 00:00:03,500\nこんにちは\n\n2\n01:02:03,004 --> 01:02:05,000\nもう一度\n',
    );
  });

  it('returns an empty string for no segments', () => {
    expect(toSrt([])).toBe('');
  });

  it('trims text and collapses blank lines that would end a cue early', () => {
    const out = toSrt([{ startMs: 0, endMs: 1000, text: '  one\n\n\ntwo  ' }]);
    expect(out).toBe('1\n00:00:00,000 --> 00:00:01,000\none\ntwo\n');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/srt.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement**

`src/core/subtitles/srt.ts`:
```ts
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(total % 1000, 3)}`;
}

export function toSrt(segments: { startMs: number; endMs: number; text: string }[]): string {
  return segments
    .map((seg, i) => {
      const text = seg.text.trim().replace(/\n{2,}/g, '\n');
      return `${i + 1}\n${srtTime(seg.startMs)} --> ${srtTime(seg.endMs)}\n${text}\n`;
    })
    .join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/srt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/subtitles tests/core/srt.test.ts
git commit -m "feat(core): SRT writer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Chunk planner

**Files:**
- Create: `src/core/pipeline/chunker.ts`
- Test: `tests/core/chunker.test.ts`

**Interfaces:**
- Consumes: `BgtError`.
- Produces:
  - `interface SilenceInterval { startMs: number; endMs: number }`
  - `interface PlannedChunk { idx: number; startMs: number; endMs: number }`
  - `interface ChunkPlanOptions { targetMs: number; overlapMs: number; searchMs: number; minTailMs: number }`
  - `const CHUNK_DEFAULTS: ChunkPlanOptions` (15 min target, 2 s overlap, 3 min search window, 3 min min tail)
  - `planChunks(totalMs: number, silences: SilenceInterval[], opts?: ChunkPlanOptions): PlannedChunk[]`
  - Semantics: chunk `i` audio range is `[max(0, b_i - overlap), b_{i+1}]`, where `b` are the nominal boundaries; chunk 0 starts at 0.

- [ ] **Step 1: Write the failing tests**

`tests/core/chunker.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { planChunks, type ChunkPlanOptions } from '../../src/core/pipeline/chunker';

const opts: ChunkPlanOptions = {
  targetMs: 900_000,
  overlapMs: 2_000,
  searchMs: 180_000,
  minTailMs: 180_000,
};

describe('planChunks', () => {
  it('returns a single chunk for short audio', () => {
    expect(planChunks(600_000, [], opts)).toEqual([{ idx: 0, startMs: 0, endMs: 600_000 }]);
  });

  it('does not leave a tiny final chunk', () => {
    // 17 min: remaining after 15 min would be 2 min < minTail, so no split
    expect(planChunks(1_020_000, [], opts)).toHaveLength(1);
  });

  it('cuts at the midpoint of the silence nearest the target', () => {
    const chunks = planChunks(1_800_000, [{ startMs: 870_000, endMs: 880_000 }], opts);
    expect(chunks).toEqual([
      { idx: 0, startMs: 0, endMs: 875_000 },
      { idx: 1, startMs: 873_000, endMs: 1_800_000 },
    ]);
  });

  it('prefers the closest of several silences', () => {
    const chunks = planChunks(
      1_800_000,
      [
        { startMs: 780_000, endMs: 790_000 }, // 115s from target
        { startMs: 895_000, endMs: 905_000 }, // 0s from target
      ],
      opts,
    );
    expect(chunks[0]).toEqual({ idx: 0, startMs: 0, endMs: 900_000 });
  });

  it('ignores silences outside the search window and cuts at the target', () => {
    const chunks = planChunks(1_800_000, [{ startMs: 100_000, endMs: 110_000 }], opts);
    expect(chunks[0].endMs).toBe(900_000);
    expect(chunks[1].startMs).toBe(898_000);
  });

  it('plans several chunks for long audio and covers the whole range', () => {
    const chunks = planChunks(2_400_000, [{ startMs: 870_000, endMs: 880_000 }], opts);
    expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 875_000],
      [873_000, 1_775_000],
      [1_773_000, 2_400_000],
    ]);
  });

  it('never starts a later chunk before zero', () => {
    const chunks = planChunks(1_800_000, [], { ...opts, overlapMs: 5_000_000, targetMs: 900_000 });
    expect(chunks[1].startMs).toBe(0);
  });

  it('rejects an impossible search window', () => {
    expect(() => planChunks(1_000, [], { ...opts, searchMs: 900_000 })).toThrow(/searchMs/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/chunker.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement**

`src/core/pipeline/chunker.ts`:
```ts
import { BgtError } from '../errors';

export interface SilenceInterval {
  startMs: number;
  endMs: number;
}

export interface PlannedChunk {
  idx: number;
  startMs: number;
  endMs: number;
}

export interface ChunkPlanOptions {
  targetMs: number;
  overlapMs: number;
  searchMs: number;
  minTailMs: number;
}

export const CHUNK_DEFAULTS: ChunkPlanOptions = {
  targetMs: 15 * 60_000,
  overlapMs: 2_000,
  searchMs: 3 * 60_000,
  minTailMs: 3 * 60_000,
};

export function planChunks(
  totalMs: number,
  silences: SilenceInterval[],
  opts: ChunkPlanOptions = CHUNK_DEFAULTS,
): PlannedChunk[] {
  if (opts.searchMs >= opts.targetMs) {
    throw new BgtError('InvalidInput', 'searchMs must be smaller than targetMs');
  }

  const boundaries = [0];
  let cursor = 0;
  while (totalMs - cursor > opts.targetMs + opts.minTailMs) {
    const ideal = cursor + opts.targetMs;
    let cut = ideal;
    let bestDistance = Infinity;
    for (const silence of silences) {
      const mid = Math.round((silence.startMs + silence.endMs) / 2);
      const distance = Math.abs(mid - ideal);
      if (distance <= opts.searchMs && distance < bestDistance) {
        cut = mid;
        bestDistance = distance;
      }
    }
    boundaries.push(cut);
    cursor = cut;
  }
  boundaries.push(totalMs);

  return boundaries.slice(0, -1).map((boundary, idx) => ({
    idx,
    startMs: idx === 0 ? 0 : Math.max(0, boundary - opts.overlapMs),
    endMs: boundaries[idx + 1],
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/chunker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline/chunker.ts tests/core/chunker.test.ts
git commit -m "feat(core): silence-aware chunk planner

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Overlap dedupe and hallucination filter

**Files:**
- Create: `src/core/pipeline/segment-cleanup.ts`
- Test: `tests/core/segment-cleanup.test.ts`

**Interfaces:**
- Consumes: `Segment` (Task 2).
- Produces:
  - `dropOverlapping(segments: Segment[], cutoffMs: number): Segment[]` (keeps `startMs >= cutoffMs`)
  - `interface FilterOptions { minAvgLogprob: number; maxConsecutiveRepeats: number }`
  - `const FILTER_DEFAULTS: FilterOptions` (`-1.5`, `3`)
  - `filterHallucinations(segments: Segment[], opts?: FilterOptions): Segment[]`

- [ ] **Step 1: Write the failing tests**

`tests/core/segment-cleanup.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dropOverlapping, filterHallucinations } from '../../src/core/pipeline/segment-cleanup';
import type { Segment } from '../../src/core/types';

const seg = (text: string, startMs = 0, avgLogprob: number | null = -0.3): Segment => ({
  startMs,
  endMs: startMs + 1000,
  text,
  lang: 'ja',
  avgLogprob,
});

describe('dropOverlapping', () => {
  it('drops segments that start before the cutoff', () => {
    const kept = dropOverlapping([seg('a', 0), seg('b', 500), seg('c', 1000)], 1000);
    expect(kept.map((s) => s.text)).toEqual(['c']);
  });
});

describe('filterHallucinations', () => {
  it('drops empty and whitespace-only text', () => {
    expect(filterHallucinations([seg('  '), seg('はい')]).map((s) => s.text)).toEqual(['はい']);
  });

  it('drops very low confidence segments but keeps unknown confidence', () => {
    const out = filterHallucinations([seg('bad', 0, -2.2), seg('unknown', 1000, null), seg('ok', 2000)]);
    expect(out.map((s) => s.text)).toEqual(['unknown', 'ok']);
  });

  it('collapses a run longer than the limit to its first segment', () => {
    const run = [0, 1, 2, 3].map((i) => seg('ご視聴ありがとうございました', i * 1000));
    expect(filterHallucinations(run)).toHaveLength(1);
  });

  it('keeps a run at the limit', () => {
    const run = [0, 1, 2].map((i) => seg('はい', i * 1000));
    expect(filterHallucinations(run)).toHaveLength(3);
  });

  it('does not treat non-consecutive repeats as a run', () => {
    const input = [seg('はい', 0), seg('えっと', 1000), seg('はい', 2000), seg('えっと', 3000)];
    expect(filterHallucinations(input)).toHaveLength(4);
  });

  it('ignores punctuation differences when detecting repeats', () => {
    const run = ['はい。', 'はい', 'はい、', 'はい!'].map((t, i) => seg(t, i * 1000));
    expect(filterHallucinations(run)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/segment-cleanup.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement**

`src/core/pipeline/segment-cleanup.ts`:
```ts
import type { Segment } from '../types';

/** Keep only segments that start at or after the cutoff (earlier chunk wins on overlap). */
export function dropOverlapping(segments: Segment[], cutoffMs: number): Segment[] {
  return segments.filter((s) => s.startMs >= cutoffMs);
}

export interface FilterOptions {
  minAvgLogprob: number;
  maxConsecutiveRepeats: number;
}

/** Starting values; tune against real stream audio. */
export const FILTER_DEFAULTS: FilterOptions = {
  minAvgLogprob: -1.5,
  maxConsecutiveRepeats: 3,
};

const normalize = (text: string) => text.replace(/[\s、。,.!?！？…・]+/g, '').toLowerCase();

export function filterHallucinations(
  segments: Segment[],
  opts: FilterOptions = FILTER_DEFAULTS,
): Segment[] {
  const out: Segment[] = [];
  let run: Segment[] = [];

  const flush = () => {
    if (run.length <= opts.maxConsecutiveRepeats) out.push(...run);
    else out.push(run[0]);
    run = [];
  };

  for (const segment of segments) {
    const key = normalize(segment.text);
    if (key === '') continue;
    if (segment.avgLogprob != null && segment.avgLogprob < opts.minAvgLogprob) continue;
    if (run.length > 0 && normalize(run[0].text) === key) {
      run.push(segment);
    } else {
      flush();
      run = [segment];
    }
  }
  flush();
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/segment-cleanup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline/segment-cleanup.ts tests/core/segment-cleanup.test.ts
git commit -m "feat(core): overlap dedupe and hallucination filter

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: SQLite schema and repository

**Files:**
- Create: `src/core/db/schema.ts`, `src/core/db/repo.ts`, `src/core/db/index.ts`
- Test: `tests/core/repo.test.ts`

**Interfaces:**
- Consumes: `Segment`, `PlannedChunk` (Task 5).
- Produces:
  - `migrate(db: Database.Database): void`
  - `openDb(file: string): Database.Database` (creates parent dir, WAL, runs `migrate`)
  - Types: `JobStatus`, `ChunkStatus = 'pending'|'running'|'done'|'failed'`, `JobSettings { model: string; language: string; maxMinutes: number }`, `JobRow { id; source; rangeStartMs; rangeEndMs; settings: JobSettings; status: JobStatus; createdAt: string }`, `ChunkRow { jobId; idx; startMs; endMs; wavPath: string | null; status: ChunkStatus; attempts: number; error: string | null }`
  - `class Repo` with: `createJob(input: { source; rangeStartMs; rangeEndMs; settings }, createdAt?): JobRow`, `getJob(id): JobRow | undefined`, `findResumableJob(source, rangeStartMs, rangeEndMs, model): JobRow | undefined`, `setJobStatus(id, status)`, `insertChunks(jobId, chunks: PlannedChunk[])`, `listChunks(jobId): ChunkRow[]`, `resetUnfinishedChunks(jobId)`, `markChunkRunning(jobId, idx)`, `markChunkPending(jobId, idx)`, `markChunkFailed(jobId, idx, error)`, `completeChunk(jobId, idx, segments: Segment[])`, `listSegments(jobId): Segment[]`, `maxSegmentEndBefore(jobId, chunkIdx): number | null`

- [ ] **Step 1: Write the failing tests**

`tests/core/repo.test.ts`:
```ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/core/db/schema';
import { Repo } from '../../src/core/db/repo';
import type { Segment } from '../../src/core/types';

const settings = { model: 'large-v3', language: 'ja', maxMinutes: 30 };
const seg = (text: string, startMs: number, endMs: number): Segment => ({
  startMs,
  endMs,
  text,
  lang: 'ja',
  avgLogprob: -0.4,
});

let db: Database.Database;
let repo: Repo;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
});

describe('migrate', () => {
  it('is idempotent and sets user_version', () => {
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });
});

describe('jobs', () => {
  it('creates and reads back a job', () => {
    const job = repo.createJob({ source: 'https://y/1', rangeStartMs: 0, rangeEndMs: 1000, settings });
    expect(job).toMatchObject({ source: 'https://y/1', rangeEndMs: 1000, status: 'pending', settings });
    expect(repo.getJob(job.id)).toEqual(job);
  });

  it('finds an unfinished job with the same source, range and model only', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    expect(repo.findResumableJob('s', 0, 1000, 'large-v3')?.id).toBe(job.id);
    expect(repo.findResumableJob('s', 0, 1000, 'small')).toBeUndefined();
    expect(repo.findResumableJob('s', 0, 2000, 'large-v3')).toBeUndefined();
    repo.setJobStatus(job.id, 'done');
    expect(repo.findResumableJob('s', 0, 1000, 'large-v3')).toBeUndefined();
  });
});

describe('chunks', () => {
  it('inserts, lists in order, and tracks attempts', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [
      { idx: 1, startMs: 500, endMs: 1000 },
      { idx: 0, startMs: 0, endMs: 500 },
    ]);
    expect(repo.listChunks(job.id).map((c) => c.idx)).toEqual([0, 1]);
    repo.markChunkRunning(job.id, 0);
    repo.markChunkRunning(job.id, 0);
    expect(repo.listChunks(job.id)[0]).toMatchObject({ status: 'running', attempts: 2 });
  });

  it('resetUnfinishedChunks: running -> pending (keeps attempts), failed -> pending (resets)', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [
      { idx: 0, startMs: 0, endMs: 100 },
      { idx: 1, startMs: 100, endMs: 200 },
      { idx: 2, startMs: 200, endMs: 300 },
    ]);
    repo.markChunkRunning(job.id, 0);
    repo.markChunkRunning(job.id, 1);
    repo.markChunkFailed(job.id, 1, 'boom');
    repo.completeChunk(job.id, 2, []);
    repo.resetUnfinishedChunks(job.id);
    const chunks = repo.listChunks(job.id);
    expect(chunks[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(chunks[1]).toMatchObject({ status: 'pending', attempts: 0, error: null });
    expect(chunks[2].status).toBe('done');
  });
});

describe('segments', () => {
  it('completeChunk stores segments and marks the chunk done', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [{ idx: 0, startMs: 0, endMs: 1000 }]);
    repo.completeChunk(job.id, 0, [seg('b', 500, 600), seg('a', 100, 200)]);
    expect(repo.listChunks(job.id)[0].status).toBe('done');
    expect(repo.listSegments(job.id).map((s) => s.text)).toEqual(['a', 'b']);
    expect(repo.listSegments(job.id)[0]).toMatchObject({ lang: 'ja', avgLogprob: -0.4 });
  });

  it('completeChunk replaces earlier segments of the same chunk (no duplicates after a retry)', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [{ idx: 0, startMs: 0, endMs: 1000 }]);
    repo.completeChunk(job.id, 0, [seg('old', 0, 100)]);
    repo.completeChunk(job.id, 0, [seg('new', 0, 100)]);
    expect(repo.listSegments(job.id).map((s) => s.text)).toEqual(['new']);
  });

  it('maxSegmentEndBefore only considers earlier chunks', () => {
    const job = repo.createJob({ source: 's', rangeStartMs: 0, rangeEndMs: 1000, settings });
    repo.insertChunks(job.id, [
      { idx: 0, startMs: 0, endMs: 500 },
      { idx: 1, startMs: 500, endMs: 1000 },
      { idx: 2, startMs: 1000, endMs: 1500 },
    ]);
    repo.completeChunk(job.id, 0, [seg('a', 0, 400)]);
    repo.completeChunk(job.id, 2, [seg('c', 1100, 1400)]);
    expect(repo.maxSegmentEndBefore(job.id, 0)).toBeNull();
    expect(repo.maxSegmentEndBefore(job.id, 1)).toBe(400);
    expect(repo.maxSegmentEndBefore(job.id, 2)).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/repo.test.ts`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

`src/core/db/schema.ts`:
```ts
import type Database from 'better-sqlite3';

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
];

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
```

`src/core/db/repo.ts`:
```ts
import type Database from 'better-sqlite3';
import type { Segment } from '../types';
import type { PlannedChunk } from '../pipeline/chunker';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type ChunkStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobSettings {
  model: string;
  language: string;
  maxMinutes: number;
}

export interface JobRow {
  id: number;
  source: string;
  rangeStartMs: number;
  rangeEndMs: number;
  settings: JobSettings;
  status: JobStatus;
  createdAt: string;
}

export interface ChunkRow {
  jobId: number;
  idx: number;
  startMs: number;
  endMs: number;
  wavPath: string | null;
  status: ChunkStatus;
  attempts: number;
  error: string | null;
}

interface JobDb {
  id: number;
  source: string;
  range_start_ms: number;
  range_end_ms: number;
  settings_json: string;
  status: JobStatus;
  created_at: string;
}

interface ChunkDb {
  job_id: number;
  idx: number;
  start_ms: number;
  end_ms: number;
  wav_path: string | null;
  status: ChunkStatus;
  attempts: number;
  error: string | null;
}

interface SegmentDb {
  start_ms: number;
  end_ms: number;
  text: string;
  lang: string;
  avg_logprob: number | null;
}

const toJob = (r: JobDb): JobRow => ({
  id: r.id,
  source: r.source,
  rangeStartMs: r.range_start_ms,
  rangeEndMs: r.range_end_ms,
  settings: JSON.parse(r.settings_json) as JobSettings,
  status: r.status,
  createdAt: r.created_at,
});

const toChunk = (r: ChunkDb): ChunkRow => ({
  jobId: r.job_id,
  idx: r.idx,
  startMs: r.start_ms,
  endMs: r.end_ms,
  wavPath: r.wav_path,
  status: r.status,
  attempts: r.attempts,
  error: r.error,
});

export class Repo {
  constructor(private readonly db: Database.Database) {}

  createJob(
    input: { source: string; rangeStartMs: number; rangeEndMs: number; settings: JobSettings },
    createdAt: string = new Date().toISOString(),
  ): JobRow {
    const info = this.db
      .prepare(
        `INSERT INTO jobs (source, range_start_ms, range_end_ms, settings_json, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.source, input.rangeStartMs, input.rangeEndMs, JSON.stringify(input.settings), createdAt);
    return this.getJob(Number(info.lastInsertRowid)) as JobRow;
  }

  getJob(id: number): JobRow | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobDb | undefined;
    return row ? toJob(row) : undefined;
  }

  findResumableJob(
    source: string,
    rangeStartMs: number,
    rangeEndMs: number,
    model: string,
  ): JobRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE source = ? AND range_start_ms = ? AND range_end_ms = ? AND status <> 'done'
         ORDER BY id DESC`,
      )
      .all(source, rangeStartMs, rangeEndMs) as JobDb[];
    return rows.map(toJob).find((job) => job.settings.model === model);
  }

  setJobStatus(id: number, status: JobStatus): void {
    this.db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
  }

  insertChunks(jobId: number, chunks: PlannedChunk[]): void {
    const insert = this.db.prepare(
      'INSERT INTO chunks (job_id, idx, start_ms, end_ms) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const chunk of chunks) insert.run(jobId, chunk.idx, chunk.startMs, chunk.endMs);
    })();
  }

  listChunks(jobId: number): ChunkRow[] {
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE job_id = ? ORDER BY idx')
      .all(jobId) as ChunkDb[];
    return rows.map(toChunk);
  }

  /** Crash recovery: running -> pending (attempts kept); failed -> pending (attempts reset). */
  resetUnfinishedChunks(jobId: number): void {
    this.db
      .prepare(
        `UPDATE chunks
         SET status = 'pending',
             attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END,
             error = NULL
         WHERE job_id = ? AND status IN ('running', 'failed')`,
      )
      .run(jobId);
  }

  markChunkRunning(jobId: number, idx: number): void {
    this.db
      .prepare(
        `UPDATE chunks SET status = 'running', attempts = attempts + 1 WHERE job_id = ? AND idx = ?`,
      )
      .run(jobId, idx);
  }

  markChunkPending(jobId: number, idx: number): void {
    this.db
      .prepare(`UPDATE chunks SET status = 'pending' WHERE job_id = ? AND idx = ?`)
      .run(jobId, idx);
  }

  markChunkFailed(jobId: number, idx: number, error: string): void {
    this.db
      .prepare(`UPDATE chunks SET status = 'failed', error = ? WHERE job_id = ? AND idx = ?`)
      .run(error, jobId, idx);
  }

  /** Atomically replaces the chunk's segments and marks it done. */
  completeChunk(jobId: number, idx: number, segments: Segment[]): void {
    const insert = this.db.prepare(
      `INSERT INTO segments (job_id, chunk_idx, start_ms, end_ms, text, lang, avg_logprob)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM segments WHERE job_id = ? AND chunk_idx = ?').run(jobId, idx);
      for (const s of segments) {
        insert.run(jobId, idx, s.startMs, s.endMs, s.text, s.lang, s.avgLogprob ?? null);
      }
      this.db
        .prepare(`UPDATE chunks SET status = 'done', error = NULL WHERE job_id = ? AND idx = ?`)
        .run(jobId, idx);
    })();
  }

  listSegments(jobId: number): Segment[] {
    const rows = this.db
      .prepare('SELECT * FROM segments WHERE job_id = ? ORDER BY start_ms, id')
      .all(jobId) as SegmentDb[];
    return rows.map((r) => ({
      startMs: r.start_ms,
      endMs: r.end_ms,
      text: r.text,
      lang: r.lang,
      avgLogprob: r.avg_logprob,
    }));
  }

  /** Largest segment end among chunks before `chunkIdx`, or null if there are none. */
  maxSegmentEndBefore(jobId: number, chunkIdx: number): number | null {
    const row = this.db
      .prepare('SELECT MAX(end_ms) AS m FROM segments WHERE job_id = ? AND chunk_idx < ?')
      .get(jobId, chunkIdx) as { m: number | null };
    return row.m;
  }
}
```

`src/core/db/index.ts`:
```ts
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './schema';

export function openDb(file: string): Database.Database {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/repo.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/db tests/core/repo.test.ts
git commit -m "feat(core): SQLite schema and repository

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Process runner and tool/path resolution

**Files:**
- Create: `src/core/tools/process.ts`, `src/core/tools/paths.ts`
- Test: `tests/core/process.test.ts`, `tests/core/paths.test.ts`

**Interfaces:**
- Consumes: `BgtError`.
- Produces:
  - `interface RunResult { code: number | null; stdout: string; stderr: string }`
  - `runProcess(cmd: string, args: string[], opts?: { signal?: AbortSignal; cwd?: string; onStderr?: (chunk: string) => void }): Promise<RunResult>` (no shell; rejects with `signal.reason` on abort and kills the process tree; `ENOENT` -> `ToolMissing`)
  - `projectRoot(): string`, `resourcesDir(): string` (env `BGT_RESOURCES_DIR` overrides), `dataDir(): string` (env `BGT_DATA_DIR` overrides)
  - `type ToolName = 'yt-dlp' | 'ffmpeg' | 'whisper-cli'`
  - `exeName(name: string): string`
  - `findOnPath(exe: string, pathEnv?: string): string | null`
  - `resolveTool(name: ToolName, opts?: { resourcesDir?: string; pathEnv?: string }): string` (resources first, then PATH, else `ToolMissing`)
  - `modelPath(fileName: string, resourcesDirOverride?: string): string` (throws `ToolMissing` if absent)
  - `findVadModel(resourcesDirOverride?: string): string | null`

- [ ] **Step 1: Write the failing tests**

`tests/core/process.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/core/tools/process';

const node = process.execPath;

describe('runProcess', () => {
  it('captures stdout, stderr and exit code', async () => {
    const r = await runProcess(node, ['-e', 'console.log("out"); console.error("err"); process.exit(3)']);
    expect(r.code).toBe(3);
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
  });

  it('passes arguments with spaces and non-ASCII characters intact (no shell)', async () => {
    const arg = 'my test dir/テスト 音声.wav';
    const r = await runProcess(node, ['-e', 'console.log(process.argv[1])', arg]);
    expect(r.stdout.trim()).toBe(arg);
  });

  it('maps a missing executable to ToolMissing', async () => {
    await expect(runProcess('definitely-not-a-real-binary-xyz', [])).rejects.toMatchObject({
      code: 'ToolMissing',
    });
  });

  it('kills the child and rejects when aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runProcess(node, ['-e', 'setTimeout(() => {}, 60000)'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('rejects immediately if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess(node, ['-e', ''], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
```

`tests/core/paths.test.ts`:
```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exeName, findVadModel, modelPath, resolveTool } from '../../src/core/tools/paths';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-paths-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const touch = (...parts: string[]) => {
  const file = path.join(root, ...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'x');
  return file;
};

describe('resolveTool', () => {
  it('prefers a bundled binary over PATH', () => {
    const bundled = touch('res', 'bin', exeName('ffmpeg'));
    const pathDir = path.dirname(touch('onpath', exeName('ffmpeg')));
    expect(resolveTool('ffmpeg', { resourcesDir: path.join(root, 'res'), pathEnv: pathDir })).toBe(bundled);
  });

  it('falls back to PATH', () => {
    const onPath = touch('onpath', exeName('ffmpeg'));
    expect(
      resolveTool('ffmpeg', { resourcesDir: path.join(root, 'res'), pathEnv: path.dirname(onPath) }),
    ).toBe(onPath);
  });

  it('finds whisper-cli in a nested folder of the extracted archive', () => {
    const nested = touch('res', 'whisper', 'Release', exeName('whisper-cli'));
    expect(resolveTool('whisper-cli', { resourcesDir: path.join(root, 'res'), pathEnv: '' })).toBe(nested);
  });

  it('throws ToolMissing with a helpful message', () => {
    expect(() => resolveTool('yt-dlp', { resourcesDir: path.join(root, 'res'), pathEnv: '' })).toThrow(
      expect.objectContaining({ code: 'ToolMissing', message: expect.stringContaining('setup:tools') }),
    );
    expect(() => resolveTool('ffmpeg', { resourcesDir: path.join(root, 'res'), pathEnv: '' })).toThrow(
      /PATH/,
    );
  });
});

describe('model paths', () => {
  it('modelPath returns an existing model and throws ToolMissing otherwise', () => {
    const file = touch('res', 'models', 'ggml-large-v3.bin');
    expect(modelPath('ggml-large-v3.bin', path.join(root, 'res'))).toBe(file);
    expect(() => modelPath('ggml-nope.bin', path.join(root, 'res'))).toThrow(
      expect.objectContaining({ code: 'ToolMissing' }),
    );
  });

  it('findVadModel finds a silero model or returns null', () => {
    expect(findVadModel(path.join(root, 'res'))).toBeNull();
    const file = touch('res', 'models', 'ggml-silero-v5.1.2.bin');
    expect(findVadModel(path.join(root, 'res'))).toBe(file);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/process.test.ts tests/core/paths.test.ts`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement**

`src/core/tools/process.ts`:
```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { BgtError } from '../errors';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  cwd?: string;
  onStderr?: (chunk: string) => void;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // PyInstaller-style exes (yt-dlp) spawn a child; /T takes the whole tree.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

/** Runs a binary without a shell. Rejects with `signal.reason` on abort. */
export function runProcess(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => {
      stderr += d;
      opts.onStderr?.(d);
    });

    const onAbort = () => {
      killTree(child);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err: NodeJS.ErrnoException) => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        err.code === 'ENOENT'
          ? new BgtError('ToolMissing', `Cannot run "${cmd}": file not found.`, { cause: err })
          : err,
      );
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}
```

`src/core/tools/paths.ts`:
```ts
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BgtError } from '../errors';

export function projectRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

export function resourcesDir(): string {
  return process.env.BGT_RESOURCES_DIR ?? path.join(projectRoot(), 'resources');
}

export function dataDir(): string {
  return process.env.BGT_DATA_DIR ?? path.join(projectRoot(), 'data');
}

export type ToolName = 'yt-dlp' | 'ffmpeg' | 'whisper-cli';

export function exeName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

export function findOnPath(exe: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findFileRecursive(dir: string, fileName: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) return full;
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, fileName);
      if (found) return found;
    }
  }
  return null;
}

const BUNDLED_DIR: Record<ToolName, string> = {
  'yt-dlp': 'bin',
  ffmpeg: 'bin',
  'whisper-cli': 'whisper',
};

export interface ResolveOptions {
  resourcesDir?: string;
  pathEnv?: string;
}

/** Order: bundled copy in resources/, then PATH. */
export function resolveTool(name: ToolName, opts: ResolveOptions = {}): string {
  const exe = exeName(name);
  const dir = path.join(opts.resourcesDir ?? resourcesDir(), BUNDLED_DIR[name]);
  const bundled =
    name === 'whisper-cli'
      ? findFileRecursive(dir, exe)
      : existsSync(path.join(dir, exe))
        ? path.join(dir, exe)
        : null;
  if (bundled) return bundled;

  const onPath = findOnPath(exe, opts.pathEnv);
  if (onPath) return onPath;

  const hint =
    name === 'ffmpeg'
      ? 'Install ffmpeg (for example "winget install Gyan.FFmpeg") and make sure it is on PATH.'
      : 'Run "pnpm setup:tools" to download it.';
  throw new BgtError('ToolMissing', `${name} was not found in ${dir} or on PATH. ${hint}`);
}

export function modelPath(fileName: string, resourcesDirOverride?: string): string {
  const file = path.join(resourcesDirOverride ?? resourcesDir(), 'models', fileName);
  if (!existsSync(file)) {
    throw new BgtError('ToolMissing', `Model file ${file} is missing. Run "pnpm setup:tools".`);
  }
  return file;
}

export function findVadModel(resourcesDirOverride?: string): string | null {
  const dir = path.join(resourcesDirOverride ?? resourcesDir(), 'models');
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((n) => /^ggml-silero.*\.bin$/.test(n));
  return name ? path.join(dir, name) : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/process.test.ts tests/core/paths.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools tests/core/process.test.ts tests/core/paths.test.ts
git commit -m "feat(core): abortable process runner and tool path resolution

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: ffmpeg wrapper

**Files:**
- Create: `src/core/tools/ffmpeg.ts`
- Test: `tests/core/ffmpeg.test.ts`

**Interfaces:**
- Consumes: `runProcess` (Task 8), `SilenceInterval` (Task 5), `BgtError`.
- Produces:
  - `parseFfmpegDuration(stderr: string): number | null`
  - `parseSilenceDetect(stderr: string, totalMs: number): SilenceInterval[]`
  - `probeDurationMs(a: { ffmpegPath: string; file: string; signal?: AbortSignal }): Promise<number>`
  - `toWav16kMono(a: { ffmpegPath: string; input: string; output: string; startMs?: number; endMs?: number; signal?: AbortSignal }): Promise<void>`
  - `detectSilences(a: { ffmpegPath: string; wavPath: string; totalMs: number; signal?: AbortSignal }): Promise<SilenceInterval[]>`
  - `cutWav(a: { ffmpegPath: string; wavPath: string; startMs: number; endMs: number; outPath: string; signal?: AbortSignal }): Promise<void>`

- [ ] **Step 1: Write the failing tests (pure parsers)**

`tests/core/ffmpeg.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseFfmpegDuration, parseSilenceDetect } from '../../src/core/tools/ffmpeg';

describe('parseFfmpegDuration', () => {
  it('reads Duration from ffmpeg stderr', () => {
    const stderr = 'Input #0, wav, from x.wav:\n  Duration: 00:10:00.05, bitrate: 256 kb/s\n';
    expect(parseFfmpegDuration(stderr)).toBe(600_050);
    expect(parseFfmpegDuration('  Duration: 1:02:03.5, start')).toBe(3_723_500);
  });

  it('returns null when the duration is unknown', () => {
    expect(parseFfmpegDuration('  Duration: N/A, bitrate: N/A')).toBeNull();
    expect(parseFfmpegDuration('nothing here')).toBeNull();
  });
});

describe('parseSilenceDetect', () => {
  it('pairs silence_start/silence_end into intervals', () => {
    const stderr = [
      '[silencedetect @ 0000] silence_start: 12.5',
      '[silencedetect @ 0000] silence_end: 15.25 | silence_duration: 2.75',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 600_000)).toEqual([{ startMs: 12_500, endMs: 15_250 }]);
  });

  it('closes a trailing silence at the end of the audio and clamps negative starts', () => {
    const stderr = [
      '[silencedetect @ 0000] silence_start: -0.001',
      '[silencedetect @ 0000] silence_end: 1.0 | silence_duration: 1.0',
      '[silencedetect @ 0000] silence_start: 598.4',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 600_000)).toEqual([
      { startMs: 0, endMs: 1_000 },
      { startMs: 598_400, endMs: 600_000 },
    ]);
  });

  it('returns an empty list when no silence was found', () => {
    expect(parseSilenceDetect('size=N/A time=00:00:05', 5_000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/ffmpeg.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement**

`src/core/tools/ffmpeg.ts`:
```ts
import { BgtError } from '../errors';
import type { SilenceInterval } from '../pipeline/chunker';
import { runProcess } from './process';

const seconds = (ms: number) => (ms / 1000).toFixed(3);
const COMMON = ['-hide_banner', '-nostdin', '-y'];

const tail = (text: string, lines = 5) => text.trim().split(/\r?\n/).slice(-lines).join('\n');

export function parseFfmpegDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

export function parseSilenceDetect(stderr: string, totalMs: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let openStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      openStart = Math.max(0, Math.round(Number(start[1]) * 1000));
    } else if (end && openStart !== null) {
      intervals.push({ startMs: openStart, endMs: Math.round(Number(end[1]) * 1000) });
      openStart = null;
    }
  }
  if (openStart !== null) intervals.push({ startMs: openStart, endMs: totalMs });
  return intervals;
}

export async function probeDurationMs(a: {
  ffmpegPath: string;
  file: string;
  signal?: AbortSignal;
}): Promise<number> {
  // ffmpeg exits non-zero without an output file, but still prints the input info.
  const r = await runProcess(a.ffmpegPath, ['-hide_banner', '-nostdin', '-i', a.file], {
    signal: a.signal,
  });
  const ms = parseFfmpegDuration(r.stderr);
  if (ms === null) {
    throw new BgtError(
      'InvalidInput',
      `Could not read a duration from "${a.file}". Is it a valid audio/video file?\n${tail(r.stderr, 3)}`,
    );
  }
  return ms;
}

export async function toWav16kMono(a: {
  ffmpegPath: string;
  input: string;
  output: string;
  startMs?: number;
  endMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const range: string[] = [];
  if (a.startMs !== undefined && a.startMs > 0) range.push('-ss', seconds(a.startMs));
  if (a.endMs !== undefined) range.push('-t', seconds(a.endMs - (a.startMs ?? 0)));
  const args = [
    ...COMMON,
    ...range,
    '-i',
    a.input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    a.output,
  ];
  const r = await runProcess(a.ffmpegPath, args, { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('InvalidInput', `ffmpeg could not convert "${a.input}":\n${tail(r.stderr)}`);
  }
}

export async function detectSilences(a: {
  ffmpegPath: string;
  wavPath: string;
  totalMs: number;
  signal?: AbortSignal;
}): Promise<SilenceInterval[]> {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i',
    a.wavPath,
    '-af',
    'silencedetect=noise=-35dB:d=0.4',
    '-f',
    'null',
    '-',
  ];
  const r = await runProcess(a.ffmpegPath, args, { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('InvalidInput', `ffmpeg silence detection failed:\n${tail(r.stderr)}`);
  }
  return parseSilenceDetect(r.stderr, a.totalMs);
}

export async function cutWav(a: {
  ffmpegPath: string;
  wavPath: string;
  startMs: number;
  endMs: number;
  outPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const args = [
    ...COMMON,
    '-ss',
    seconds(a.startMs),
    '-t',
    seconds(a.endMs - a.startMs),
    '-i',
    a.wavPath,
    '-c:a',
    'pcm_s16le',
    a.outPath,
  ];
  const r = await runProcess(a.ffmpegPath, args, { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('InvalidInput', `ffmpeg could not cut a chunk:\n${tail(r.stderr)}`);
  }
}
```

- [ ] **Step 4: Run to verify it passes, then smoke the real ffmpeg**

Run: `pnpm test tests/core/ffmpeg.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

Smoke (uses the ffmpeg on PATH, no repo files created):
```bash
ffmpeg -hide_banner -f lavfi -i "sine=frequency=440:duration=3" -ar 16000 -ac 1 "$TEMP/bgt-smoke.wav" -y
ffmpeg -hide_banner -i "$TEMP/bgt-smoke.wav" 2>&1 | grep Duration
```
Expected: a `Duration: 00:00:03.0x` line (confirms the format the parser targets).

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/ffmpeg.ts tests/core/ffmpeg.test.ts
git commit -m "feat(core): ffmpeg wrapper (probe, convert, silencedetect, cut)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: yt-dlp wrapper

**Files:**
- Create: `src/core/tools/ytdlp.ts`
- Test: `tests/core/ytdlp.test.ts`

**Interfaces:**
- Consumes: `runProcess`, `BgtError`, `formatClockMs` (Task 3).
- Produces:
  - `buildProbeArgs(url: string): string[]`
  - `buildDownloadArgs(a: { url: string; outTemplate: string; ffmpegPath: string; section: { startMs: number; endMs: number } | null }): string[]`
  - `getDurationMs(a: { ytdlpPath: string; url: string; signal?: AbortSignal }): Promise<number>`
  - `downloadAudio(a: { ytdlpPath: string; ffmpegPath: string; url: string; workDir: string; section: { startMs: number; endMs: number } | null; signal?: AbortSignal }): Promise<string>` (returns the downloaded file path, `workDir/source.<ext>`)
  - `updateYtDlp(ytdlpPath: string): Promise<string>` (returns yt-dlp's output)

- [ ] **Step 1: Write the failing tests**

`tests/core/ytdlp.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildDownloadArgs, buildProbeArgs } from '../../src/core/tools/ytdlp';

const url = 'https://www.youtube.com/watch?v=abc123&list=PLxyz&index=4';

describe('buildProbeArgs', () => {
  it('never expands a playlist and only prints the duration', () => {
    const args = buildProbeArgs(url);
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--skip-download');
    expect(args.slice(args.indexOf('--print'), args.indexOf('--print') + 2)).toEqual(['--print', 'duration']);
    expect(args[args.length - 1]).toBe(url);
  });
});

describe('buildDownloadArgs', () => {
  const base = { url, outTemplate: 'work/1/source.%(ext)s', ffmpegPath: 'C:/tools/ffmpeg.exe' };

  it('never expands a playlist, picks audio, and points at ffmpeg', () => {
    const args = buildDownloadArgs({ ...base, section: null });
    expect(args).toContain('--no-playlist');
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('bestaudio/best');
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('C:/tools/ffmpeg.exe');
    expect(args[args.indexOf('-o') + 1]).toBe('work/1/source.%(ext)s');
    expect(args[args.length - 1]).toBe(url);
    expect(args).not.toContain('--download-sections');
  });

  it('adds an exact section with forced cuts when a range is requested', () => {
    const args = buildDownloadArgs({ ...base, section: { startMs: 4_800_000, endMs: 6_600_000 } });
    expect(args[args.indexOf('--download-sections') + 1]).toBe('*1:20:00.000-1:50:00.000');
    expect(args).toContain('--force-keyframes-at-cuts');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/ytdlp.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement**

`src/core/tools/ytdlp.ts`:
```ts
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../errors';
import { formatClockMs } from '../time';
import { runProcess } from './process';

export interface Section {
  startMs: number;
  endMs: number;
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';

export function buildProbeArgs(url: string): string[] {
  return ['--no-playlist', '--skip-download', '--no-warnings', '--print', 'duration', url];
}

export function buildDownloadArgs(a: {
  url: string;
  outTemplate: string;
  ffmpegPath: string;
  section: Section | null;
}): string[] {
  const args = [
    '--no-playlist',
    '--no-progress',
    '-f',
    'bestaudio/best',
    '--ffmpeg-location',
    a.ffmpegPath,
  ];
  if (a.section) {
    args.push(
      '--download-sections',
      `*${formatClockMs(a.section.startMs)}-${formatClockMs(a.section.endMs)}`,
      '--force-keyframes-at-cuts',
    );
  }
  args.push('-o', a.outTemplate, a.url);
  return args;
}

const HINT =
  'YouTube changes often: try "pnpm bgt update-ytdlp", or download the audio yourself and pass the file path instead.';

export async function getDurationMs(a: {
  ytdlpPath: string;
  url: string;
  signal?: AbortSignal;
}): Promise<number> {
  const r = await runProcess(a.ytdlpPath, buildProbeArgs(a.url), { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('DownloadFailed', `yt-dlp could not read the video: ${lastLine(r.stderr)}. ${HINT}`);
  }
  const seconds = Number.parseFloat(lastLine(r.stdout));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new BgtError(
      'InvalidInput',
      'The video has no known duration (live streams are not supported yet).',
    );
  }
  return Math.round(seconds * 1000);
}

export async function downloadAudio(a: {
  ytdlpPath: string;
  ffmpegPath: string;
  url: string;
  workDir: string;
  section: Section | null;
  signal?: AbortSignal;
}): Promise<string> {
  // Stale files from an interrupted earlier attempt must not be mistaken for this download.
  for (const name of readdirSync(a.workDir)) {
    if (name.startsWith('source.')) rmSync(path.join(a.workDir, name), { force: true });
  }

  const args = buildDownloadArgs({
    url: a.url,
    outTemplate: path.join(a.workDir, 'source.%(ext)s'),
    ffmpegPath: a.ffmpegPath,
    section: a.section,
  });
  const r = await runProcess(a.ytdlpPath, args, { signal: a.signal });
  if (r.code !== 0) {
    throw new BgtError('DownloadFailed', `yt-dlp failed: ${lastLine(r.stderr)}. ${HINT}`);
  }

  const found = readdirSync(a.workDir).find(
    (n) => n.startsWith('source.') && !n.endsWith('.part') && !n.endsWith('.ytdl'),
  );
  if (!found) throw new BgtError('DownloadFailed', 'yt-dlp finished but produced no audio file.');
  return path.join(a.workDir, found);
}

export async function updateYtDlp(ytdlpPath: string): Promise<string> {
  const r = await runProcess(ytdlpPath, ['-U']);
  const output = `${r.stdout}${r.stderr}`.trim();
  if (r.code !== 0) throw new BgtError('DownloadFailed', `yt-dlp update failed:\n${output}`);
  return output;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/ytdlp.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/ytdlp.ts tests/core/ytdlp.test.ts
git commit -m "feat(core): yt-dlp wrapper with section download and playlist guard

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: whisper.cpp transcription backend

**Files:**
- Create: `src/core/backends/transcribe/whispercpp.ts`
- Test: `tests/core/whispercpp.test.ts`

**Interfaces:**
- Consumes: `Transcriber`, `TranscribeOptions` (Task 2), `Segment`, `runProcess`, `BgtError`.
- Produces:
  - `buildWhisperArgs(a: { modelPath: string; audioPath: string; outPrefix: string; language: string; vadModelPath: string | null; threads?: number }): string[]`
  - `parseWhisperJson(raw: string, fallbackLang: string): Segment[]`
  - `class WhisperCppTranscriber implements Transcriber` with `constructor(cfg: { whisperPath: string; modelPath: string; vadModelPath: string | null; threads?: number })`

The JSON shape (`-ojf`: `transcription[].offsets.{from,to}` in ms, `text`, `tokens[].{text,p}`) is an assumption from whisper.cpp's documented output; Task 15 verifies it against the real binary and adjusts `parseWhisperJson` if it differs.

- [ ] **Step 1: Write the failing tests**

`tests/core/whispercpp.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildWhisperArgs, parseWhisperJson } from '../../src/core/backends/transcribe/whispercpp';

describe('buildWhisperArgs', () => {
  const base = {
    modelPath: 'C:/r/models/ggml-large-v3.bin',
    audioPath: 'C:/data/work/1/chunk-000.wav',
    outPrefix: 'C:/data/work/1/chunk-000.whisper',
    language: 'ja',
  };

  it('requests full JSON, the language, and VAD when a VAD model is given', () => {
    const args = buildWhisperArgs({ ...base, vadModelPath: 'C:/r/models/ggml-silero.bin' });
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', base.modelPath]);
    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2)).toEqual(['-f', base.audioPath]);
    expect(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2)).toEqual(['-l', 'ja']);
    expect(args).toContain('-ojf');
    expect(args.slice(args.indexOf('-of'), args.indexOf('-of') + 2)).toEqual(['-of', base.outPrefix]);
    expect(args).toContain('--vad');
    expect(args[args.indexOf('--vad-model') + 1]).toBe('C:/r/models/ggml-silero.bin');
  });

  it('omits VAD flags without a VAD model and adds threads when given', () => {
    const args = buildWhisperArgs({ ...base, vadModelPath: null, threads: 8 });
    expect(args).not.toContain('--vad');
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '8']);
  });
});

describe('parseWhisperJson', () => {
  const sample = JSON.stringify({
    result: { language: 'ja' },
    transcription: [
      {
        offsets: { from: 1000, to: 3500 },
        text: ' こんにちは',
        tokens: [
          { text: '[_BEG_]', p: 0.9 },
          { text: 'こんにちは', p: 0.5 },
          { text: '。', p: 0.25 },
        ],
      },
      { offsets: { from: 4000, to: 5000 }, text: ' 次です' },
      { offsets: { from: 6000, to: 6500 }, text: '   ', tokens: [] },
    ],
  });

  it('maps offsets, trims text, and averages token log-probabilities (skipping special tokens)', () => {
    const segs = parseWhisperJson(sample, 'ja');
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ startMs: 1000, endMs: 3500, text: 'こんにちは', lang: 'ja' });
    expect(segs[0].avgLogprob).toBeCloseTo((Math.log(0.5) + Math.log(0.25)) / 2, 5);
  });

  it('uses null confidence when tokens are absent or empty', () => {
    const segs = parseWhisperJson(sample, 'ja');
    expect(segs[1].avgLogprob).toBeNull();
    expect(segs[2].avgLogprob).toBeNull();
  });

  it('falls back to the requested language and tolerates an empty transcription', () => {
    expect(parseWhisperJson(JSON.stringify({ transcription: [] }), 'ja')).toEqual([]);
    const segs = parseWhisperJson(
      JSON.stringify({ transcription: [{ offsets: { from: 0, to: 10 }, text: 'x' }] }),
      'ja',
    );
    expect(segs[0].lang).toBe('ja');
  });

  it('throws TranscribeFailed on invalid JSON', () => {
    expect(() => parseWhisperJson('not json', 'ja')).toThrow(
      expect.objectContaining({ code: 'TranscribeFailed' }),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/whispercpp.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement**

`src/core/backends/transcribe/whispercpp.ts`:
```ts
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../../errors';
import type { Transcriber, TranscribeOptions } from '../../interfaces';
import { runProcess } from '../../tools/process';
import type { Segment } from '../../types';

export function buildWhisperArgs(a: {
  modelPath: string;
  audioPath: string;
  outPrefix: string;
  language: string;
  vadModelPath: string | null;
  threads?: number;
}): string[] {
  const args = ['-m', a.modelPath, '-f', a.audioPath, '-l', a.language, '-ojf', '-of', a.outPrefix];
  if (a.vadModelPath) args.push('--vad', '--vad-model', a.vadModelPath);
  if (a.threads) args.push('-t', String(a.threads));
  return args;
}

interface WhisperToken {
  text: string;
  p?: number;
}
interface WhisperEntry {
  offsets: { from: number; to: number };
  text: string;
  tokens?: WhisperToken[];
}
interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperEntry[];
}

const SPECIAL_TOKEN = /^\[_.*_\]$/;

function avgLogprob(tokens: WhisperToken[] | undefined): number | null {
  const probs = (tokens ?? [])
    .filter((t) => !SPECIAL_TOKEN.test(t.text) && typeof t.p === 'number')
    .map((t) => Math.log(Math.max(t.p as number, 1e-9)));
  if (probs.length === 0) return null;
  return probs.reduce((sum, v) => sum + v, 0) / probs.length;
}

export function parseWhisperJson(raw: string, fallbackLang: string): Segment[] {
  let data: WhisperJson;
  try {
    data = JSON.parse(raw) as WhisperJson;
  } catch (cause) {
    throw new BgtError('TranscribeFailed', 'whisper-cli produced invalid JSON output.', { cause });
  }
  const lang = data.result?.language ?? fallbackLang;
  return (data.transcription ?? []).map((entry) => ({
    startMs: entry.offsets.from,
    endMs: entry.offsets.to,
    text: entry.text.trim(),
    lang,
    avgLogprob: avgLogprob(entry.tokens),
  }));
}

export interface WhisperCppConfig {
  whisperPath: string;
  modelPath: string;
  vadModelPath: string | null;
  threads?: number;
}

const tail = (text: string, lines = 8) => text.trim().split(/\r?\n/).slice(-lines).join('\n');

export class WhisperCppTranscriber implements Transcriber {
  constructor(private readonly cfg: WhisperCppConfig) {}

  async transcribe(audioPath: string, opts: TranscribeOptions): Promise<Segment[]> {
    const base = path.basename(audioPath, path.extname(audioPath));
    const outPrefix = path.join(path.dirname(audioPath), `${base}.whisper`);
    const jsonPath = `${outPrefix}.json`;
    rmSync(jsonPath, { force: true });

    const result = await runProcess(
      this.cfg.whisperPath,
      buildWhisperArgs({
        modelPath: this.cfg.modelPath,
        audioPath,
        outPrefix,
        language: opts.language,
        vadModelPath: this.cfg.vadModelPath,
        threads: this.cfg.threads,
      }),
      { signal: opts.signal },
    );
    if (result.code !== 0) {
      throw new BgtError(
        'TranscribeFailed',
        `whisper-cli exited with code ${result.code}:\n${tail(result.stderr)}`,
      );
    }
    if (!existsSync(jsonPath)) {
      throw new BgtError('TranscribeFailed', `whisper-cli produced no output file at ${jsonPath}.`);
    }
    return parseWhisperJson(readFileSync(jsonPath, 'utf8'), opts.language);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/whispercpp.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/backends tests/core/whispercpp.test.ts
git commit -m "feat(core): whisper.cpp transcriber backend

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Tool lock, downloader, and pin/fetch scripts

**Files:**
- Create: `src/core/tools/lock.ts`, `src/core/tools/fetch.ts`, `scripts/fetch-tools.ts`, `scripts/pin-tools.ts`
- Test: `tests/core/fetch.test.ts`

**Interfaces:**
- Consumes: `BgtError`, `resourcesDir` (Task 8).
- Produces:
  - `interface LockEntry { id: string; version: string; url: string; sha256: string; kind: 'file' | 'zip'; dest: string }`, `interface Lock { platform: 'win32-x64'; tools: LockEntry[] }`, `loadLock(file: string): Lock`
  - `sha256File(file: string): Promise<string>`
  - `downloadFile(url: string, dest: string, onProgress?: (received: number, total: number) => void): Promise<void>`
  - `fetchEntry(entry: LockEntry, resources: string, log: (m: string) => void, onProgress?): Promise<void>` (skips when already valid; verifies the SHA-256; zips extract into `dest` with a `.sha256` marker)

- [ ] **Step 1: Write the failing tests**

`tests/core/fetch.test.ts`:
```ts
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadFile, fetchEntry, sha256File } from '../../src/core/tools/fetch';
import type { LockEntry } from '../../src/core/tools/lock';

const payload = Buffer.from('hello model bytes');
const payloadSha = createHash('sha256').update(payload).digest('hex');

let server: http.Server;
let base: string;
let hits = 0;
let dir: string;

beforeEach(async () => {
  hits = 0;
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-fetch-'));
  server = http.createServer((_req, res) => {
    hits++;
    res.setHeader('content-length', payload.length);
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<LockEntry> = {}): LockEntry => ({
  id: 'model',
  version: '1',
  url: `${base}/m.bin`,
  sha256: payloadSha,
  kind: 'file',
  dest: 'models/m.bin',
  ...overrides,
});

describe('downloadFile / sha256File', () => {
  it('downloads atomically and reports progress', async () => {
    const dest = path.join(dir, 'a', 'm.bin');
    const seen: number[] = [];
    await downloadFile(`${base}/m.bin`, dest, (received) => seen.push(received));
    expect(readFileSync(dest)).toEqual(payload);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(payload.length);
    expect(await sha256File(dest)).toBe(payloadSha);
  });
});

describe('fetchEntry', () => {
  it('downloads a file, then skips it when the checksum already matches', async () => {
    const log = () => {};
    await fetchEntry(entry(), dir, log);
    expect(readFileSync(path.join(dir, 'models', 'm.bin'))).toEqual(payload);
    expect(hits).toBe(1);
    await fetchEntry(entry(), dir, log);
    expect(hits).toBe(1);
  });

  it('rejects and removes a download whose checksum does not match', async () => {
    await expect(fetchEntry(entry({ sha256: 'deadbeef' }), dir, () => {})).rejects.toThrow(/checksum/i);
    expect(existsSync(path.join(dir, 'models', 'm.bin'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/fetch.test.ts`
Expected: FAIL, cannot resolve modules.

- [ ] **Step 3: Implement the library code**

`src/core/tools/lock.ts`:
```ts
import { readFileSync } from 'node:fs';

export interface LockEntry {
  id: string;
  version: string;
  url: string;
  sha256: string;
  kind: 'file' | 'zip';
  /** Path relative to the resources directory (a file for 'file', a folder for 'zip'). */
  dest: string;
}

export interface Lock {
  platform: 'win32-x64';
  tools: LockEntry[];
}

export function loadLock(file: string): Lock {
  return JSON.parse(readFileSync(file, 'utf8')) as Lock;
}
```

`src/core/tools/fetch.ts`:
```ts
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import extract from 'extract-zip';
import { BgtError } from '../errors';
import type { LockEntry } from './lock';

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'bg-auto-translator' } });
  if (!res.ok || !res.body) {
    throw new BgtError('DownloadFailed', `GET ${url} failed with HTTP ${res.status}.`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const part = `${dest}.part`;
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      onProgress?.(received, total);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream),
    counter,
    createWriteStream(part),
  );
  renameSync(part, dest);
}

async function verified(file: string, entry: LockEntry): Promise<void> {
  const actual = await sha256File(file);
  if (actual !== entry.sha256) {
    rmSync(file, { force: true });
    throw new BgtError(
      'DownloadFailed',
      `Checksum mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}.`,
    );
  }
}

export async function fetchEntry(
  entry: LockEntry,
  resources: string,
  log: (message: string) => void,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  const dest = path.join(resources, entry.dest);

  if (entry.kind === 'file') {
    if (existsSync(dest) && (await sha256File(dest)) === entry.sha256) {
      log(`${entry.id}: up to date`);
      return;
    }
    log(`${entry.id}: downloading ${entry.version}`);
    await downloadFile(entry.url, dest, onProgress);
    await verified(dest, entry);
    return;
  }

  const marker = path.join(dest, '.sha256');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === entry.sha256) {
    log(`${entry.id}: up to date`);
    return;
  }
  log(`${entry.id}: downloading ${entry.version}`);
  const zip = path.join(resources, `${entry.id}.zip`);
  await downloadFile(entry.url, zip, onProgress);
  await verified(zip, entry);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  await extract(zip, { dir: path.resolve(dest) });
  writeFileSync(marker, entry.sha256);
  rmSync(zip, { force: true });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test tests/core/fetch.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Write the scripts**

`scripts/fetch-tools.ts`:
```ts
import path from 'node:path';
import { fetchEntry } from '../src/core/tools/fetch';
import { loadLock } from '../src/core/tools/lock';
import { projectRoot, resourcesDir } from '../src/core/tools/paths';

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.error('setup:tools currently supports Windows x64 only. Install yt-dlp, ffmpeg and whisper.cpp manually.');
    process.exit(1);
  }
  const lock = loadLock(path.join(projectRoot(), 'tools.lock.json'));
  for (const entry of lock.tools) {
    let lastPercent = -1;
    await fetchEntry(entry, resourcesDir(), console.log, (received, total) => {
      if (!total) return;
      const percent = Math.floor((received / total) * 100);
      if (percent !== lastPercent && percent % 5 === 0) {
        lastPercent = percent;
        process.stdout.write(`\r  ${entry.id}: ${percent}%   `);
        if (percent === 100) process.stdout.write('\n');
      }
    });
  }
  console.log('Done. Run "pnpm bgt doctor" to verify.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

`scripts/pin-tools.ts` (resolves the latest releases and writes `tools.lock.json`; run on demand, review the diff before committing):
```ts
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Lock, LockEntry } from '../src/core/tools/lock';
import { projectRoot } from '../src/core/tools/paths';

const headers = { 'User-Agent': 'bg-auto-translator', Accept: 'application/json' };

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

async function hfFile(repo: string, pick: (name: string) => boolean): Promise<{ name: string; url: string; sha256: string; rev: string }> {
  const info = await getJson<{ sha: string }>(`https://huggingface.co/api/models/${repo}`);
  const tree = await getJson<HfTreeItem[]>(`https://huggingface.co/api/models/${repo}/tree/${info.sha}`);
  const matches = tree.filter((t) => t.lfs && pick(t.path)).sort((a, b) => a.path.localeCompare(b.path));
  const item = matches.at(-1);
  if (!item?.lfs) throw new Error(`No matching file in ${repo}`);
  return {
    name: item.path,
    url: `https://huggingface.co/${repo}/resolve/${info.sha}/${item.path}`,
    sha256: item.lfs.oid,
    rev: info.sha.slice(0, 7),
  };
}

async function main() {
  const tools: LockEntry[] = [];

  // yt-dlp
  const yt = await getJson<GhRelease>('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
  const sums = await getText(`https://github.com/yt-dlp/yt-dlp/releases/download/${yt.tag_name}/SHA2-256SUMS`);
  const ytSum = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find(([, name]) => name === 'yt-dlp.exe')?.[0];
  if (!ytSum) throw new Error('yt-dlp.exe not found in SHA2-256SUMS');
  tools.push({
    id: 'yt-dlp',
    version: yt.tag_name,
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${yt.tag_name}/yt-dlp.exe`,
    sha256: ytSum,
    kind: 'file',
    dest: 'bin/yt-dlp.exe',
  });

  // whisper.cpp: prefer the CUDA build, fall back to CPU
  const wh = await getJson<GhRelease>('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest');
  const cuda = wh.assets.filter((a) => /^whisper-cublas-.+-bin-x64\.zip$/.test(a.name)).sort((a, b) => a.name.localeCompare(b.name)).at(-1);
  const cpu = wh.assets.find((a) => a.name === 'whisper-bin-x64.zip');
  const asset = cuda ?? cpu;
  if (!asset) throw new Error(`No Windows x64 whisper.cpp asset in ${wh.tag_name}: ${wh.assets.map((a) => a.name).join(', ')}`);
  if (!cuda) console.warn('WARNING: no CUDA build in this whisper.cpp release; pinning the CPU build.');
  const whSha = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : await sha256OfUrl(asset.browser_download_url);
  tools.push({
    id: 'whisper.cpp',
    version: `${wh.tag_name} (${asset.name})`,
    url: asset.browser_download_url,
    sha256: whSha,
    kind: 'zip',
    dest: 'whisper',
  });

  // Models
  const large = await hfFile('ggerganov/whisper.cpp', (n) => n === 'ggml-large-v3.bin');
  tools.push({ id: 'model-large-v3', version: large.rev, url: large.url, sha256: large.sha256, kind: 'file', dest: `models/${large.name}` });
  const vad = await hfFile('ggml-org/whisper-vad', (n) => /^ggml-silero-v[\d.]+\.bin$/.test(n));
  tools.push({ id: 'vad-silero', version: vad.rev, url: vad.url, sha256: vad.sha256, kind: 'file', dest: `models/${vad.name}` });

  const lock: Lock = { platform: 'win32-x64', tools };
  const file = path.join(projectRoot(), 'tools.lock.json');
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Wrote ${file}`);
  for (const t of tools) console.log(`  ${t.id}  ${t.version}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 6: Verify scripts compile, then commit**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS (the scripts are executed for real in Task 15).

```bash
git add src/core/tools/lock.ts src/core/tools/fetch.ts scripts tests/core/fetch.test.ts
git commit -m "feat(tools): checksum-verified downloader plus pin and fetch scripts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Pipeline orchestrator (`runJob`) with estimate and outputs

**Files:**
- Create: `src/core/pipeline/estimate.ts`, `src/core/pipeline/outputs.ts`, `src/core/pipeline/run.ts`
- Test: `tests/core/estimate.test.ts`, `tests/helpers/fakes.ts`, `tests/core/run.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-7 (`Repo`, `planChunks`/`CHUNK_DEFAULTS`/`SilenceInterval`, `dropOverlapping`/`filterHallucinations`, `resolveRange`/`formatClock`, `toSrt`, `Transcriber`, `BgtError`).
- Produces:
  - `estimateSeconds(audioMs: number, speedFactor: number | null): number | null`, `formatDuration(seconds: number): string`
  - `interface PerfStore { read(): number | null; write(speedFactor: number): void }`, `createPerfStore(file: string): PerfStore`
  - `writeOutputs(repo: Repo, job: JobRow, outDir: string): { srtPath: string; jsonPath: string }`
  - `interface FetchAudioArgs { source: string; startMs: number; endMs: number; fullDurationMs: number; workDir: string; outWavPath: string; signal?: AbortSignal }`
  - `interface PipelineDeps { repo: Repo; transcriber: Transcriber; perf: PerfStore; log(message: string): void; probeDurationMs(source: string, signal?: AbortSignal): Promise<number>; fetchAudio(a: FetchAudioArgs): Promise<void>; detectSilences(wavPath: string, totalMs: number, signal?: AbortSignal): Promise<SilenceInterval[]>; cutWav(a: { wavPath: string; startMs: number; endMs: number; outPath: string; signal?: AbortSignal }): Promise<void> }`
  - `interface RunParams { source: string; startMs: number; endMs: number | null; maxMinutes: number; model: string; language: string; workRoot: string; outDir: string; keepWork: boolean; signal?: AbortSignal }`
  - `interface RunResult { jobId: number; status: 'done' | 'failed'; failedChunks: number[]; srtPath: string; jsonPath: string }`
  - `const MAX_ATTEMPTS = 3`, `runJob(deps: PipelineDeps, params: RunParams): Promise<RunResult>`
  - Chunk WAVs are named `chunk-000.wav` (3-digit index) inside `workRoot/<jobId>/`; the full audio is `audio.wav`.

- [ ] **Step 1: Write the failing tests for estimate/perf**

`tests/core/estimate.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPerfStore, estimateSeconds, formatDuration } from '../../src/core/pipeline/estimate';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-perf-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('estimateSeconds', () => {
  it('divides audio length by the speed factor, rounding up', () => {
    expect(estimateSeconds(600_000, 10)).toBe(60);
    expect(estimateSeconds(601_000, 10)).toBe(61);
  });
  it('returns null without a usable speed factor', () => {
    expect(estimateSeconds(600_000, null)).toBeNull();
    expect(estimateSeconds(600_000, 0)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(3720)).toBe('1h 02m');
  });
});

describe('createPerfStore', () => {
  it('round-trips a speed factor and tolerates a missing or corrupt file', () => {
    const file = path.join(dir, 'sub', 'perf.json');
    const store = createPerfStore(file);
    expect(store.read()).toBeNull();
    store.write(12.5);
    expect(createPerfStore(file).read()).toBe(12.5);
    writeFileSync(file, '{not json');
    expect(store.read()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/estimate.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement estimate and outputs**

`src/core/pipeline/estimate.ts`:
```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function estimateSeconds(audioMs: number, speedFactor: number | null): number | null {
  if (!speedFactor || speedFactor <= 0) return null;
  return Math.ceil(audioMs / 1000 / speedFactor);
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export interface PerfStore {
  read(): number | null;
  write(speedFactor: number): void;
}

/** Stores audio-seconds transcribed per wall-clock second, measured on previous runs. */
export function createPerfStore(file: string): PerfStore {
  return {
    read() {
      try {
        const value = (JSON.parse(readFileSync(file, 'utf8')) as { speedFactor?: unknown }).speedFactor;
        return typeof value === 'number' && value > 0 ? value : null;
      } catch {
        return null;
      }
    },
    write(speedFactor) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ speedFactor }));
    },
  };
}
```

`src/core/pipeline/outputs.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JobRow, Repo } from '../db/repo';
import { toSrt } from '../subtitles/srt';

/** Writes `job-<id>.<lang>.srt` and `.json`. Times include the job's range offset (video time). */
export function writeOutputs(
  repo: Repo,
  job: JobRow,
  outDir: string,
): { srtPath: string; jsonPath: string } {
  mkdirSync(outDir, { recursive: true });
  const segments = repo.listSegments(job.id).map((s) => ({
    ...s,
    startMs: s.startMs + job.rangeStartMs,
    endMs: s.endMs + job.rangeStartMs,
  }));
  const base = path.join(outDir, `job-${job.id}.${job.settings.language}`);
  const srtPath = `${base}.srt`;
  const jsonPath = `${base}.json`;
  writeFileSync(srtPath, toSrt(segments));
  writeFileSync(jsonPath, JSON.stringify({ job, segments }, null, 2));
  return { srtPath, jsonPath };
}
```

- [ ] **Step 4: Run to verify estimate tests pass**

Run: `pnpm test tests/core/estimate.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the fakes helper and the failing orchestrator tests**

`tests/helpers/fakes.ts`:
```ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Repo } from '../../src/core/db/repo';
import { migrate } from '../../src/core/db/schema';
import type { SilenceInterval } from '../../src/core/pipeline/chunker';
import type { FetchAudioArgs, PipelineDeps } from '../../src/core/pipeline/run';
import type { Segment } from '../../src/core/types';

export function memoryRepo(): Repo {
  const db = new Database(':memory:');
  migrate(db);
  return new Repo(db);
}

export interface FakeOptions {
  durationMs: number;
  silences?: SilenceInterval[];
  /** Ground-truth segments in audio-relative ms; chunks return the ones fully inside their range. */
  truth?: Segment[];
  /** Called before each transcription; throw to simulate failure or abort. */
  onTranscribe?: (chunkFile: string, callNumber: number) => void;
}

export interface Fakes {
  deps: PipelineDeps;
  transcribed: string[];
  fetchCalls: FetchAudioArgs[];
}

export function makeFakeDeps(repo: Repo, opts: FakeOptions): Fakes {
  const ranges = new Map<string, { startMs: number; endMs: number }>();
  const transcribed: string[] = [];
  const fetchCalls: FetchAudioArgs[] = [];

  const deps: PipelineDeps = {
    repo,
    log: () => {},
    perf: { read: () => null, write: () => {} },
    probeDurationMs: async () => opts.durationMs,
    fetchAudio: async (a) => {
      fetchCalls.push(a);
      writeFileSync(a.outWavPath, 'fake-audio');
    },
    detectSilences: async () => opts.silences ?? [],
    cutWav: async (a) => {
      writeFileSync(a.outPath, 'fake-chunk');
      ranges.set(a.outPath, { startMs: a.startMs, endMs: a.endMs });
    },
    transcriber: {
      transcribe: async (audioPath) => {
        const file = path.basename(audioPath);
        transcribed.push(file);
        opts.onTranscribe?.(file, transcribed.filter((f) => f === file).length);
        const range = ranges.get(audioPath) as { startMs: number; endMs: number };
        return (opts.truth ?? [])
          .filter((s) => s.startMs >= range.startMs && s.endMs <= range.endMs)
          .map((s) => ({ ...s, startMs: s.startMs - range.startMs, endMs: s.endMs - range.startMs }));
      },
    },
  };
  return { deps, transcribed, fetchCalls };
}
```

`tests/core/run.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runJob, type RunParams } from '../../src/core/pipeline/run';
import type { Segment } from '../../src/core/types';
import { makeFakeDeps, memoryRepo } from '../helpers/fakes';

const seg = (text: string, startMs: number, endMs: number): Segment => ({
  startMs,
  endMs,
  text,
  lang: 'ja',
  avgLogprob: -0.3,
});

// 40 min of audio, silence at 14:30-14:40 => chunk boundaries 875_000 and 1_775_000 (forced).
const TRUTH = [
  seg('A', 100_000, 102_000),
  seg('B', 874_000, 875_000), // inside the overlap: present in chunk 0 AND chunk 1
  seg('C', 880_000, 882_000),
];
const LONG = {
  durationMs: 2_400_000,
  silences: [{ startMs: 870_000, endMs: 880_000 }],
  truth: TRUTH,
};

let root: string;
const params = (over: Partial<RunParams> = {}): RunParams => ({
  source: 'https://www.youtube.com/watch?v=abc',
  startMs: 0,
  endMs: 1_800_000, // 30 min == cap
  maxMinutes: 30,
  model: 'large-v3',
  language: 'ja',
  workRoot: path.join(root, 'work'),
  outDir: path.join(root, 'out'),
  keepWork: true,
  ...over,
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-run-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runJob', () => {
  it('runs end to end, dedupes the overlap (earlier chunk wins) and writes the SRT', async () => {
    const repo = memoryRepo();
    const { deps, transcribed } = makeFakeDeps(repo, { ...LONG, durationMs: 1_800_000 });
    const result = await runJob(deps, params({ endMs: 1_800_000 }));

    expect(result.status).toBe('done');
    expect(result.failedChunks).toEqual([]);
    expect(transcribed).toEqual(['chunk-000.wav', 'chunk-001.wav']);
    expect(repo.listSegments(result.jobId).map((s) => s.text)).toEqual(['A', 'B', 'C']);

    const srt = readFileSync(result.srtPath, 'utf8');
    expect(srt).toContain('00:01:40,000 --> 00:01:42,000\nA');
    expect(srt.match(/\nB\n/g)).toHaveLength(1);
    expect(existsSync(result.jsonPath)).toBe(true);
  });

  it('adds the range start to subtitle times and passes the range to the fetcher', async () => {
    const repo = memoryRepo();
    const { deps, fetchCalls } = makeFakeDeps(repo, {
      durationMs: 600_000,
      truth: [seg('hi', 1_000, 2_000)],
    });
    const result = await runJob(deps, params({ startMs: 60_000, endMs: 360_000 }));
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({ startMs: 60_000, endMs: 360_000, fullDurationMs: 600_000 });
    expect(readFileSync(result.srtPath, 'utf8')).toContain('00:01:01,000 --> 00:01:02,000\nhi');
  });

  it('fails with OverCap before creating a job or downloading anything', async () => {
    const repo = memoryRepo();
    const { deps, fetchCalls } = makeFakeDeps(repo, LONG);
    await expect(runJob(deps, params({ endMs: null }))).rejects.toMatchObject({ code: 'OverCap' });
    expect(fetchCalls).toHaveLength(0);
    expect(repo.getJob(1)).toBeUndefined();
  });

  it('completes a music/silence-only chunk with no segments and still writes a valid SRT', async () => {
    const repo = memoryRepo();
    const { deps } = makeFakeDeps(repo, { durationMs: 600_000, truth: [] });
    const result = await runJob(deps, params({ endMs: null, source: '/tmp/music.wav' }));
    expect(result.status).toBe('done');
    expect(repo.listChunks(result.jobId)[0].status).toBe('done');
    expect(readFileSync(result.srtPath, 'utf8')).toBe('');
  });

  it('resumes after an abort without re-transcribing finished chunks', async () => {
    const repo = memoryRepo();
    const controller = new AbortController();
    const first = makeFakeDeps(repo, {
      ...LONG,
      durationMs: 1_800_000,
      onTranscribe: (file) => {
        if (file === 'chunk-001.wav') {
          controller.abort();
          throw controller.signal.reason;
        }
      },
    });
    await expect(runJob(first.deps, params({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(first.transcribed).toEqual(['chunk-000.wav', 'chunk-001.wav']);
    expect(repo.listChunks(1).map((c) => c.status)).toEqual(['done', 'pending']);

    const second = makeFakeDeps(repo, { ...LONG, durationMs: 1_800_000 });
    const result = await runJob(second.deps, params());
    expect(result.jobId).toBe(1);
    expect(result.status).toBe('done');
    expect(second.transcribed).toEqual(['chunk-001.wav']);
    expect(second.fetchCalls).toHaveLength(0); // audio.wav already complete
    expect(repo.listSegments(1).map((s) => s.text)).toEqual(['A', 'B', 'C']);
  });

  it('does not treat a partial download as complete audio', async () => {
    const repo = memoryRepo();
    const controller = new AbortController();
    const first = makeFakeDeps(repo, { durationMs: 600_000 });
    first.deps.fetchAudio = async (a) => {
      // leaves a truncated file at the temporary path, then dies
      await import('node:fs').then((fs) => fs.writeFileSync(a.outWavPath, 'trunc'));
      controller.abort();
      throw controller.signal.reason;
    };
    await expect(runJob(first.deps, params({ endMs: null, signal: controller.signal }))).rejects.toBeDefined();
    expect(existsSync(path.join(root, 'work', '1', 'audio.wav'))).toBe(false);

    const second = makeFakeDeps(repo, { durationMs: 600_000 });
    await runJob(second.deps, params({ endMs: null }));
    expect(second.fetchCalls).toHaveLength(1);
  });

  it('retries a failing chunk 3 times, marks it failed, continues, and recovers on re-run', async () => {
    const repo = memoryRepo();
    let broken = true;
    const first = makeFakeDeps(repo, {
      ...LONG,
      onTranscribe: (file) => {
        if (broken && file === 'chunk-001.wav') throw new Error('whisper crashed');
      },
    });
    const result = await runJob(first.deps, params({ startMs: 0, endMs: 1_800_000 }));
    // 30-min request, 40-min video: chunks planned over 30 min -> 2 chunks
    expect(result.status).toBe('failed');
    expect(result.failedChunks).toEqual([1]);
    expect(first.transcribed.filter((f) => f === 'chunk-001.wav')).toHaveLength(3);
    expect(repo.listChunks(result.jobId)[1]).toMatchObject({ status: 'failed', error: 'whisper crashed' });
    expect(repo.getJob(result.jobId)?.status).toBe('failed');

    broken = false;
    const second = makeFakeDeps(repo, LONG);
    const again = await runJob(second.deps, params({ startMs: 0, endMs: 1_800_000 }));
    expect(again.jobId).toBe(result.jobId);
    expect(again.status).toBe('done');
    expect(second.transcribed).toEqual(['chunk-001.wav']);
  });

  it('removes the work dir on success unless keepWork is set', async () => {
    const repo = memoryRepo();
    const a = makeFakeDeps(repo, { durationMs: 600_000 });
    const done = await runJob(a.deps, params({ endMs: null, keepWork: false }));
    expect(existsSync(path.join(root, 'work', String(done.jobId)))).toBe(false);
    expect(existsSync(done.srtPath)).toBe(true);
  });

  it('records the measured speed factor', async () => {
    const repo = memoryRepo();
    const { deps } = makeFakeDeps(repo, { durationMs: 600_000 });
    let stored: number | null = null;
    deps.perf = { read: () => null, write: (v) => (stored = v) };
    await runJob(deps, params({ endMs: null }));
    expect(stored).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm test tests/core/run.test.ts`
Expected: FAIL, cannot resolve `../../src/core/pipeline/run`.

- [ ] **Step 7: Implement the orchestrator**

`src/core/pipeline/run.ts`:
```ts
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { JobRow, Repo } from '../db/repo';
import type { Transcriber } from '../interfaces';
import { formatClock, resolveRange } from '../time';
import { CHUNK_DEFAULTS, planChunks, type SilenceInterval } from './chunker';
import { estimateSeconds, formatDuration, type PerfStore } from './estimate';
import { writeOutputs } from './outputs';
import { dropOverlapping, filterHallucinations } from './segment-cleanup';

export const MAX_ATTEMPTS = 3;

export interface FetchAudioArgs {
  source: string;
  startMs: number;
  endMs: number;
  fullDurationMs: number;
  workDir: string;
  /** The implementation must write a complete 16 kHz mono WAV covering exactly [startMs, endMs] here. */
  outWavPath: string;
  signal?: AbortSignal;
}

export interface PipelineDeps {
  repo: Repo;
  transcriber: Transcriber;
  perf: PerfStore;
  log(message: string): void;
  probeDurationMs(source: string, signal?: AbortSignal): Promise<number>;
  fetchAudio(a: FetchAudioArgs): Promise<void>;
  detectSilences(wavPath: string, totalMs: number, signal?: AbortSignal): Promise<SilenceInterval[]>;
  cutWav(a: {
    wavPath: string;
    startMs: number;
    endMs: number;
    outPath: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export interface RunParams {
  source: string;
  startMs: number;
  endMs: number | null;
  maxMinutes: number;
  model: string;
  language: string;
  workRoot: string;
  outDir: string;
  keepWork: boolean;
  signal?: AbortSignal;
}

export interface RunResult {
  jobId: number;
  status: 'done' | 'failed';
  failedChunks: number[];
  srtPath: string;
  jsonPath: string;
}

async function processChunk(
  deps: PipelineDeps,
  params: RunParams,
  job: JobRow,
  chunk: { idx: number; startMs: number; endMs: number },
  workDir: string,
): Promise<boolean> {
  const { repo, log } = deps;
  const chunkWav = path.join(workDir, `chunk-${String(chunk.idx).padStart(3, '0')}.wav`);
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    params.signal?.throwIfAborted();
    repo.markChunkRunning(job.id, chunk.idx);
    try {
      await deps.cutWav({
        wavPath: path.join(workDir, 'audio.wav'),
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        outPath: chunkWav,
        signal: params.signal,
      });
      const raw = await deps.transcriber.transcribe(chunkWav, {
        language: params.language,
        signal: params.signal,
      });
      const shifted = raw.map((s) => ({
        ...s,
        startMs: s.startMs + chunk.startMs,
        endMs: s.endMs + chunk.startMs,
      }));
      const cutoff = repo.maxSegmentEndBefore(job.id, chunk.idx);
      const deduped = cutoff === null ? shifted : dropOverlapping(shifted, cutoff);
      repo.completeChunk(job.id, chunk.idx, filterHallucinations(deduped));
      return true;
    } catch (err) {
      if (params.signal?.aborted) {
        repo.markChunkPending(job.id, chunk.idx);
        throw err;
      }
      lastError = err instanceof Error ? err.message : String(err);
      log(`Chunk ${chunk.idx + 1}: attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError}`);
    }
  }
  repo.markChunkFailed(job.id, chunk.idx, lastError);
  return false;
}

export async function runJob(deps: PipelineDeps, params: RunParams): Promise<RunResult> {
  const { repo, log } = deps;
  const { signal } = params;

  const durationMs = await deps.probeDurationMs(params.source, signal);
  const range = resolveRange({
    startMs: params.startMs,
    endMs: params.endMs,
    durationMs,
    maxMinutes: params.maxMinutes,
  });

  let job = repo.findResumableJob(params.source, range.startMs, range.endMs, params.model);
  if (job) {
    log(`Resuming job ${job.id}`);
  } else {
    job = repo.createJob({
      source: params.source,
      rangeStartMs: range.startMs,
      rangeEndMs: range.endMs,
      settings: { model: params.model, language: params.language, maxMinutes: params.maxMinutes },
    });
  }
  repo.setJobStatus(job.id, 'running');

  const rangeMs = range.endMs - range.startMs;
  const eta = estimateSeconds(rangeMs, deps.perf.read());
  log(
    `Job ${job.id}: ${formatClock(range.startMs)} to ${formatClock(range.endMs)} ` +
      `(${formatDuration(rangeMs / 1000)} of audio). ` +
      (eta === null
        ? 'Time estimate: unknown until a first run measures speed.'
        : `Estimated time: about ${formatDuration(eta)}.`),
  );

  const workDir = path.join(params.workRoot, String(job.id));
  mkdirSync(workDir, { recursive: true });
  const wavPath = path.join(workDir, 'audio.wav');

  if (!existsSync(wavPath)) {
    // Fetch to a temporary name so an interrupted run never leaves a truncated audio.wav behind.
    const partial = path.join(workDir, 'audio.partial.wav');
    rmSync(partial, { force: true });
    log('Fetching audio...');
    await deps.fetchAudio({
      source: params.source,
      startMs: range.startMs,
      endMs: range.endMs,
      fullDurationMs: durationMs,
      workDir,
      outWavPath: partial,
      signal,
    });
    renameSync(partial, wavPath);
  }

  if (repo.listChunks(job.id).length === 0) {
    log('Planning chunks...');
    const silences = await deps.detectSilences(wavPath, rangeMs, signal);
    repo.insertChunks(job.id, planChunks(rangeMs, silences, CHUNK_DEFAULTS));
  }
  repo.resetUnfinishedChunks(job.id);

  const chunks = repo.listChunks(job.id);
  const failedChunks: number[] = [];
  let transcribedMs = 0;
  let wallMs = 0;

  for (const chunk of chunks) {
    if (chunk.status === 'done') continue;
    log(`Chunk ${chunk.idx + 1}/${chunks.length}: ${formatClock(chunk.startMs)} to ${formatClock(chunk.endMs)}`);
    const started = performance.now();
    const ok = await processChunk(deps, params, job, chunk, workDir);
    if (ok) {
      transcribedMs += chunk.endMs - chunk.startMs;
      wallMs += performance.now() - started;
      writeOutputs(repo, job, params.outDir);
    } else {
      failedChunks.push(chunk.idx);
    }
  }

  if (transcribedMs > 0 && wallMs > 0) deps.perf.write(transcribedMs / wallMs);

  const status = failedChunks.length === 0 ? 'done' : 'failed';
  repo.setJobStatus(job.id, status);
  const outputs = writeOutputs(repo, job, params.outDir);
  if (status === 'done' && !params.keepWork) rmSync(workDir, { recursive: true, force: true });
  if (status === 'failed') {
    log(`Chunks ${failedChunks.map((i) => i + 1).join(', ')} failed. Re-run the same command to retry them.`);
  }
  return { jobId: job.id, status, failedChunks, ...outputs };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: ALL tests pass.

Note on the retry test: the request is `0..1_800_000` of a 2_400_000 ms video, so the planner sees 1_800_000 ms of audio and the silence at 870 000 to 880 000 yields cuts at 875 000, giving 2 chunks (`chunk-000.wav`, `chunk-001.wav`). `LONG.truth` segment C (880 000 to 882 000) is inside chunk 1.

- [ ] **Step 9: Commit**

```bash
git add src/core/pipeline tests/core/estimate.test.ts tests/core/run.test.ts tests/helpers
git commit -m "feat(core): resumable chunked pipeline orchestrator

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Real dependency wiring and the CLI

**Files:**
- Create: `src/core/pipeline/real-deps.ts`, `src/cli/index.ts`, `src/cli/run.ts`, `src/cli/doctor.ts`
- Test: `tests/core/real-deps.test.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces:
  - `isUrl(source: string): boolean`
  - `createRealDeps(a: { dataDir: string; model: string; log: (m: string) => void }): { deps: PipelineDeps; workRoot: string; close(): void }`
  - CLI: `bgt run <source> [--start t] [--end t] [--model name] [--out dir] [--max-minutes n] [--keep-work]`, `bgt doctor`, `bgt update-ytdlp`. Exit codes: 0 done, 2 some chunks failed, 130 interrupted, 1 error.

- [ ] **Step 1: Write the failing test (pure helper)**

`tests/core/real-deps.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isUrl } from '../../src/core/pipeline/real-deps';

describe('isUrl', () => {
  it('detects http(s) URLs and treats everything else as a local path', () => {
    expect(isUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isUrl('http://youtu.be/abc')).toBe(true);
    expect(isUrl('C:\\videos\\テスト 音声.wav')).toBe(false);
    expect(isUrl('./clip.mp4')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/core/real-deps.test.ts`
Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement the wiring**

`src/core/pipeline/real-deps.ts`:
```ts
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { WhisperCppTranscriber } from '../backends/transcribe/whispercpp';
import { openDb } from '../db';
import { Repo } from '../db/repo';
import { BgtError } from '../errors';
import { cutWav, detectSilences, probeDurationMs, toWav16kMono } from '../tools/ffmpeg';
import { findVadModel, modelPath, resolveTool } from '../tools/paths';
import { downloadAudio, getDurationMs } from '../tools/ytdlp';
import { createPerfStore } from './estimate';
import type { PipelineDeps } from './run';

export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

export function createRealDeps(a: {
  dataDir: string;
  model: string;
  log: (message: string) => void;
}): { deps: PipelineDeps; workRoot: string; close(): void } {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(a.model)) {
    throw new BgtError('InvalidInput', `Invalid model name "${a.model}".`);
  }
  const db = openDb(path.join(a.dataDir, 'bgt.sqlite'));
  const ffmpegPath = resolveTool('ffmpeg');

  const deps: PipelineDeps = {
    repo: new Repo(db),
    log: a.log,
    perf: createPerfStore(path.join(a.dataDir, 'perf.json')),
    transcriber: new WhisperCppTranscriber({
      whisperPath: resolveTool('whisper-cli'),
      modelPath: modelPath(`ggml-${a.model}.bin`),
      vadModelPath: findVadModel(),
    }),

    async probeDurationMs(source, signal) {
      if (isUrl(source)) {
        return getDurationMs({ ytdlpPath: resolveTool('yt-dlp'), url: source, signal });
      }
      if (!existsSync(source) || !statSync(source).isFile()) {
        throw new BgtError('InvalidInput', `File not found: ${source}`);
      }
      return probeDurationMs({ ffmpegPath, file: source, signal });
    },

    async fetchAudio(f) {
      if (isUrl(f.source)) {
        const section =
          f.startMs > 0 || f.endMs < f.fullDurationMs ? { startMs: f.startMs, endMs: f.endMs } : null;
        const downloaded = await downloadAudio({
          ytdlpPath: resolveTool('yt-dlp'),
          ffmpegPath,
          url: f.source,
          workDir: f.workDir,
          section,
          signal: f.signal,
        });
        await toWav16kMono({ ffmpegPath, input: downloaded, output: f.outWavPath, signal: f.signal });
      } else {
        await toWav16kMono({
          ffmpegPath,
          input: f.source,
          output: f.outWavPath,
          startMs: f.startMs,
          endMs: f.endMs,
          signal: f.signal,
        });
      }
    },

    detectSilences: (wavPath, totalMs, signal) =>
      detectSilences({ ffmpegPath, wavPath, totalMs, signal }),

    cutWav: (c) => cutWav({ ffmpegPath, ...c }),
  };

  return { deps, workRoot: path.join(a.dataDir, 'work'), close: () => db.close() };
}
```

- [ ] **Step 4: Implement the CLI**

`src/cli/run.ts`:
```ts
import path from 'node:path';
import { BgtError } from '../core/errors';
import { createRealDeps } from '../core/pipeline/real-deps';
import { runJob } from '../core/pipeline/run';
import { dataDir } from '../core/tools/paths';
import { parseTimestamp } from '../core/time';

export interface RunCliOptions {
  start?: string;
  end?: string;
  model: string;
  out: string;
  maxMinutes: string;
  keepWork?: boolean;
}

export async function runCommand(source: string, opts: RunCliOptions): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => {
    console.log('\nStopping... run the same command again to resume.');
    controller.abort();
  };
  process.once('SIGINT', onSigint);

  let closeDeps: (() => void) | undefined;
  try {
    const maxMinutes = Number(opts.maxMinutes);
    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
      throw new BgtError('InvalidInput', `--max-minutes must be a positive number, got "${opts.maxMinutes}".`);
    }
    const startMs = opts.start ? parseTimestamp(opts.start) : 0;
    const endMs = opts.end ? parseTimestamp(opts.end) : null;

    const { deps, workRoot, close } = createRealDeps({
      dataDir: dataDir(),
      model: opts.model,
      log: (m) => console.log(m),
    });
    closeDeps = close;

    const result = await runJob(deps, {
      source,
      startMs,
      endMs,
      maxMinutes,
      model: opts.model,
      language: 'ja',
      workRoot,
      outDir: path.resolve(opts.out),
      keepWork: Boolean(opts.keepWork),
      signal: controller.signal,
    });

    console.log(`\nSubtitles: ${result.srtPath}`);
    console.log(`Raw data:  ${result.jsonPath}`);
    if (result.status !== 'done') process.exitCode = 2;
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
    closeDeps?.();
  }
}
```

`src/cli/doctor.ts`:
```ts
import { existsSync } from 'node:fs';
import { BgtError } from '../core/errors';
import { findVadModel, modelPath, resolveTool, type ToolName } from '../core/tools/paths';
import { runProcess } from '../core/tools/process';

export async function doctorCommand(): Promise<void> {
  let problems = 0;
  const line = (label: string, value: string, ok: boolean) => {
    if (!ok) problems++;
    console.log(`${ok ? 'OK     ' : 'MISSING'}  ${label.padEnd(16)} ${value}`);
  };

  const resolved: Partial<Record<ToolName, string>> = {};
  for (const name of ['yt-dlp', 'ffmpeg', 'whisper-cli'] as const) {
    try {
      resolved[name] = resolveTool(name);
      line(name, resolved[name] as string, true);
    } catch (err) {
      line(name, err instanceof BgtError ? err.message : String(err), false);
    }
  }

  try {
    line('model large-v3', modelPath('ggml-large-v3.bin'), true);
  } catch (err) {
    line('model large-v3', err instanceof Error ? err.message : String(err), false);
  }
  const vad = findVadModel();
  line('VAD model', vad ?? 'not found (run "pnpm setup:tools")', vad !== null && existsSync(vad));

  if (resolved['whisper-cli']) {
    const help = await runProcess(resolved['whisper-cli'], ['--help']);
    const hasVad = `${help.stdout}${help.stderr}`.includes('--vad');
    line('whisper VAD flag', hasVad ? '--vad supported' : 'this whisper-cli build has no --vad', hasVad);
  }

  try {
    const gpu = await runProcess('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
    console.log(`INFO     GPU              ${gpu.stdout.trim() || 'none reported'}`);
  } catch {
    console.log('INFO     GPU              nvidia-smi not available (CPU-only or non-NVIDIA)');
  }

  if (problems > 0) process.exitCode = 1;
}
```

`src/cli/index.ts`:
```ts
import { Command } from 'commander';
import { updateYtDlp } from '../core/tools/ytdlp';
import { resolveTool } from '../core/tools/paths';
import { BgtError } from '../core/errors';
import { doctorCommand } from './doctor';
import { runCommand } from './run';

const program = new Command();
program.name('bgt').description('Transcribe Japanese YouTube videos locally with whisper.cpp');

program
  .command('run')
  .argument('<source>', 'YouTube URL or path to a local audio/video file')
  .option('--start <time>', 'start of the section (S, M:SS or H:MM:SS)')
  .option('--end <time>', 'end of the section')
  .option('--model <name>', 'whisper model name (ggml-<name>.bin)', 'large-v3')
  .option('--out <dir>', 'output directory', 'output')
  .option('--max-minutes <n>', 'maximum minutes of audio per job', '30')
  .option('--keep-work', 'keep intermediate files in data/work')
  .action(runCommand);

program.command('doctor').description('Check that all required tools and models are available').action(doctorCommand);

program
  .command('update-ytdlp')
  .description('Update yt-dlp (needed whenever YouTube changes)')
  .action(async () => {
    try {
      console.log(await updateYtDlp(resolveTool('yt-dlp')));
    } catch (err) {
      if (err instanceof BgtError) {
        console.error(`${err.code}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run to verify**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: ALL pass.

Smoke the CLI surface (tools are not installed yet, so errors are expected and must be clear):
```bash
pnpm bgt --help
pnpm bgt run "x.wav" --start 90:xx
pnpm bgt doctor
```
Expected: help lists `run`, `doctor`, `update-ytdlp`; the second prints `InvalidInput: Invalid time "90:xx"...` and exits 1; `doctor` prints MISSING rows for yt-dlp, whisper-cli, and models and exits 1 (ffmpeg shows OK).

- [ ] **Step 6: Commit**

```bash
git add src/core/pipeline/real-deps.ts src/cli tests/core/real-deps.test.ts
git commit -m "feat: real dependency wiring and bgt CLI (run, doctor, update-ytdlp)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Pin tools, install, and verify against real binaries

This task needs the network (roughly 3.5 GB of downloads) and the user's creator video URLs. It validates the assumptions Tasks 11 and 12 made about external tools.

**Files:**
- Create: `tools.lock.json` (generated), `tests/integration/pipeline.integration.test.ts`
- Modify (only if verification demands it): `src/core/backends/transcribe/whispercpp.ts`, `src/core/pipeline/segment-cleanup.ts` (constants)

**Interfaces:**
- Consumes: everything.
- Produces: a committed `tools.lock.json`; a green opt-in integration test; a manual accuracy verdict from the user.

- [ ] **Step 1: Pin the tools**

Run: `pnpm pin:tools`
Expected: prints the chosen yt-dlp tag, whisper.cpp tag and asset name, and the two model revisions; writes `tools.lock.json`. If it prints the CPU-build warning, tell the user (GPU transcription would be unavailable until a CUDA build is pinned) and ask whether to continue on CPU.

Inspect: `cat tools.lock.json`. Every entry must have a 64-hex-character `sha256`.

- [ ] **Step 2: Download everything**

Run: `pnpm setup:tools`
Expected: progress for each entry, then `Done.` Re-running prints `up to date` for every entry.

- [ ] **Step 3: Doctor**

Run: `pnpm bgt doctor`
Expected: all rows `OK`, including `whisper VAD flag  --vad supported` and an `INFO GPU` row naming the RTX 3080.
**If the VAD row is MISSING, stop and report to the user** (the pinned whisper.cpp build lacks `--vad`; the spec requires it).

- [ ] **Step 4: Verify the whisper.cpp assumptions on real output (GPU, JSON shape)**

```bash
ffmpeg -hide_banner -f lavfi -i "sine=frequency=300:duration=5" -ar 16000 -ac 1 "$TEMP/bgt-tone.wav" -y
resources/whisper/whisper-cli.exe --help | head -60
```
Locate the real `whisper-cli.exe` first if it is nested (`find resources/whisper -name whisper-cli.exe`), then run it directly on a short real speech WAV if one is available (otherwise on the tone) with `-m resources/models/ggml-large-v3.bin -f <wav> -l ja -ojf -of "$TEMP/bgt-probe"` and check:
1. stderr mentions CUDA (`ggml_cuda_init: found 1 CUDA devices`). If it does not, the CPU build is in use; tell the user.
2. `$TEMP/bgt-probe.json` has `transcription[].offsets.from/to`, `text`, and `tokens[].p`. If the field names differ, fix `parseWhisperJson` and its test fixture in `tests/core/whispercpp.test.ts` to match the real shape, then run `pnpm test`.

- [ ] **Step 5: Write the opt-in integration test**

`tests/integration/pipeline.integration.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRealDeps } from '../../src/core/pipeline/real-deps';
import { runJob } from '../../src/core/pipeline/run';
import { resolveTool } from '../../src/core/tools/paths';

// Opt in with BGT_INTEGRATION=1. Requires `pnpm setup:tools` and ffmpeg.
describe.skipIf(!process.env.BGT_INTEGRATION)('real binaries', () => {
  let root: string;
  let source: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'bgt integration '));
    mkdirSync(path.join(root, 'in'), { recursive: true });
    source = path.join(root, 'in', 'テスト 音声.wav'); // space + Japanese characters
    execFileSync(resolveTool('ffmpeg'), [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6', '-ar', '44100', source,
    ]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('processes a local file with a non-ASCII name end to end', async () => {
    const { deps, workRoot, close } = createRealDeps({
      dataDir: path.join(root, 'data'),
      model: 'large-v3',
      log: () => {},
    });
    try {
      const result = await runJob(deps, {
        source,
        startMs: 1_000,
        endMs: 5_000,
        maxMinutes: 30,
        model: 'large-v3',
        language: 'ja',
        workRoot,
        outDir: path.join(root, 'out dir'),
        keepWork: false,
      });
      expect(result.status).toBe('done');
      expect(existsSync(result.srtPath)).toBe(true);
      expect(typeof readFileSync(result.srtPath, 'utf8')).toBe('string'); // a tone yields no speech
    } finally {
      close();
    }
  }, 300_000);
});
```

Run: `BGT_INTEGRATION=1 pnpm test tests/integration`
Expected: PASS. Also run `pnpm test` without the variable: the integration test is skipped, everything else passes.

- [ ] **Step 6: Commit**

```bash
git add tools.lock.json tests/integration
git commit -m "feat(tools): pin tool versions and add opt-in integration test

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Accuracy run on the user's real video (needs the user)**

Ask the user for one or two VOD URLs from their followed creators and a 5-10 minute section of each. Then run, for each:
```bash
pnpm bgt run "<url>" --start <H:MM:SS> --end <H:MM:SS> --keep-work
```
Report to the user: the time estimate printed, the actual wall time, and the output path `output/job-<id>.ja.srt`. Ask them to read the SRT beside the video and judge: accuracy of the speech, hallucinations over music or game audio, missing speech, timestamp alignment with the video.

Tune only what the evidence points to, one change at a time, re-running the same job (delete `data/bgt.sqlite` or use a different range so it re-processes):
- Hallucinated text over music: lower `minAvgLogprob` threshold toward `-1.0`, or lower `maxConsecutiveRepeats`, in `src/core/pipeline/segment-cleanup.ts`.
- Dropped real speech: raise `minAvgLogprob` toward `-2.0`.
- VAD cutting speech or missing quiet speech: add `--vad-threshold <n>` / `--vad-min-silence-duration-ms <n>` to `buildWhisperArgs` (check the exact flag names in `whisper-cli --help` first) and update `tests/core/whispercpp.test.ts`.
Re-run `pnpm test` after any constant or flag change.

- [ ] **Step 8: Kill-and-resume check on a real job**

Start a job on a range of 10+ minutes, press Ctrl+C during the first chunk, then re-run the identical command.
Expected: the first run prints `Stopping...` and exits with code 130; the second prints `Resuming job <id>`, does not re-download audio (no `Fetching audio...` line), and completes.

- [ ] **Step 9: Final verification and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint && git status --short`
Expected: all green; the working tree contains no media, models, `data/` or `output/` (all gitignored).

```bash
git add -A
git commit -m "chore: tune thresholds from real-video accuracy run

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(Skip this commit if Step 7 changed nothing.)

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| Single package, TS, vitest, ESLint, core isolation rule | 1 |
| Interfaces `transcribe` / `translate` / `summarize` | 2 |
| Time-range parsing, 30-min cap, `--max-minutes`, `OverCap` | 3, 13, 14 |
| SRT output, JSON dump | 4, 13 |
| Silence-aware ~15 min chunks, 2 s overlap, earlier chunk wins | 5, 6, 13 |
| Hallucination filter, confidence from tokens | 6, 11 |
| SQLite `jobs` / `chunks` / `segments`, `user_version` migrations | 7 |
| Typed errors, retries (3 attempts), Ctrl+C resumable | 2, 8, 13, 14 |
| yt-dlp section download, playlist guard, update command | 10, 14 |
| ffmpeg 16 kHz mono WAV, silencedetect, resolution order | 8, 9 |
| whisper-cli per chunk, `--vad`, large-v3 | 11, 15 |
| `tools.lock.json`, checksums, `setup:tools`, `doctor` | 12, 14, 15 |
| Time estimate before processing, measured speed | 13 |
| Work dir cleanup, `--keep-work` | 13, 14 |
| Local files first-class | 9, 14, 15 |
| Unit tests, fake-transcriber resume test, opt-in integration test | 3-14, 13, 15 |
| Manual accuracy judged by the user | 15 |
