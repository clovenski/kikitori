# Milestone 4: First-Run Setup and Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stranger installs `Setup.exe` from a GitHub Release (no admin, no terminal) and a first-run wizard downloads the right tools and models for their hardware.

**Architecture:** `tools.lock.json` becomes schema v2: named components (per tier, per feature) of pinned, checksummed files. A pure-core `setup` module (hardware detection, plan, resumable downloads, installer, settings) is wrapped by a main-process `SetupService` that exposes IPC; the renderer gets a wizard, a Tools dialog and an on-demand download prompt. The packaged app keeps tools, models, database and settings in `%APPDATA%\Kikitori`; electron-builder produces one per-user NSIS installer; GitHub Actions builds and publishes it on a `v*` tag.

**Tech Stack:** TypeScript, Electron 44, electron-vite, React 19, vitest, `node:sqlite`, `extract-zip`, electron-builder (NSIS), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-milestone-4-setup-and-installer-design.md`

## Global Constraints

- Windows x64 only; per-user NSIS installer; no admin rights; unsigned; no auto-update.
- `src/core` stays free of Electron and React (ESLint enforces it). The renderer may import only types plus `core/time`, `core/errors`, `core/youtube`, `core/source-text` (this plan adds `core/bytes`). `src/app/shared` may only import types.
- Every downloaded file is pinned in `tools.lock.json` with an HTTPS URL, `sha256` and `size`; nothing is redistributed by this project; never ship API keys; never commit downloaded media, models or transcripts.
- Tiers: `gpu` = NVIDIA with at least 7500 MB VRAM (8 GB cards report 8188 to 8192) and driver major 551 or newer; otherwise `cpu` with a stated reason; the user can override.
- Packaged locations: tools and models `%APPDATA%\Kikitori\resources`, database/settings/work `%APPDATA%\Kikitori\data`, subtitles and summaries `Documents\Kikitori`; `KTR_USER_DATA` overrides the base folder; development keeps the project's `resources/`, `data/`, `output/`.
- GPU tier about 14 GB, CPU tier about 4.5 GB; transcription model `large-v3` (GPU) and `large-v3-turbo-q5_0` (CPU); translation `Hy-MT2-7B` / `Hy-MT2-1.8B` Q4_K_M; general `Qwen3-8B` / `Qwen3-4B` Q4_K_M.
- ffmpeg: Gyan `GyanD/codexffmpeg` tag `9.0.2`, asset `ffmpeg-9.0.2-essentials_build.zip`, downloaded on first run, not redistributed.
- License MIT, copyright "Joel Tengco". Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (pass it as a second `-m`).
- Tooling notes: the Bash tool eats backslashes in inline scripts, so create and edit files with the Write/Edit tools. Repo files mix CRLF and LF; the Edit tool matches exact text, so re-read a file if an edit does not match. Use absolute paths. Work on branch `milestone-4`; nothing is pushed.

## Review Focus

Failure modes the spec implies that no single task's happy path covers (each gets a test in the named task):

1. A download server that ignores `Range`, answers `416`, drops the connection or stalls must still end with a file whose checksum matches (Task 5).
2. yt-dlp replaces itself with `yt-dlp -U`, so its size and checksum change; that must never make the wizard reappear or Repair delete it. A development checkout that has everything installed must not show the wizard, a fresh profile must (Tasks 1, 2, 4, 8).
3. On the CPU tier the probe, the CLI and `kikitori translate` must not require the GPU model file `ggml-large-v3.bin` (Tasks 7, 9).
4. A nearly full disk is refused before anything is downloaded with a message that names the shortfall, and a failed extraction leaves no "installed" marker (Tasks 5, 6).
5. Quitting or cancelling during setup keeps the `.part` files and the next start resumes; an offline machine gets a plain-language message (Tasks 5, 8, 9).

---

## Task 0: Branch and spec corrections

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-milestone-4-setup-and-installer-design.md`

- [ ] **Step 1: Create the branch**

Run: `git switch -c milestone-4` (from `master`, tree clean).

- [ ] **Step 2: Correct the spec where planning found better answers**

Apply these edits with the Edit tool (exact `old` text from the spec):

1. old: `  - \`gpu\` when an NVIDIA GPU has at least 8192 MB VRAM and driver 551 or newer (the CUDA 12.4 builds need it).`
   new: `  - \`gpu\` when an NVIDIA GPU has at least 7500 MB VRAM (8 GB cards report 8188 to 8192 MB) and driver 551 or newer (the CUDA 12.4 builds need it).`
2. old: `"only 6144 MB of VRAM (8192 needed)"`
   new: `"only 6144 MB of VRAM (8 GB needed)"`
3. old: `Each component has \`id\`, \`title\`, \`feature\` (\`core | transcription | translation | summaries\`), \`tier\` (\`all | gpu | cpu\`), \`license\`, \`homepage\`, and \`files\` (the existing \`LockEntry\` shape plus \`size\` in bytes).`
   new: `Each component has \`id\`, \`title\`, \`features\` (a list of \`core | transcription | translation | summaries\`), \`tier\` (\`all | gpu | cpu\`), \`license\`, \`homepage\`, and \`files\` (the existing \`LockEntry\` shape plus \`size\` in bytes; yt-dlp also has \`selfUpdates: true\` because \`yt-dlp -U\` replaces it, so a changed size or checksum is not damage).`
4. old: `\`settings.json\` in the data directory, written atomically: \`{ version: 1, tier, features: { translation, summaries }, setupCompleted, installed: { <componentId>: { version, verifiedAt } } }\`. The filesystem is the source of truth for "is it installed"; the \`installed\` map makes the UI fast and \`Repair\` rewrites it after re-verifying checksums.`
   new: `\`settings.json\` in the data directory, written atomically: \`{ version: 1, tier, features: { translation, summaries }, setupCompleted }\`. The filesystem is the source of truth for "is it installed": a file counts when it exists with the pinned size, an unpacked archive counts when its checksum marker file matches. \`Repair\` re-hashes model and data files and deletes the ones that do not match, then downloads them again.`

- [ ] **Step 3: Commit**

```bash
git add docs && git commit -m "docs: correct the Milestone 4 spec after planning" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 1: Lock schema v2 with components

**Files:**
- Modify: `src/core/tools/lock.ts`, `src/core/tools/fetch.ts`, `src/core/pipeline/real-llm.ts`, `src/cli/llm.ts`, `src/cli/doctor.ts`, `scripts/fetch-tools.ts`, `scripts/pin-tools.ts`
- Create: `scripts/lock-meta.ts`, `scripts/migrate-lock-v2.ts` (temporary, deleted in step 9)
- Modify: `tools.lock.json` (regenerated)
- Test: `tests/core/lock.test.ts`, `tests/core/fetch.test.ts`, `tests/core/fetch-zip.test.ts`

**Interfaces:**
- Produces (`src/core/tools/lock.ts`):
  - `type Tier = 'gpu' | 'cpu'`, `type Feature = 'core' | 'transcription' | 'translation' | 'summaries'`
  - `interface LockEntry { id; version; url; sha256; size: number; kind: 'file' | 'zip'; dest: string; merge?: boolean; selfUpdates?: boolean }`
  - `interface LockComponent { id: string; title: string; features: Feature[]; tier: 'all' | Tier; license: string; homepage: string; files: LockEntry[] }`
  - `interface Lock { platform: 'win32-x64'; components: LockComponent[] }`
  - `loadLock(file): Lock` (throws `InvalidInput` for the old format), `validateLock(lock): string[]`, `allEntries(lock): LockEntry[]`, `findComponent(lock, id): LockComponent` (throws `ToolMissing`), `componentBytes(c): number`, `markerPath(entry, resources): string`, `componentModelPath(lock, componentId, resources): string`
  - `createRealModelPool({ log, tier(): Tier, lockFile? })` (real-llm)

- [ ] **Step 1: Write the failing tests**

Replace `tests/core/lock.test.ts` with:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  componentBytes,
  componentModelPath,
  findComponent,
  loadLock,
  markerPath,
  validateLock,
  type Lock,
  type LockEntry,
} from '../../src/core/tools/lock';
import { projectRoot } from '../../src/core/tools/paths';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-lock-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entry = (over: Partial<LockEntry> = {}): LockEntry => ({
  id: 'e1',
  version: '1',
  url: 'https://example.com/a',
  sha256: 'a'.repeat(64),
  size: 10,
  kind: 'file',
  dest: 'models/t.gguf',
  ...over,
});

const lock = (over: Partial<Lock['components'][number]> = {}): Lock => ({
  platform: 'win32-x64',
  components: [
    {
      id: 'model-translate-gpu',
      title: 'Translation model',
      features: ['translation'],
      tier: 'gpu',
      license: 'Apache-2.0',
      homepage: 'https://example.com',
      files: [entry()],
      ...over,
    },
  ],
});

describe('componentModelPath', () => {
  it('returns the resources path of a component file that exists', () => {
    mkdirSync(path.join(root, 'models'), { recursive: true });
    writeFileSync(path.join(root, 'models', 't.gguf'), 'x');
    expect(componentModelPath(lock(), 'model-translate-gpu', root)).toBe(path.join(root, 'models', 't.gguf'));
  });

  it('throws ToolMissing for an unknown component or a missing file', () => {
    expect(() => componentModelPath(lock(), 'nope', root)).toThrow(expect.objectContaining({ code: 'ToolMissing' }));
    expect(() => componentModelPath(lock(), 'model-translate-gpu', root)).toThrow(
      expect.objectContaining({ code: 'ToolMissing', message: expect.stringContaining('setup:tools') }),
    );
  });
});

describe('helpers', () => {
  it('findComponent and componentBytes', () => {
    const l = lock({ files: [entry({ size: 5 }), entry({ id: 'e2', size: 7 })] });
    expect(componentBytes(findComponent(l, 'model-translate-gpu'))).toBe(12);
  });

  it('markerPath differs for merged archives', () => {
    expect(markerPath(entry({ kind: 'zip', dest: 'llama' }), root)).toBe(path.join(root, 'llama', '.sha256'));
    expect(markerPath(entry({ kind: 'zip', dest: 'llama', merge: true, id: 'cudart' }), root)).toBe(
      path.join(root, 'llama', '.cudart.sha256'),
    );
  });
});

describe('validateLock', () => {
  it('accepts a good lock', () => {
    expect(validateLock(lock())).toEqual([]);
  });

  it('reports every kind of problem', () => {
    const bad = lock({
      license: '',
      files: [
        entry({ sha256: 'xyz', size: 0, url: 'http://example.com/a', dest: '../escape' }),
        entry({ id: 'e1' }),
      ],
    });
    bad.components.push({ ...bad.components[0], files: [entry({ id: 'e3' })] });
    const problems = validateLock(bad).join('\n');
    expect(problems).toMatch(/missing license/);
    expect(problems).toMatch(/sha256/);
    expect(problems).toMatch(/size/);
    expect(problems).toMatch(/https/);
    expect(problems).toMatch(/dest/);
    expect(problems).toMatch(/duplicate file id/);
    expect(problems).toMatch(/duplicate component/);
  });
});

describe('loadLock', () => {
  it('rejects the old flat format with a helpful message', () => {
    const file = path.join(root, 'old.json');
    writeFileSync(file, JSON.stringify({ platform: 'win32-x64', tools: [] }));
    expect(() => loadLock(file)).toThrow(expect.objectContaining({ code: 'InvalidInput', message: expect.stringContaining('old format') }));
  });
});

describe('the committed tools.lock.json', () => {
  it('is valid and covers every component the app asks for', () => {
    const real = loadLock(path.join(projectRoot(), 'tools.lock.json'));
    expect(validateLock(real)).toEqual([]);
    const ids = real.components.map((c) => c.id).sort();
    expect(ids).toEqual(
      [
        'ffmpeg',
        'llama-cpu',
        'llama-gpu',
        'model-general-cpu',
        'model-general-gpu',
        'model-transcribe-cpu',
        'model-transcribe-gpu',
        'model-translate-cpu',
        'model-translate-gpu',
        'vad',
        'whisper-cpu',
        'whisper-gpu',
        'yt-dlp',
      ].sort(),
    );
  });
});
```

In `tests/core/fetch.test.ts` change the `entry` helper to add the size, i.e. replace
`  sha256: payloadSha,\n  kind: 'file',` with `  sha256: payloadSha,\n  size: payload.length,\n  kind: 'file',`.

In `tests/core/fetch-zip.test.ts` change the `entry` helper: replace `  sha256: sha(zips[url]),` with `  sha256: sha(zips[url]),\n  size: zips[url].length,`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/core/lock.test.ts`
Expected: FAIL (the new exports do not exist).

- [ ] **Step 3: Rewrite `src/core/tools/lock.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../errors';

export type Tier = 'gpu' | 'cpu';
export type Feature = 'core' | 'transcription' | 'translation' | 'summaries';

export interface LockEntry {
  id: string;
  version: string;
  url: string;
  sha256: string;
  /** Bytes of the download. */
  size: number;
  kind: 'file' | 'zip';
  /** Path relative to the resources directory (a file for 'file', a folder for 'zip'). */
  dest: string;
  /** zip only: extract into `dest` without wiping what other archives put there. */
  merge?: boolean;
  /** The program replaces itself (yt-dlp -U), so a changed size or checksum is not damage. */
  selfUpdates?: boolean;
}

export interface LockComponent {
  id: string;
  title: string;
  features: Feature[];
  tier: 'all' | Tier;
  license: string;
  homepage: string;
  files: LockEntry[];
}

export interface Lock {
  platform: 'win32-x64';
  components: LockComponent[];
}

export function loadLock(file: string): Lock {
  const lock = JSON.parse(readFileSync(file, 'utf8')) as Partial<Lock>;
  if (!Array.isArray(lock.components)) {
    throw new BgtError('InvalidInput', `${file} is in an old format. Run "pnpm pin:tools --update".`);
  }
  return lock as Lock;
}

/** Lists everything wrong with a lock (empty when it is fine). */
export function validateLock(lock: Lock): string[] {
  const problems: string[] = [];
  const componentIds = new Set<string>();
  const fileIds = new Set<string>();
  if (lock.platform !== 'win32-x64') problems.push('platform must be win32-x64');
  for (const c of lock.components) {
    if (componentIds.has(c.id)) problems.push(`duplicate component ${c.id}`);
    componentIds.add(c.id);
    for (const key of ['title', 'license', 'homepage'] as const) {
      if (!c[key]?.trim()) problems.push(`${c.id}: missing ${key}`);
    }
    if (c.features.length === 0) problems.push(`${c.id}: no features`);
    if (c.files.length === 0) problems.push(`${c.id}: no files`);
    for (const f of c.files) {
      if (fileIds.has(f.id)) problems.push(`${c.id}: duplicate file id ${f.id}`);
      fileIds.add(f.id);
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) problems.push(`${f.id}: sha256 is not 64 hex characters`);
      if (!Number.isInteger(f.size) || f.size <= 0) problems.push(`${f.id}: size must be a positive integer`);
      if (!f.url.startsWith('https://')) problems.push(`${f.id}: url must use https`);
      if (path.isAbsolute(f.dest) || f.dest.split(/[\\/]/).includes('..')) {
        problems.push(`${f.id}: dest must stay inside the resources folder`);
      }
    }
  }
  return problems;
}

export const allEntries = (lock: Lock): LockEntry[] => lock.components.flatMap((c) => c.files);

export function findComponent(lock: Lock, id: string): LockComponent {
  const component = lock.components.find((c) => c.id === id);
  if (!component) throw new BgtError('ToolMissing', `"${id}" is not listed in tools.lock.json. Run "pnpm pin:tools".`);
  return component;
}

export const componentBytes = (c: LockComponent): number => c.files.reduce((n, f) => n + f.size, 0);

/** The file recording which archive is unpacked in a zip entry's folder. */
export function markerPath(entry: LockEntry, resources: string): string {
  return path.join(resources, entry.dest, entry.merge ? `.${entry.id}.sha256` : '.sha256');
}

/** Path of the first file of a model component; it must exist. */
export function componentModelPath(lock: Lock, componentId: string, resources: string): string {
  const file = path.join(resources, findComponent(lock, componentId).files[0].dest);
  if (!existsSync(file)) {
    throw new BgtError(
      'ToolMissing',
      `Model file ${file} is missing. Install it from the Tools page (or run "pnpm setup:tools" in a development checkout).`,
    );
  }
  return file;
}
```

- [ ] **Step 4: Use `markerPath` in `fetchEntry`**

In `src/core/tools/fetch.ts` change the import to `import { markerPath, type LockEntry } from './lock';` and replace
`  const marker = path.join(dest, entry.merge ? \`.${entry.id}.sha256\` : '.sha256');` with `  const marker = markerPath(entry, resources);`.

- [ ] **Step 5: Run the lock and fetch tests**

Run: `pnpm vitest run tests/core/lock.test.ts tests/core/fetch.test.ts tests/core/fetch-zip.test.ts`
Expected: only the "committed tools.lock.json" test fails (the file is still the old format); everything else passes.

- [ ] **Step 6: Create `scripts/lock-meta.ts`**

```ts
import type { Feature, Tier } from '../src/core/tools/lock';

export interface ComponentMeta {
  id: string;
  title: string;
  features: Feature[];
  tier: 'all' | Tier;
  license: string;
  homepage: string;
}

const NVIDIA_NOTE = ' (the CUDA archive also contains NVIDIA CUDA runtime files under the NVIDIA license)';

/** Display order of the lock file. */
export const META: ComponentMeta[] = [
  { id: 'yt-dlp', title: 'yt-dlp (video downloader)', features: ['core'], tier: 'all', license: 'Unlicense', homepage: 'https://github.com/yt-dlp/yt-dlp' },
  { id: 'ffmpeg', title: 'ffmpeg (audio conversion, Gyan essentials build)', features: ['core'], tier: 'all', license: 'GPL-3.0-or-later', homepage: 'https://www.gyan.dev/ffmpeg/builds/' },
  { id: 'vad', title: 'Voice activity model (Silero VAD)', features: ['transcription'], tier: 'all', license: 'MIT', homepage: 'https://huggingface.co/ggml-org/whisper-vad' },
  { id: 'whisper-gpu', title: 'Speech recognition program (whisper.cpp, NVIDIA GPU)', features: ['transcription'], tier: 'gpu', license: `MIT${NVIDIA_NOTE}`, homepage: 'https://github.com/ggml-org/whisper.cpp' },
  { id: 'whisper-cpu', title: 'Speech recognition program (whisper.cpp, CPU)', features: ['transcription'], tier: 'cpu', license: 'MIT', homepage: 'https://github.com/ggml-org/whisper.cpp' },
  { id: 'model-transcribe-gpu', title: 'Speech recognition model (Whisper large-v3)', features: ['transcription'], tier: 'gpu', license: 'MIT', homepage: 'https://huggingface.co/ggerganov/whisper.cpp' },
  { id: 'model-transcribe-cpu', title: 'Speech recognition model (Whisper large-v3-turbo, 5-bit)', features: ['transcription'], tier: 'cpu', license: 'MIT', homepage: 'https://huggingface.co/ggerganov/whisper.cpp' },
  { id: 'llama-gpu', title: 'Language model runtime (llama.cpp, NVIDIA GPU)', features: ['translation', 'summaries'], tier: 'gpu', license: `MIT${NVIDIA_NOTE}`, homepage: 'https://github.com/ggml-org/llama.cpp' },
  { id: 'llama-cpu', title: 'Language model runtime (llama.cpp, CPU)', features: ['translation', 'summaries'], tier: 'cpu', license: 'MIT', homepage: 'https://github.com/ggml-org/llama.cpp' },
  { id: 'model-translate-gpu', title: 'Translation model (Hy-MT2 7B)', features: ['translation'], tier: 'gpu', license: 'Apache-2.0', homepage: 'https://huggingface.co/tencent/Hy-MT2-7B-GGUF' },
  { id: 'model-translate-cpu', title: 'Translation model (Hy-MT2 1.8B)', features: ['translation'], tier: 'cpu', license: 'Apache-2.0', homepage: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF' },
  { id: 'model-general-gpu', title: 'Summary model (Qwen3 8B)', features: ['summaries'], tier: 'gpu', license: 'Apache-2.0', homepage: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF' },
  { id: 'model-general-cpu', title: 'Summary model (Qwen3 4B)', features: ['summaries'], tier: 'cpu', license: 'Apache-2.0', homepage: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF' },
];
```

- [ ] **Step 7: Rewrite `scripts/pin-tools.ts` for schema v2**

```ts
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadLock, validateLock, type Lock, type LockEntry } from '../src/core/tools/lock';
import { projectRoot } from '../src/core/tools/paths';
import { META } from './lock-meta';

/** Gyan keeps a permanent release tag per version; bump by hand and run with --update. */
const FFMPEG_TAG = '9.0.2';

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
  size: number;
  browser_download_url: string;
  digest?: string | null;
}
interface GhRelease {
  tag_name: string;
  assets: GhAsset[];
}
interface HfTreeItem {
  path: string;
  lfs?: { oid: string; size: number };
}
type Pinned = Record<string, LockEntry[]>;

const assetSha = async (a: GhAsset) =>
  a.digest?.startsWith('sha256:') ? a.digest.slice(7) : sha256OfUrl(a.browser_download_url);

async function ghEntry(
  id: string,
  release: GhRelease,
  asset: GhAsset,
  rest: Pick<LockEntry, 'kind' | 'dest'> & Partial<Pick<LockEntry, 'merge'>>,
): Promise<LockEntry> {
  return {
    id,
    version: `${release.tag_name} (${asset.name})`,
    url: asset.browser_download_url,
    sha256: await assetSha(asset),
    size: asset.size,
    ...rest,
  };
}

async function hfFile(repo: string, pick: (name: string) => boolean) {
  const info = await getJson<{ sha: string }>(`https://huggingface.co/api/models/${repo}`);
  const tree = await getJson<HfTreeItem[]>(`https://huggingface.co/api/models/${repo}/tree/${info.sha}`);
  const item = tree.filter((t) => t.lfs && pick(t.path)).sort((a, b) => a.path.localeCompare(b.path)).at(-1);
  if (!item?.lfs) throw new Error(`No matching file in ${repo}`);
  return {
    name: item.path,
    url: `https://huggingface.co/${repo}/resolve/${info.sha}/${item.path}`,
    sha256: item.lfs.oid,
    size: item.lfs.size,
    rev: info.sha.slice(0, 7),
  };
}

async function pinModel(id: string, repo: string, file: string): Promise<LockEntry> {
  const f = await hfFile(repo, (n) => n === file);
  return { id, version: f.rev, url: f.url, sha256: f.sha256, size: f.size, kind: 'file', dest: `models/${f.name}` };
}

async function pinYtDlp(): Promise<Pinned> {
  const yt = await getJson<GhRelease>('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
  const asset = yt.assets.find((a) => a.name === 'yt-dlp.exe');
  if (!asset) throw new Error('yt-dlp.exe not found in the latest release');
  const sums = await getText(`https://github.com/yt-dlp/yt-dlp/releases/download/${yt.tag_name}/SHA2-256SUMS`);
  const sha = sums
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === 'yt-dlp.exe')?.[0];
  if (!sha) throw new Error('yt-dlp.exe not found in SHA2-256SUMS');
  return {
    'yt-dlp': [
      { id: 'yt-dlp', version: yt.tag_name, url: asset.browser_download_url, sha256: sha, size: asset.size, kind: 'file', dest: 'bin/yt-dlp.exe', selfUpdates: true },
    ],
  };
}

async function pinFfmpeg(): Promise<Pinned> {
  const release = await getJson<GhRelease>(`https://api.github.com/repos/GyanD/codexffmpeg/releases/tags/${FFMPEG_TAG}`);
  const name = `ffmpeg-${FFMPEG_TAG}-essentials_build.zip`;
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`${name} not found in GyanD/codexffmpeg ${FFMPEG_TAG}`);
  return { ffmpeg: [await ghEntry('ffmpeg', { ...release, tag_name: FFMPEG_TAG }, asset, { kind: 'zip', dest: 'ffmpeg' })] };
}

async function pinWhisper(): Promise<Pinned> {
  // Binaries live on separate "bNNNN" releases; use the newest release that has both a CUDA and a CPU build.
  const releases = await getJson<GhRelease[]>('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15');
  const cudaPatterns = [/^whisper-bin-win-cuda-([\d.]+)-x64\.zip$/, /^whisper-cublas-([\d.]+)-bin-x64\.zip$/];
  const cudaVersion = (name: string) => cudaPatterns.map((p) => p.exec(name)?.[1]).find(Boolean) ?? '0';
  const byVersion = (x: GhAsset, y: GhAsset) =>
    cudaVersion(x.name).localeCompare(cudaVersion(y.name), undefined, { numeric: true });
  for (const release of releases) {
    const cuda = release.assets.filter((a) => cudaPatterns.some((p) => p.test(a.name))).sort(byVersion).at(-1);
    const cpu = release.assets.find((a) => a.name === 'whisper-bin-x64.zip');
    if (!cuda || !cpu) continue;
    return {
      'whisper-gpu': [await ghEntry('whisper.cpp', release, cuda, { kind: 'zip', dest: 'whisper' })],
      'whisper-cpu': [await ghEntry('whisper.cpp-cpu', release, cpu, { kind: 'zip', dest: 'whisper' })],
    };
  }
  throw new Error('No whisper.cpp release with both a CUDA and a CPU Windows x64 build in the 15 most recent releases.');
}

async function pinLlama(): Promise<Pinned> {
  const releases = await getJson<GhRelease[]>('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8');
  const main = /^llama-b\d+-bin-win-cuda-12\.4-x64\.zip$/;
  const cudart = /^cudart-llama-bin-win-cuda-12\.4-x64\.zip$/;
  const cpuBuild = /^llama-b\d+-bin-win-cpu-x64\.zip$/;
  for (const release of releases) {
    const a = release.assets.find((x) => main.test(x.name));
    const rt = release.assets.find((x) => cudart.test(x.name));
    const cpu = release.assets.find((x) => cpuBuild.test(x.name));
    if (!a || !rt || !cpu) continue;
    return {
      'llama-gpu': [
        await ghEntry('llama.cpp', release, a, { kind: 'zip', dest: 'llama', merge: true }),
        await ghEntry('llama-cudart', release, rt, { kind: 'zip', dest: 'llama', merge: true }),
      ],
      'llama-cpu': [await ghEntry('llama.cpp-cpu', release, cpu, { kind: 'zip', dest: 'llama' })],
    };
  }
  throw new Error('No llama.cpp release with a CUDA 12.4 build, its cudart zip and a CPU build was found.');
}

async function pinVad(): Promise<LockEntry> {
  const f = await hfFile('ggml-org/whisper-vad', (n) => /^ggml-silero-v[\d.]+\.bin$/.test(n));
  return { id: 'vad-silero', version: f.rev, url: f.url, sha256: f.sha256, size: f.size, kind: 'file', dest: `models/${f.name}` };
}

const model = (component: string, id: string, repo: string, file: string) => ({
  ids: [component],
  pin: async (): Promise<Pinned> => ({ [component]: [await pinModel(id, repo, file)] }),
});

const PINNERS: { ids: string[]; pin(): Promise<Pinned> }[] = [
  { ids: ['yt-dlp'], pin: pinYtDlp },
  { ids: ['ffmpeg'], pin: pinFfmpeg },
  { ids: ['vad'], pin: async () => ({ vad: [await pinVad()] }) },
  { ids: ['whisper-gpu', 'whisper-cpu'], pin: pinWhisper },
  model('model-transcribe-gpu', 'model-large-v3', 'ggerganov/whisper.cpp', 'ggml-large-v3.bin'),
  model('model-transcribe-cpu', 'model-large-v3-turbo-q5_0', 'ggerganov/whisper.cpp', 'ggml-large-v3-turbo-q5_0.bin'),
  { ids: ['llama-gpu', 'llama-cpu'], pin: pinLlama },
  model('model-translate-gpu', 'model-translate', 'tencent/Hy-MT2-7B-GGUF', 'Hy-MT2-7B-Q4_K_M.gguf'),
  model('model-translate-cpu', 'model-translate-cpu', 'tencent/Hy-MT2-1.8B-GGUF', 'Hy-MT2-1.8B-Q4_K_M.gguf'),
  model('model-general-gpu', 'model-general', 'Qwen/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf'),
  model('model-general-cpu', 'model-general-cpu', 'Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf'),
];

async function main() {
  const file = path.join(projectRoot(), 'tools.lock.json');
  const update = process.argv.includes('--update');
  const kept = new Map<string, LockEntry[]>();
  if (!update && existsSync(file)) for (const c of loadLock(file).components) kept.set(c.id, c.files);

  for (const p of PINNERS) {
    if (p.ids.every((id) => kept.has(id))) continue;
    for (const [id, files] of Object.entries(await p.pin())) kept.set(id, files);
  }

  const lock: Lock = {
    platform: 'win32-x64',
    components: META.map((m) => {
      const files = kept.get(m.id);
      if (!files) throw new Error(`Nothing pinned for ${m.id}`);
      return { ...m, files };
    }),
  };
  const problems = validateLock(lock);
  if (problems.length > 0) throw new Error(`The new lock is invalid:\n${problems.join('\n')}`);
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Wrote ${file}${update ? ' (all entries refreshed)' : ' (existing entries kept)'}`);
  for (const c of lock.components) console.log(`  ${c.id}  ${c.files.map((f) => f.version).join(' + ')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 8: One-time migration of the existing pins (temporary script)**

The existing GPU pins must not move (the author's `resources/` is built from them), so convert them instead of re-pinning. Create `scripts/migrate-lock-v2.ts`:

```ts
import { readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Lock, LockEntry } from '../src/core/tools/lock';
import { projectRoot, resourcesDir } from '../src/core/tools/paths';
import { META } from './lock-meta';

type OldEntry = Omit<LockEntry, 'size'>;
const file = path.join(projectRoot(), 'tools.lock.json');
const old = JSON.parse(readFileSync(file, 'utf8')) as { tools: OldEntry[] };

const MAP: Record<string, string[]> = {
  'yt-dlp': ['yt-dlp'],
  vad: ['vad-silero'],
  'whisper-gpu': ['whisper.cpp'],
  'model-transcribe-gpu': ['model-large-v3'],
  'llama-gpu': ['llama.cpp', 'llama-cudart'],
  'model-translate-gpu': ['model-translate'],
  'model-general-gpu': ['model-general'],
};

/** Total size from a one-byte ranged request. */
async function sizeOf(url: string): Promise<number> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0', 'User-Agent': 'kikitori' }, redirect: 'follow' });
  const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
  await res.body?.cancel();
  if (!total) throw new Error(`No size for ${url} (HTTP ${res.status})`);
  return Number(total);
}

const components: Lock['components'] = [];
for (const meta of META) {
  const ids = MAP[meta.id];
  if (!ids) continue;
  const files: LockEntry[] = [];
  for (const id of ids) {
    const o = old.tools.find((t) => t.id === id);
    if (!o) throw new Error(`Old lock has no ${id}`);
    const size = await sizeOf(o.url);
    const local = path.join(resourcesDir(), o.dest);
    if (o.kind === 'file' && existsSync(local) && id !== 'yt-dlp' && statSync(local).size !== size) {
      throw new Error(`${id}: server says ${size} bytes but the local file has ${statSync(local).size}`);
    }
    files.push({ ...o, size, ...(id === 'yt-dlp' ? { selfUpdates: true } : {}) });
    console.log(`${id}: ${size}`);
  }
  components.push({ ...meta, files });
}
// pin-tools adds the components that do not exist yet; it needs every META id, so write a partial lock it can extend.
writeFileSync(file, `${JSON.stringify({ platform: 'win32-x64', components }, null, 2)}\n`);
```

Run: `pnpm tsx scripts/migrate-lock-v2.ts`
Expected: prints seven sizes without a mismatch error; `tools.lock.json` now has `components` with the GPU entries (ids and shas unchanged).

Then run: `pnpm pin:tools`
Expected: pins ffmpeg, the CPU whisper/llama zips and the three CPU models, writes all 13 components and prints a version line for each. Check the new sizes against the spec (about 109/115 MB ffmpeg zip, 547 MB turbo model, 1.1 GB Hy-MT2 1.8B, 2.4 GB Qwen3 4B).

Then run: `pnpm vitest run tests/core/lock.test.ts`
Expected: PASS, including "the committed tools.lock.json".

- [ ] **Step 9: Delete the migration script**

Run: `git rm -f --ignore-unmatch scripts/migrate-lock-v2.ts; rm -f scripts/migrate-lock-v2.ts` (it was never committed; the file must not be in the commit).

- [ ] **Step 10: Move the consumers to the v2 lock**

`src/core/pipeline/real-llm.ts` (replace the whole file):

```ts
import path from 'node:path';
import { LlmClient } from '../llm/client';
import { LlamaServer } from '../llm/llama-server';
import { componentModelPath, loadLock, type Tier } from '../tools/lock';
import { projectRoot, resolveTool, resourcesDir } from '../tools/paths';
import type { ModelPool, ModelRole } from './stages';

const COMPONENT: Record<ModelRole, string> = { general: 'model-general', translate: 'model-translate' };
const CONTEXT: Record<ModelRole, number> = { general: 8192, translate: 4096 };

export function createRealModelPool(a: {
  log: (message: string) => void;
  /** Read on every start, so a tier switch in the app takes effect without a restart. */
  tier: () => Tier;
  lockFile?: string;
}): ModelPool {
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
          modelPath: componentModelPath(lock, `${COMPONENT[role]}-${a.tier()}`, resourcesDir()),
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

`src/cli/llm.ts`: replace `pool: createRealModelPool({ log: console.log }),` with `pool: createRealModelPool({ log: console.log, tier: () => 'gpu' }),` (Task 7 replaces the constant with the saved tier).

`src/cli/doctor.ts`: change the import to `import { componentModelPath, loadLock } from '../core/tools/lock';` and replace the `for (const id of ['model-translate', 'model-general'])` block with:

```ts
    for (const id of ['model-translate-gpu', 'model-general-gpu']) {
      try {
        line(id, componentModelPath(lock, id, resourcesDir()), true);
      } catch (err) {
        line(id, err instanceof Error ? err.message : String(err), false);
      }
    }
```

`scripts/fetch-tools.ts` (replace the whole file; `--tier cpu` fetches the CPU components, default `gpu`):

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
  const tierFlag = process.argv.indexOf('--tier');
  const tier = tierFlag >= 0 ? process.argv[tierFlag + 1] : 'gpu';
  if (tier !== 'gpu' && tier !== 'cpu') {
    console.error('Usage: pnpm setup:tools [--tier gpu|cpu]');
    process.exit(1);
  }
  const lock = loadLock(path.join(projectRoot(), 'tools.lock.json'));
  for (const component of lock.components.filter((c) => c.tier === 'all' || c.tier === tier)) {
    for (const entry of component.files) {
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
  }
  console.log('Done. Run "pnpm kikitori doctor" to verify.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 11: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green (grep for any remaining `lockedModelPath` or `lock.tools` use first: `Grep "lockedModelPath|\.tools\b"` in `src scripts tests` must find nothing).

```bash
git add -A && git commit -m "feat(tools): lock schema v2 with tiered components, sizes and CPU pins" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Byte formatting, component rules and the install plan

**Files:**
- Create: `src/core/bytes.ts`, `src/core/setup/components.ts`, `src/core/setup/plan.ts`, `tests/helpers/lock-fakes.ts`
- Modify: `src/core/errors.ts`
- Test: `tests/core/bytes.test.ts`, `tests/core/components.test.ts`, `tests/core/plan.test.ts`

**Interfaces:**
- Produces:
  - `formatBytes(n: number): string` (decimal units: `'547 MB'`, `'4.7 GB'`)
  - `TRANSCRIBE_MODEL: Record<Tier, string>`, `transcribeModelName(tier)`, `interface Wants { translation: boolean; summaries: boolean }`, `requiredComponentIds(tier, wants): string[]`, `wantsOfOptions(o: { translate: boolean; summarize: boolean; skim: boolean }): Wants`
  - `entryInstalled(e, resources): boolean`, `componentInstalled(c, resources): boolean`, `interface SetupPlan { required: LockComponent[]; missing: LockComponent[]; missingBytes: number }`, `buildPlan(lock, tier, wants, resources): SetupPlan`, `ensureInstalled(lock, tier, wants, resources): void` (throws `BgtError('SetupRequired', ...)`)
  - test helpers `fakeLock(size?)`, `installFake(lock, resources, ids)`, `ALL_COMPONENT_IDS`

- [ ] **Step 1: Add the error code**

In `src/core/errors.ts` add `  | 'SetupRequired'` to the `ErrorCode` union (after `'LlmFailed'`).

- [ ] **Step 2: Write the failing tests**

`tests/core/bytes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../src/core/bytes';

describe('formatBytes', () => {
  it('uses decimal units like the download pages do', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(500_000)).toBe('<1 MB');
    expect(formatBytes(547_000_000)).toBe('547 MB');
    expect(formatBytes(4_680_000_000)).toBe('4.7 GB');
    expect(formatBytes(999_400_000)).toBe('999 MB');
  });
});
```

`tests/helpers/lock-fakes.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findComponent, markerPath, type Lock, type LockComponent, type LockEntry } from '../../src/core/tools/lock';

export const ALL_COMPONENT_IDS = [
  'yt-dlp',
  'ffmpeg',
  'vad',
  'whisper-gpu',
  'whisper-cpu',
  'model-transcribe-gpu',
  'model-transcribe-cpu',
  'llama-gpu',
  'llama-cpu',
  'model-translate-gpu',
  'model-translate-cpu',
  'model-general-gpu',
  'model-general-cpu',
] as const;

const ZIPS: Record<string, string> = {
  ffmpeg: 'ffmpeg',
  'whisper-gpu': 'whisper',
  'whisper-cpu': 'whisper',
  'llama-gpu': 'llama',
  'llama-cpu': 'llama',
};

/** A lock with every component the app knows, one small file each; archives use the real folder names. */
export function fakeLock(size = 10): Lock {
  return {
    platform: 'win32-x64',
    components: ALL_COMPONENT_IDS.map((id): LockComponent => {
      const zip = ZIPS[id];
      const file: LockEntry = {
        id: `${id}-file`,
        version: '1',
        url: `https://example.com/${id}`,
        sha256: 'a'.repeat(64),
        size,
        kind: zip ? 'zip' : 'file',
        dest: zip ?? (id === 'yt-dlp' ? 'bin/yt-dlp.exe' : `models/${id}.bin`),
        ...(id === 'yt-dlp' ? { selfUpdates: true } : {}),
      };
      return {
        id,
        title: `Title of ${id}`,
        features: ['core'],
        tier: id.endsWith('-gpu') ? 'gpu' : id.endsWith('-cpu') ? 'cpu' : 'all',
        license: 'MIT',
        homepage: 'https://example.com',
        files: [file],
      };
    }),
  };
}

/** Creates the on-disk state of an installed component (right-sized file, or the unpack marker). */
export function installFake(lock: Lock, resources: string, ids: readonly string[]): void {
  for (const id of ids) {
    for (const f of findComponent(lock, id).files) {
      if (f.kind === 'zip') {
        const marker = markerPath(f, resources);
        mkdirSync(path.dirname(marker), { recursive: true });
        writeFileSync(marker, f.sha256);
      } else {
        const file = path.join(resources, f.dest);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, Buffer.alloc(f.size));
      }
    }
  }
}
```

`tests/core/components.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { requiredComponentIds, transcribeModelName, wantsOfOptions } from '../../src/core/setup/components';

describe('requiredComponentIds', () => {
  it('transcription only needs the core tools and the speech model', () => {
    expect(requiredComponentIds('gpu', { translation: false, summaries: false })).toEqual([
      'yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu',
    ]);
  });

  it('translation adds the runtime and the translation model; summaries the general model', () => {
    expect(requiredComponentIds('cpu', { translation: true, summaries: false })).toEqual([
      'yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu', 'llama-cpu', 'model-translate-cpu',
    ]);
    expect(requiredComponentIds('cpu', { translation: true, summaries: true })).toEqual([
      'yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu', 'llama-cpu', 'model-translate-cpu', 'model-general-cpu',
    ]);
  });
});

describe('wantsOfOptions', () => {
  it('maps job options to wanted features; skim needs the summary model', () => {
    expect(wantsOfOptions({ translate: true, summarize: false, skim: false })).toEqual({ translation: true, summaries: false });
    expect(wantsOfOptions({ translate: false, summarize: false, skim: true })).toEqual({ translation: false, summaries: true });
  });
});

describe('transcribeModelName', () => {
  it('differs per tier', () => {
    expect(transcribeModelName('gpu')).toBe('large-v3');
    expect(transcribeModelName('cpu')).toBe('large-v3-turbo-q5_0');
  });
});
```

`tests/core/plan.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlan, componentInstalled, ensureInstalled, entryInstalled } from '../../src/core/setup/plan';
import { findComponent } from '../../src/core/tools/lock';
import { fakeLock, installFake } from '../helpers/lock-fakes';

let res: string;
beforeEach(() => {
  res = mkdtempSync(path.join(os.tmpdir(), 'bgt-plan-'));
});
afterEach(() => rmSync(res, { recursive: true, force: true }));

const none = { translation: false, summaries: false };

describe('entryInstalled', () => {
  const lock = fakeLock(10);

  it('a file counts only when it has the pinned size', () => {
    const entry = findComponent(lock, 'vad').files[0];
    expect(entryInstalled(entry, res)).toBe(false);
    mkdirSync(path.join(res, 'models'), { recursive: true });
    writeFileSync(path.join(res, entry.dest), Buffer.alloc(3));
    expect(entryInstalled(entry, res)).toBe(false);
    writeFileSync(path.join(res, entry.dest), Buffer.alloc(10));
    expect(entryInstalled(entry, res)).toBe(true);
  });

  it('an archive counts when its marker matches the pinned checksum', () => {
    const entry = findComponent(lock, 'whisper-gpu').files[0];
    expect(entryInstalled(entry, res)).toBe(false);
    installFake(lock, res, ['whisper-gpu']);
    expect(entryInstalled(entry, res)).toBe(true);
  });

  it('yt-dlp after "yt-dlp -U" still counts: a self-updating file only has to exist', () => {
    const entry = findComponent(lock, 'yt-dlp').files[0];
    mkdirSync(path.join(res, 'bin'), { recursive: true });
    writeFileSync(path.join(res, entry.dest), Buffer.alloc(12345));
    expect(entryInstalled(entry, res)).toBe(true);
  });
});

describe('buildPlan', () => {
  it('lists only what is missing and counts only the missing bytes', () => {
    const lock = fakeLock(10);
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad']);
    const plan = buildPlan(lock, 'gpu', none, res);
    expect(plan.required.map((c) => c.id)).toEqual(['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);
    expect(plan.missing.map((c) => c.id)).toEqual(['whisper-gpu', 'model-transcribe-gpu']);
    expect(plan.missingBytes).toBe(20);
  });

  it('is empty when everything is installed', () => {
    const lock = fakeLock();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu']);
    expect(buildPlan(lock, 'cpu', none, res).missing).toEqual([]);
    expect(componentInstalled(findComponent(lock, 'whisper-cpu'), res)).toBe(true);
  });
});

describe('ensureInstalled', () => {
  it('throws SetupRequired naming the missing parts and their size', () => {
    const lock = fakeLock(1_000_000_000);
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);
    expect(() => ensureInstalled(lock, 'gpu', { translation: true, summaries: false }, res)).toThrow(
      expect.objectContaining({
        code: 'SetupRequired',
        message: expect.stringMatching(/Title of llama-gpu.*Title of model-translate-gpu.*2\.0 GB/),
      }),
    );
  });

  it('does nothing when everything needed is there', () => {
    const lock = fakeLock();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);
    expect(() => ensureInstalled(lock, 'gpu', none, res)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run tests/core/bytes.test.ts tests/core/components.test.ts tests/core/plan.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`src/core/bytes.ts`:

```ts
/** Decimal units, like the download pages show them (a "4.7 GB" model is 4.7 billion bytes). */
export function formatBytes(n: number): string {
  if (n <= 0) return '0 MB';
  if (n < 1e6) return '<1 MB';
  if (n < 1e9) return `${Math.round(n / 1e6)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}
```

`src/core/setup/components.ts`:

```ts
import type { Tier } from '../tools/lock';

/** Whisper model per tier: the file is `ggml-<name>.bin`. */
export const TRANSCRIBE_MODEL: Record<Tier, string> = { gpu: 'large-v3', cpu: 'large-v3-turbo-q5_0' };
export const transcribeModelName = (tier: Tier): string => TRANSCRIBE_MODEL[tier];

export interface Wants {
  translation: boolean;
  summaries: boolean;
}

/** Component ids a setup with these features needs, in install order. Transcription is always included. */
export function requiredComponentIds(tier: Tier, wants: Wants): string[] {
  const ids = ['yt-dlp', 'ffmpeg', 'vad', `whisper-${tier}`, `model-transcribe-${tier}`];
  if (wants.translation || wants.summaries) ids.push(`llama-${tier}`);
  if (wants.translation) ids.push(`model-translate-${tier}`);
  if (wants.summaries) ids.push(`model-general-${tier}`);
  return ids;
}

/** Skim and the automatic name list both run on the general model, so skim counts as summaries. */
export function wantsOfOptions(o: { translate: boolean; summarize: boolean; skim: boolean }): Wants {
  return { translation: o.translate, summaries: o.summarize || o.skim };
}
```

`src/core/setup/plan.ts`:

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatBytes } from '../bytes';
import { BgtError } from '../errors';
import { findComponent, markerPath, type Lock, type LockComponent, type LockEntry, type Tier } from '../tools/lock';
import { requiredComponentIds, type Wants } from './components';

/** A file counts when it exists with the pinned size; an archive when its marker matches the pinned checksum. */
export function entryInstalled(e: LockEntry, resources: string): boolean {
  if (e.kind === 'zip') {
    const marker = markerPath(e, resources);
    return existsSync(marker) && readFileSync(marker, 'utf8').trim() === e.sha256;
  }
  const file = path.join(resources, e.dest);
  if (!existsSync(file)) return false;
  return e.selfUpdates === true || statSync(file).size === e.size;
}

export const componentInstalled = (c: LockComponent, resources: string): boolean =>
  c.files.every((f) => entryInstalled(f, resources));

export interface SetupPlan {
  /** Everything the selection needs, in install order. */
  required: LockComponent[];
  /** The part of `required` that is not installed yet. */
  missing: LockComponent[];
  /** Bytes still to download (installed files of a half-installed component are not counted). */
  missingBytes: number;
}

export function buildPlan(lock: Lock, tier: Tier, wants: Wants, resources: string): SetupPlan {
  const required = requiredComponentIds(tier, wants).map((id) => findComponent(lock, id));
  const missing = required.filter((c) => !componentInstalled(c, resources));
  const missingBytes = missing
    .flatMap((c) => c.files)
    .filter((f) => !entryInstalled(f, resources))
    .reduce((n, f) => n + f.size, 0);
  return { required, missing, missingBytes };
}

/** Throws SetupRequired when something the selection needs is not installed. */
export function ensureInstalled(lock: Lock, tier: Tier, wants: Wants, resources: string): void {
  const plan = buildPlan(lock, tier, wants, resources);
  if (plan.missing.length === 0) return;
  throw new BgtError(
    'SetupRequired',
    `Download ${plan.missing.map((c) => c.title).join(', ')} (${formatBytes(plan.missingBytes)}) first. Open Tools to install it.`,
  );
}
```

- [ ] **Step 5: Run, then commit**

Run: `pnpm vitest run tests/core/bytes.test.ts tests/core/components.test.ts tests/core/plan.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add -A && git commit -m "feat(setup): component rules, install plan and byte formatting" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Hardware detection

**Files:**
- Create: `src/core/setup/hardware.ts`
- Test: `tests/core/hardware.test.ts`

**Interfaces:**
- Consumes: `runProcess` and `RunResult` from `src/core/tools/process.ts`, `Tier` from `lock.ts`.
- Produces: `interface GpuInfo { name: string; vramMb: number; driver: string }`, `parseNvidiaSmi(csv): GpuInfo[]`, `decideTier(gpus): { tier: Tier; reason: string }`, `interface HardwareInfo { gpus: GpuInfo[]; best: GpuInfo | null; tier: Tier; reason: string; ramMb: number; cores: number }`, `detectHardware(run?): Promise<HardwareInfo>`, constants `MIN_VRAM_MB = 7500`, `MIN_DRIVER = 551`.

- [ ] **Step 1: Write the failing tests** — `tests/core/hardware.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideTier, detectHardware, parseNvidiaSmi } from '../../src/core/setup/hardware';
import type { RunResult } from '../../src/core/tools/process';

const gpu = (name: string, vramMb: number, driver: string) => ({ name, vramMb, driver });

describe('parseNvidiaSmi', () => {
  it('reads one line per GPU, taking the last two fields as memory and driver', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3080, 12288, 560.94\r\nNVIDIA GeForce GTX 1050, 2048, 560.94\r\n')).toEqual([
      gpu('NVIDIA GeForce RTX 3080', 12288, '560.94'),
      gpu('NVIDIA GeForce GTX 1050', 2048, '560.94'),
    ]);
  });

  it('keeps commas inside a name and ignores malformed lines', () => {
    expect(parseNvidiaSmi('Weird, Name, 8188, 552.12\nnot a gpu line\n\nNo devices were found')).toEqual([
      gpu('Weird, Name', 8188, '552.12'),
    ]);
  });
});

describe('decideTier', () => {
  it('picks gpu for a big enough card with a new enough driver', () => {
    expect(decideTier([gpu('RTX 3080', 12288, '560.94')]).tier).toBe('gpu');
    expect(decideTier([gpu('RTX 4060', 8188, '551.23')]).tier).toBe('gpu');
  });

  it('falls back to cpu and says why', () => {
    expect(decideTier([])).toEqual({ tier: 'cpu', reason: 'No NVIDIA graphics card was found.' });
    expect(decideTier([gpu('GTX 1660', 6144, '560.94')]).reason).toBe(
      'The NVIDIA GPU (GTX 1660) has only 6144 MB of memory; 8 GB are needed.',
    );
    expect(decideTier([gpu('RTX 3080', 12288, '535.10')]).reason).toBe(
      'The NVIDIA driver (535.10) is older than 551, which the GPU programs need.',
    );
  });

  it('uses the card with the most memory', () => {
    expect(decideTier([gpu('small', 2048, '560.1'), gpu('big', 12288, '560.1')]).tier).toBe('gpu');
  });
});

describe('detectHardware', () => {
  const run = (result: RunResult | Error) => async () => {
    if (result instanceof Error) throw result;
    return result;
  };

  it('reports the best GPU and the machine size', async () => {
    const info = await detectHardware(run({ code: 0, stdout: 'RTX 3080, 12288, 560.94\n', stderr: '' }));
    expect(info.tier).toBe('gpu');
    expect(info.best?.name).toBe('RTX 3080');
    expect(info.cores).toBeGreaterThan(0);
    expect(info.ramMb).toBeGreaterThan(0);
  });

  it('treats a missing or failing nvidia-smi as "no NVIDIA GPU"', async () => {
    expect((await detectHardware(run(new Error('ENOENT')))).tier).toBe('cpu');
    expect((await detectHardware(run({ code: 9, stdout: '', stderr: 'driver not loaded' }))).tier).toBe('cpu');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/core/hardware.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/core/setup/hardware.ts`:

```ts
import os from 'node:os';
import { runProcess, type RunResult } from '../tools/process';
import type { Tier } from '../tools/lock';

/** 8 GB cards report 8188 to 8192 MB. */
export const MIN_VRAM_MB = 7500;
/** Driver major version the CUDA 12.4 builds need. */
export const MIN_DRIVER = 551;

export interface GpuInfo {
  name: string;
  vramMb: number;
  driver: string;
}

/** Parses `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(csv: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const raw of csv.split(/\r?\n/)) {
    const parts = raw.split(',').map((p) => p.trim());
    if (parts.length < 3) continue;
    const driver = parts[parts.length - 1];
    const vramMb = Number(parts[parts.length - 2]);
    const name = parts.slice(0, -2).join(', ');
    if (name === '' || !Number.isFinite(vramMb) || vramMb <= 0 || !/^\d+(\.\d+)*$/.test(driver)) continue;
    gpus.push({ name, vramMb, driver });
  }
  return gpus;
}

export function decideTier(gpus: GpuInfo[]): { tier: Tier; reason: string } {
  const best = [...gpus].sort((a, b) => b.vramMb - a.vramMb)[0];
  if (!best) return { tier: 'cpu', reason: 'No NVIDIA graphics card was found.' };
  if (best.vramMb < MIN_VRAM_MB) {
    return { tier: 'cpu', reason: `The NVIDIA GPU (${best.name}) has only ${best.vramMb} MB of memory; 8 GB are needed.` };
  }
  if (Number.parseInt(best.driver, 10) < MIN_DRIVER) {
    return { tier: 'cpu', reason: `The NVIDIA driver (${best.driver}) is older than ${MIN_DRIVER}, which the GPU programs need.` };
  }
  return { tier: 'gpu', reason: `${best.name} (${Math.round(best.vramMb / 1024)} GB) can run the fast GPU programs.` };
}

export interface HardwareInfo {
  gpus: GpuInfo[];
  best: GpuInfo | null;
  tier: Tier;
  reason: string;
  ramMb: number;
  cores: number;
}

type Run = (cmd: string, args: string[]) => Promise<RunResult>;

export async function detectHardware(run: Run = runProcess): Promise<HardwareInfo> {
  let gpus: GpuInfo[] = [];
  try {
    const r = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
    if (r.code === 0) gpus = parseNvidiaSmi(r.stdout);
  } catch {
    /* no nvidia-smi: no NVIDIA GPU */
  }
  const best = [...gpus].sort((a, b) => b.vramMb - a.vramMb)[0] ?? null;
  return {
    gpus,
    best,
    ...decideTier(gpus),
    ramMb: Math.round(os.totalmem() / 1024 / 1024),
    cores: os.cpus().length,
  };
}
```

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run tests/core/hardware.test.ts && pnpm typecheck && pnpm lint` — Expected: PASS.

```bash
git add -A && git commit -m "feat(setup): detect the NVIDIA GPU and choose a tier" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Settings

**Files:**
- Create: `src/core/setup/settings.ts`
- Test: `tests/core/settings.test.ts`

**Interfaces:**
- Consumes: `buildPlan` (Task 2), `fakeLock`/`installFake` (test helper), `transcribeModelName`.
- Produces: `interface Settings { version: 1; tier: Tier; features: { translation: boolean; summaries: boolean }; setupCompleted: boolean }`, `defaultSettings(tier?): Settings`, `readSettings(dataDir): Settings | null`, `writeSettings(dataDir, s): void` (atomic), `currentTier(dataDir): Tier` (default `'gpu'`), `defaultTranscribeModel(dataDir): string`, `ensureSettings({ dataDir, lock, resources }): Settings`.

- [ ] **Step 1: Write the failing tests** — `tests/core/settings.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentTier,
  defaultSettings,
  defaultTranscribeModel,
  ensureSettings,
  readSettings,
  writeSettings,
} from '../../src/core/setup/settings';
import { fakeLock, installFake } from '../helpers/lock-fakes';

let dir: string;
let res: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-settings-'));
  res = mkdtempSync(path.join(os.tmpdir(), 'bgt-settings-res-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(res, { recursive: true, force: true });
});

describe('read/write', () => {
  it('round-trips and leaves no temporary file', () => {
    const s = { ...defaultSettings('cpu'), setupCompleted: true };
    writeSettings(dir, s);
    expect(readSettings(dir)).toEqual(s);
    expect(existsSync(path.join(dir, 'settings.json.tmp'))).toBe(false);
  });

  it('returns null for a missing, corrupt or wrongly shaped file', () => {
    expect(readSettings(dir)).toBeNull();
    writeFileSync(path.join(dir, 'settings.json'), '{oops');
    expect(readSettings(dir)).toBeNull();
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, tier: 'tpu' }));
    expect(readSettings(dir)).toBeNull();
  });

  it('currentTier and defaultTranscribeModel follow the saved tier, gpu when unset', () => {
    expect(currentTier(dir)).toBe('gpu');
    expect(defaultTranscribeModel(dir)).toBe('large-v3');
    writeSettings(dir, defaultSettings('cpu'));
    expect(currentTier(dir)).toBe('cpu');
    expect(defaultTranscribeModel(dir)).toBe('large-v3-turbo-q5_0');
  });
});

describe('ensureSettings', () => {
  it('returns saved settings untouched', () => {
    writeSettings(dir, { ...defaultSettings('cpu'), setupCompleted: false });
    expect(ensureSettings({ dataDir: dir, lock: fakeLock(), resources: res }).tier).toBe('cpu');
  });

  it('a profile with nothing installed needs the wizard and writes nothing', () => {
    const s = ensureSettings({ dataDir: dir, lock: fakeLock(), resources: res });
    expect(s.setupCompleted).toBe(false);
    expect(existsSync(path.join(dir, 'settings.json'))).toBe(false);
  });

  it('a development checkout that has a whole tier installed is marked completed with the features it has', () => {
    const lock = fakeLock();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu', 'llama-gpu', 'model-translate-gpu']);
    const s = ensureSettings({ dataDir: dir, lock, resources: res });
    expect(s).toEqual({ version: 1, tier: 'gpu', features: { translation: true, summaries: false }, setupCompleted: true });
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'))).toEqual(s);
  });

  it('detects a complete cpu install too', () => {
    const lock = fakeLock();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu']);
    expect(ensureSettings({ dataDir: dir, lock, resources: res })).toMatchObject({ tier: 'cpu', setupCompleted: true });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/core/settings.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `src/core/setup/settings.ts`:

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Lock, Tier } from '../tools/lock';
import { transcribeModelName } from './components';
import { buildPlan } from './plan';

export interface Settings {
  version: 1;
  tier: Tier;
  features: { translation: boolean; summaries: boolean };
  setupCompleted: boolean;
}

export const defaultSettings = (tier: Tier = 'gpu'): Settings => ({
  version: 1,
  tier,
  features: { translation: true, summaries: true },
  setupCompleted: false,
});

const file = (dataDir: string) => path.join(dataDir, 'settings.json');

export function readSettings(dataDir: string): Settings | null {
  try {
    const raw = JSON.parse(readFileSync(file(dataDir), 'utf8')) as Partial<Settings>;
    const f = raw.features;
    if (raw.version !== 1 || (raw.tier !== 'gpu' && raw.tier !== 'cpu') || typeof raw.setupCompleted !== 'boolean') return null;
    if (!f || typeof f.translation !== 'boolean' || typeof f.summaries !== 'boolean') return null;
    return { version: 1, tier: raw.tier, features: { translation: f.translation, summaries: f.summaries }, setupCompleted: raw.setupCompleted };
  } catch {
    return null;
  }
}

/** Writes through a temporary file so a crash never leaves half a settings file. */
export function writeSettings(dataDir: string, settings: Settings): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file(dataDir)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file(dataDir));
}

/** The tier the installed components belong to; checkouts from before Milestone 4 are gpu. */
export const currentTier = (dataDir: string): Tier => readSettings(dataDir)?.tier ?? 'gpu';
export const defaultTranscribeModel = (dataDir: string): string => transcribeModelName(currentTier(dataDir));

/**
 * Saved settings if there are any. Otherwise, if a whole tier is already installed (a development checkout), record
 * that as a finished setup so no wizard appears; otherwise return defaults and write nothing.
 */
export function ensureSettings(a: { dataDir: string; lock: Lock; resources: string }): Settings {
  const existing = readSettings(a.dataDir);
  if (existing) return existing;
  const complete = (tier: Tier, translation: boolean, summaries: boolean) =>
    buildPlan(a.lock, tier, { translation, summaries }, a.resources).missing.length === 0;
  for (const tier of ['gpu', 'cpu'] as const) {
    if (!complete(tier, false, false)) continue;
    const settings: Settings = {
      version: 1,
      tier,
      features: { translation: complete(tier, true, false), summaries: complete(tier, false, true) },
      setupCompleted: true,
    };
    writeSettings(a.dataDir, settings);
    return settings;
  }
  return defaultSettings();
}
```

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run tests/core/settings.test.ts && pnpm typecheck && pnpm lint` — Expected: PASS.

```bash
git add -A && git commit -m "feat(setup): settings file with tier, features and dev auto-detection" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Resumable, stall-proof downloads

**Files:**
- Create: `src/core/setup/download.ts`
- Modify: `src/core/tools/fetch.ts`
- Test: `tests/core/download.test.ts`, `tests/core/fetch-zip.test.ts` (extraction failure case)

**Interfaces:**
- Produces: `downloadResumable(url, dest, opts?: DownloadOptions): Promise<void>` with `DownloadOptions { signal?; onProgress?(received, total); stallMs?; attempts?; backoffMs? }`; in `fetch.ts`: `class ChecksumError extends BgtError`, `downloadFile(url, dest, onProgress?, signal?)`, `fetchEntry(entry, resources, log, onProgress?, signal?)`.
- Behaviour: partial data lives in `<dest>.part`; `Range` resume; a server answering 200 restarts the file; 416 deletes the part and retries; dropped or stalled connections retry (default 4 attempts) and resume; HTTP errors fail at once; abort rejects with `signal.reason` and keeps the `.part`.

- [ ] **Step 1: Write the failing tests** — `tests/core/download.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadResumable } from '../../src/core/setup/download';

const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));

interface Behavior {
  ignoreRange?: boolean;
  /** Close the connection after this many bytes, on the first request only. */
  dropAfter?: number;
  /** Send this many bytes, then go silent, on the first request only. */
  stallAfter?: number;
  status?: number;
}
let server: http.Server;
let base: string;
let dir: string;
let behavior: Behavior;
let requests: { range: string | undefined }[];

beforeEach(async () => {
  behavior = {};
  requests = [];
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-dl-'));
  server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range });
    const first = requests.length === 1;
    if (behavior.status) {
      res.statusCode = behavior.status;
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = match && !behavior.ignoreRange ? Number(match[1]) : 0;
    if (start >= payload.length) {
      res.statusCode = 416;
      res.end();
      return;
    }
    const body = payload.subarray(start);
    res.statusCode = start > 0 ? 206 : 200;
    res.setHeader('content-length', body.length);
    if (start > 0) res.setHeader('content-range', `bytes ${start}-${payload.length - 1}/${payload.length}`);
    if (first && behavior.dropAfter !== undefined) {
      res.write(body.subarray(0, behavior.dropAfter));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    if (first && behavior.stallAfter !== undefined) {
      res.write(body.subarray(0, behavior.stallAfter)); // then never end
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const opts = { backoffMs: 1, attempts: 3 };

describe('downloadResumable', () => {
  it('downloads atomically and reports progress up to the total', async () => {
    const dest = path.join(dir, 'a', 'f.bin');
    const seen: [number, number][] = [];
    await downloadResumable(`${base}/f`, dest, { ...opts, onProgress: (r, t) => seen.push([r, t]) });
    expect(readFileSync(dest).equals(payload)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toEqual([payload.length, payload.length]);
  });

  it('resumes from an existing .part with a Range request', async () => {
    const dest = path.join(dir, 'f.bin');
    writeFileSync(`${dest}.part`, payload.subarray(0, 1000));
    await downloadResumable(`${base}/f`, dest, opts);
    expect(requests[0].range).toBe('bytes=1000-');
    expect(readFileSync(dest).equals(payload)).toBe(true);
  });

  it('starts over when the server ignores Range and answers 200', async () => {
    behavior.ignoreRange = true;
    const dest = path.join(dir, 'f.bin');
    writeFileSync(`${dest}.part`, payload.subarray(0, 1000));
    await downloadResumable(`${base}/f`, dest, opts);
    expect(readFileSync(dest).equals(payload)).toBe(true);
  });

  it('starts over after a 416 for a part that is not usable', async () => {
    const dest = path.join(dir, 'f.bin');
    writeFileSync(`${dest}.part`, Buffer.concat([payload, Buffer.from('extra')]));
    await downloadResumable(`${base}/f`, dest, opts);
    expect(readFileSync(dest).equals(payload)).toBe(true);
  });

  it('retries and resumes after the connection drops half way', async () => {
    behavior.dropAfter = 120_000;
    const dest = path.join(dir, 'f.bin');
    await downloadResumable(`${base}/f`, dest, opts);
    expect(readFileSync(dest).equals(payload)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].range).toMatch(/^bytes=\d+-$/);
  });

  it('retries a stalled connection', async () => {
    behavior.stallAfter = 50_000;
    const dest = path.join(dir, 'f.bin');
    await downloadResumable(`${base}/f`, dest, { ...opts, stallMs: 150 });
    expect(readFileSync(dest).equals(payload)).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('fails at once on an HTTP error, without retrying', async () => {
    behavior.status = 404;
    await expect(downloadResumable(`${base}/f`, path.join(dir, 'f.bin'), opts)).rejects.toMatchObject({
      code: 'DownloadFailed',
      message: expect.stringContaining('HTTP 404'),
    });
    expect(requests).toHaveLength(1);
  });

  it('says to check the internet connection when the server cannot be reached', async () => {
    await new Promise((resolve) => server.close(resolve));
    await expect(downloadResumable(`${base}/f`, path.join(dir, 'f.bin'), { ...opts, attempts: 2 })).rejects.toMatchObject({
      code: 'DownloadFailed',
      message: expect.stringMatching(/Could not download 127\.0\.0\.1.*internet connection/),
    });
  });

  it('stops on abort and keeps the .part for next time', async () => {
    behavior.stallAfter = 50_000;
    const controller = new AbortController();
    const dest = path.join(dir, 'f.bin');
    const run = downloadResumable(`${base}/f`, dest, { ...opts, signal: controller.signal, stallMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(`${dest}.part`)).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });
});
```

Append to `tests/core/fetch-zip.test.ts`: add `'/bad.zip': Buffer.from('this is not a zip'),` to the `zips` record and this test inside `describe('fetchEntry zip merge', ...)` (before its closing `});`):

```ts
  it('reports an archive that cannot be unpacked and leaves no marker or leftovers', async () => {
    await expect(fetchEntry(entry('bad', '/bad.zip'), dir, () => {})).rejects.toThrow(/Could not unpack bad/);
    expect(existsSync(path.join(dir, 'llama', '.sha256'))).toBe(false);
    expect(existsSync(path.join(dir, 'bad.zip'))).toBe(false);
  });
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/core/download.test.ts tests/core/fetch-zip.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `src/core/setup/download.ts`:

```ts
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';
import { BgtError } from '../errors';

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?(received: number, total: number): void;
  /** No bytes for this long counts as a stalled connection, which is retried. */
  stallMs?: number;
  /** Tries per call, counting the first. */
  attempts?: number;
  backoffMs?: number;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return `${err.message}${cause}`;
}

/** One request; resumes from `<part>` when it exists. Throws a plain Error for anything worth retrying. */
async function transfer(url: string, part: string, opts: DownloadOptions): Promise<void> {
  const start = existsSync(part) ? statSync(part).size : 0;
  const stall = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal;
  const stallMs = opts.stallMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), stallMs);
  };
  arm();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal,
      headers: { 'User-Agent': 'kikitori', ...(start > 0 ? { Range: `bytes=${start}-` } : {}) },
    });
    if (res.status === 416) {
      rmSync(part, { force: true });
      throw new Error('the partial file did not match the server, starting over');
    }
    if (!res.ok || !res.body) throw new BgtError('DownloadFailed', `GET ${url} failed with HTTP ${res.status}.`);
    const resumed = res.status === 206 && start > 0;
    const base = resumed ? start : 0;
    const length = Number(res.headers.get('content-length') ?? 0);
    const total = length > 0 ? base + length : 0;
    let received = base;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        arm();
        opts.onProgress?.(received, total);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream),
      counter,
      createWriteStream(part, { flags: resumed ? 'a' : 'w' }),
      { signal },
    );
    if (total > 0 && received !== total) throw new Error('the connection closed early');
  } catch (err) {
    if (stall.signal.aborted && !opts.signal?.aborted) {
      throw new Error(`the connection stalled (no data for ${Math.round(stallMs / 1000)} s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads `url` to `dest` through `<dest>.part`, resuming with a Range request after an interruption or a retry.
 * Aborting rejects with `signal.reason` and keeps the partial file.
 */
export async function downloadResumable(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const attempts = opts.attempts ?? 4;
  mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      await transfer(url, part, opts);
      renameSync(part, dest);
      return;
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (err instanceof BgtError) throw err; // an HTTP error will not get better by asking again
      lastError = describeError(err);
    }
    if (attempt < attempts) {
      try {
        await sleep((opts.backoffMs ?? 1500) * attempt, undefined, { signal: opts.signal });
      } catch {
        throw opts.signal?.reason;
      }
    }
  }
  throw new BgtError(
    'DownloadFailed',
    `Could not download ${hostOf(url)}: ${lastError}. Check your internet connection and try again.`,
  );
}
```

- [ ] **Step 4: Rewrite the download parts of `src/core/tools/fetch.ts`**

Replace the imports and `downloadFile` so the file begins:

```ts
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import extract from 'extract-zip';
import { BgtError } from '../errors';
import { downloadResumable } from '../setup/download';
import { markerPath, type LockEntry } from './lock';

export class ChecksumError extends BgtError {
  constructor(message: string) {
    super('DownloadFailed', message);
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  await downloadResumable(url, dest, { onProgress, signal });
}

async function verified(file: string, entry: LockEntry): Promise<void> {
  const actual = await sha256File(file);
  if (actual !== entry.sha256) {
    rmSync(file, { force: true });
    throw new ChecksumError(`Checksum mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}.`);
  }
}
```

and change `fetchEntry` to:

```ts
export async function fetchEntry(
  entry: LockEntry,
  resources: string,
  log: (message: string) => void,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const dest = path.join(resources, entry.dest);

  if (entry.kind === 'file') {
    if (existsSync(dest) && (await sha256File(dest)) === entry.sha256) {
      log(`${entry.id}: up to date`);
      return;
    }
    log(`${entry.id}: downloading ${entry.version}`);
    await downloadFile(entry.url, dest, onProgress, signal);
    await verified(dest, entry);
    return;
  }

  const marker = markerPath(entry, resources);
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === entry.sha256) {
    log(`${entry.id}: up to date`);
    return;
  }
  log(`${entry.id}: downloading ${entry.version}`);
  const zip = path.join(resources, `${entry.id}.zip`);
  await downloadFile(entry.url, zip, onProgress, signal);
  await verified(zip, entry);
  if (!entry.merge) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  try {
    await extract(zip, { dir: path.resolve(dest) });
  } catch (err) {
    rmSync(zip, { force: true });
    if (!entry.merge) rmSync(dest, { recursive: true, force: true });
    throw new BgtError('DownloadFailed', `Could not unpack ${entry.id}: ${err instanceof Error ? err.message : err}`, { cause: err });
  }
  writeFileSync(marker, entry.sha256);
  rmSync(zip, { force: true });
}
```

(`Transform`, `Readable`, `pipeline`, `createWriteStream`, `renameSync` imports are no longer needed in `fetch.ts`.)

- [ ] **Step 5: Run and commit**

Run: `pnpm vitest run tests/core/download.test.ts tests/core/fetch.test.ts tests/core/fetch-zip.test.ts && pnpm typecheck && pnpm lint` — Expected: PASS.

```bash
git add -A && git commit -m "feat(setup): resumable downloads that survive stalls, drops and servers that ignore Range" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Installer (disk check, checksum retry, uninstall, repair)

**Files:**
- Create: `src/core/setup/installer.ts`
- Test: `tests/core/installer.test.ts`

**Interfaces:**
- Consumes: `entryInstalled` (Task 2), `fetchEntry`, `ChecksumError`, `sha256File` (Task 5), `formatBytes`.
- Produces: `interface InstallProgress { componentId; componentTitle; fileId; fileIndex; fileCount; fileReceived; fileTotal; overallReceived; overallTotal; bytesPerSecond; etaSeconds: number | null }`, `freeDiskBytes(dir): number`, `installComponents(o: InstallOptions): Promise<void>` where `InstallOptions { components; resourcesDir; signal?; onProgress?; log?; freeBytes?(dir): number; fetchImpl?: typeof fetchEntry; throttleMs? }`, `uninstallComponents(components, resources): void`, `removeDamaged(components, resources, signal?, onFile?): Promise<LockEntry[]>`.

- [ ] **Step 1: Write the failing tests** — `tests/core/installer.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installComponents,
  removeDamaged,
  uninstallComponents,
  type InstallProgress,
} from '../../src/core/setup/installer';
import { entryInstalled } from '../../src/core/setup/plan';
import type { LockComponent } from '../../src/core/tools/lock';

const bodies: Record<string, Buffer> = {
  '/a.bin': Buffer.alloc(40_000, 1),
  '/b.bin': Buffer.alloc(60_000, 2),
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let server: http.Server;
let base: string;
let res: string;
let hits: Record<string, number>;
let corrupt: Record<string, number>; // how many times to serve wrong bytes first

beforeEach(async () => {
  hits = {};
  corrupt = {};
  res = mkdtempSync(path.join(os.tmpdir(), 'bgt-inst-'));
  server = http.createServer((req, response) => {
    const url = req.url ?? '';
    hits[url] = (hits[url] ?? 0) + 1;
    const body = bodies[url];
    if (!body) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const out = (corrupt[url] ?? 0) >= hits[url] ? Buffer.alloc(body.length, 9) : body;
    response.setHeader('content-length', out.length);
    response.end(out);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(res, { recursive: true, force: true });
});

const component = (id: string, url: string, over: Partial<LockComponent['files'][number]> = {}): LockComponent => ({
  id,
  title: `Title ${id}`,
  features: ['core'],
  tier: 'all',
  license: 'MIT',
  homepage: 'https://example.com',
  files: [
    { id: `${id}-f`, version: '1', url: `${base}${url}`, sha256: sha(bodies[url]), size: bodies[url].length, kind: 'file', dest: `models/${id}.bin`, ...over },
  ],
});

const A = () => component('a', '/a.bin');
const B = () => component('b', '/b.bin');
const plenty = () => 10 ** 12;

describe('installComponents', () => {
  it('downloads what is missing, skips what is installed and reports progress up to the total', async () => {
    const events: InstallProgress[] = [];
    await installComponents({ components: [A()], resourcesDir: res, freeBytes: plenty, throttleMs: 0 });
    expect(hits['/a.bin']).toBe(1);
    await installComponents({ components: [A(), B()], resourcesDir: res, freeBytes: plenty, throttleMs: 0, onProgress: (p) => events.push(p) });
    expect(hits['/a.bin']).toBe(1);
    expect(hits['/b.bin']).toBe(1);
    expect(entryInstalled(B().files[0], res)).toBe(true);
    const last = events.at(-1) as InstallProgress;
    expect(last).toMatchObject({ componentId: 'b', fileIndex: 1, fileCount: 1, overallReceived: 60_000, overallTotal: 60_000 });
    const received = events.map((e) => e.overallReceived);
    expect([...received].sort((x, y) => x - y)).toEqual(received);
  });

  it('refuses before downloading anything when the disk is too small, naming the shortfall', async () => {
    await expect(
      installComponents({ components: [A(), B()], resourcesDir: res, freeBytes: () => 50_000 }),
    ).rejects.toMatchObject({ code: 'DownloadFailed', message: expect.stringMatching(/Not enough free disk space.*short by/) });
    expect(Object.keys(hits)).toHaveLength(0);
  });

  it('downloads again once when the checksum does not match', async () => {
    corrupt['/a.bin'] = 1;
    await installComponents({ components: [A()], resourcesDir: res, freeBytes: plenty });
    expect(hits['/a.bin']).toBe(2);
    expect(readFileSync(path.join(res, 'models', 'a.bin')).equals(bodies['/a.bin'])).toBe(true);
  });

  it('gives up with a clear message after two corrupted downloads', async () => {
    corrupt['/a.bin'] = 2;
    await expect(installComponents({ components: [A()], resourcesDir: res, freeBytes: plenty })).rejects.toMatchObject({
      message: expect.stringContaining('corrupted in both downloads'),
    });
    expect(existsSync(path.join(res, 'models', 'a.bin'))).toBe(false);
  });

  it('stops when aborted and keeps the finished components', async () => {
    const controller = new AbortController();
    await expect(
      installComponents({
        components: [A(), B()],
        resourcesDir: res,
        freeBytes: plenty,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.componentId === 'b') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(entryInstalled(A().files[0], res)).toBe(true);
    expect(entryInstalled(B().files[0], res)).toBe(false);
  });
});

describe('uninstallComponents', () => {
  it('removes files, unpacked archive folders and leftovers', () => {
    const file = path.join(res, 'models', 'a.bin');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x');
    writeFileSync(`${file}.part`, 'x');
    mkdirSync(path.join(res, 'llama'), { recursive: true });
    writeFileSync(path.join(res, 'llama', 'llama-server.exe'), 'x');
    const archive = { ...A(), files: [{ ...A().files[0], id: 'zip', kind: 'zip' as const, dest: 'llama' }] };
    uninstallComponents([A(), archive], res);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.part`)).toBe(false);
    expect(existsSync(path.join(res, 'llama'))).toBe(false);
  });
});

describe('removeDamaged', () => {
  it('deletes files whose checksum is wrong, keeps good ones and never touches self-updating files', async () => {
    await installComponents({ components: [A(), B()], resourcesDir: res, freeBytes: plenty });
    writeFileSync(path.join(res, 'models', 'a.bin'), Buffer.alloc(40_000, 7)); // same size, wrong bytes
    const updating = component('c', '/a.bin', { selfUpdates: true });
    writeFileSync(path.join(res, 'models', 'c.bin'), 'replaced by yt-dlp -U');
    const removed = await removeDamaged([A(), B(), updating], res);
    expect(removed.map((e) => e.id)).toEqual(['a-f']);
    expect(existsSync(path.join(res, 'models', 'a.bin'))).toBe(false);
    expect(existsSync(path.join(res, 'models', 'b.bin'))).toBe(true);
    expect(existsSync(path.join(res, 'models', 'c.bin'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/core/installer.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `src/core/setup/installer.ts`:

```ts
import { existsSync, mkdirSync, rmSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { formatBytes } from '../bytes';
import { BgtError } from '../errors';
import { ChecksumError, fetchEntry, sha256File } from '../tools/fetch';
import type { LockComponent, LockEntry } from '../tools/lock';
import { entryInstalled } from './plan';

export interface InstallProgress {
  componentId: string;
  componentTitle: string;
  fileId: string;
  /** 1-based position among the files that still had to be downloaded. */
  fileIndex: number;
  fileCount: number;
  fileReceived: number;
  fileTotal: number;
  overallReceived: number;
  overallTotal: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

/** Free bytes on the drive that holds `dir` (or its nearest existing parent). */
export function freeDiskBytes(dir: string): number {
  let probe = path.resolve(dir);
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const s = statfsSync(probe);
  return Number(s.bavail) * Number(s.bsize);
}

export interface InstallOptions {
  components: LockComponent[];
  resourcesDir: string;
  signal?: AbortSignal;
  onProgress?(p: InstallProgress): void;
  log?(message: string): void;
  freeBytes?(dir: string): number;
  fetchImpl?: typeof fetchEntry;
  /** Minimum time between progress events (the last event of a file is always sent). */
  throttleMs?: number;
}

async function installEntry(
  fetchImpl: typeof fetchEntry,
  entry: LockEntry,
  resources: string,
  log: (m: string) => void,
  onProgress: (received: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fetchImpl(entry, resources, log, (received) => onProgress(received), signal);
      return;
    } catch (err) {
      if (!(err instanceof ChecksumError)) throw err;
      if (attempt === 1) {
        log(`${entry.id}: checksum mismatch, downloading it again`);
        continue;
      }
      throw new BgtError(
        'DownloadFailed',
        `${entry.id} was corrupted in both downloads. Try again later; the file on the server may have changed.`,
        { cause: err },
      );
    }
  }
}

/** Downloads and unpacks every file of `components` that is not installed yet, one at a time. */
export async function installComponents(o: InstallOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const fetchImpl = o.fetchImpl ?? fetchEntry;
  const throttleMs = o.throttleMs ?? 250;
  const work = o.components.flatMap((c) =>
    c.files.filter((f) => !entryInstalled(f, o.resourcesDir)).map((f) => ({ c, f })),
  );
  if (work.length === 0) return;

  const overallTotal = work.reduce((n, w) => n + w.f.size, 0);
  const need = overallTotal + Math.max(...work.map((w) => w.f.size)); // unpacking needs room next to the archive
  mkdirSync(o.resourcesDir, { recursive: true });
  const free = (o.freeBytes ?? freeDiskBytes)(o.resourcesDir);
  if (free < need) {
    throw new BgtError(
      'DownloadFailed',
      `Not enough free disk space: ${formatBytes(need)} needed, ${formatBytes(free)} free (short by ${formatBytes(need - free)}). Free some space and try again.`,
    );
  }

  const startedAt = Date.now();
  let session = 0;
  let finished = 0;
  let lastEmit = 0;
  for (let i = 0; i < work.length; i++) {
    const { c, f } = work[i];
    o.signal?.throwIfAborted();
    let lastReceived = -1;
    const report = (received: number, force: boolean) => {
      if (lastReceived >= 0) session += Math.max(0, received - lastReceived);
      lastReceived = received;
      const now = Date.now();
      if (!force && now - lastEmit < throttleMs) return;
      lastEmit = now;
      const bytesPerSecond = session / (Math.max(1, now - startedAt) / 1000);
      const overallReceived = finished + received;
      o.onProgress?.({
        componentId: c.id,
        componentTitle: c.title,
        fileId: f.id,
        fileIndex: i + 1,
        fileCount: work.length,
        fileReceived: received,
        fileTotal: f.size,
        overallReceived,
        overallTotal,
        bytesPerSecond: Math.round(bytesPerSecond),
        etaSeconds: bytesPerSecond > 1 ? Math.round((overallTotal - overallReceived) / bytesPerSecond) : null,
      });
    };
    report(0, true);
    await installEntry(fetchImpl, f, o.resourcesDir, log, (received) => report(received, false), o.signal);
    report(f.size, true);
    finished += f.size;
  }
}

/** Removes the files and unpacked folders of `components` (and any partial downloads). */
export function uninstallComponents(components: LockComponent[], resources: string): void {
  for (const c of components) {
    for (const f of c.files) {
      const dest = path.join(resources, f.dest);
      if (f.kind === 'zip') {
        rmSync(dest, { recursive: true, force: true });
        rmSync(path.join(resources, `${f.id}.zip`), { force: true });
        rmSync(path.join(resources, `${f.id}.zip.part`), { force: true });
      } else {
        rmSync(dest, { force: true });
        rmSync(`${dest}.part`, { force: true });
      }
    }
  }
}

/** Hashes installed model and data files and deletes the ones that do not match; returns what it deleted. */
export async function removeDamaged(
  components: LockComponent[],
  resources: string,
  signal?: AbortSignal,
  onFile?: (entry: LockEntry) => void,
): Promise<LockEntry[]> {
  const removed: LockEntry[] = [];
  for (const c of components) {
    for (const f of c.files) {
      if (f.kind !== 'file' || f.selfUpdates) continue;
      const file = path.join(resources, f.dest);
      if (!existsSync(file)) continue;
      signal?.throwIfAborted();
      onFile?.(f);
      if ((await sha256File(file)) !== f.sha256) {
        rmSync(file, { force: true });
        removed.push(f);
      }
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run tests/core/installer.test.ts && pnpm typecheck && pnpm lint` — Expected: PASS.

```bash
git add -A && git commit -m "feat(setup): installer with disk check, checksum retry, uninstall and repair helpers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Tier-aware runtime

**Files:**
- Modify: `src/core/tools/paths.ts`, `src/core/pipeline/stages.ts`, `src/app/main/run-submission.ts`, `src/core/tools/ytdlp.ts`, `src/cli/index.ts`, `src/cli/run.ts`, `src/cli/llm.ts`, `src/cli/doctor.ts`
- Test: `tests/core/paths.test.ts`, `tests/core/stages.test.ts`, `tests/app/run-submission.test.ts`, `tests/core/ytdlp-download.test.ts`

**Interfaces:**
- Consumes: `currentTier`, `defaultTranscribeModel` (Task 4), `transcribeModelName` (Task 2), `createRealModelPool({ tier })` (Task 1).
- Produces: `StageOptions.autoGlossary?: boolean` (false skips the model glossary pass, user entries still apply), `RunSubmissionEnv.autoGlossary?(): boolean`, ffmpeg resolved from `resources/ffmpeg/**/ffmpeg.exe` before PATH.

- [ ] **Step 1: Write the failing tests**

`tests/core/paths.test.ts`: replace the test `prefers a bundled binary over PATH` with

```ts
  it('prefers a bundled binary over PATH, finding ffmpeg in the versioned folder of the Gyan archive', () => {
    const bundled = touch('res', 'ffmpeg', 'ffmpeg-9.0.2-essentials_build', 'bin', exeName('ffmpeg'));
    const pathDir = path.dirname(touch('onpath', exeName('ffmpeg')));
    expect(resolveTool('ffmpeg', { resourcesDir: path.join(root, 'res'), pathEnv: pathDir })).toBe(bundled);
  });
```

`tests/core/stages.test.ts`: add inside `describe('runLlmStages', ...)`:

```ts
  it('skips the automatic name list when asked to, still applies the user glossary and never loads the general model', async () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い', 'あ']);
    const pool = fakePool({ general: scriptedChat(generalAnswer), translate: scriptedChat(echoTranslate()) });
    const logs: string[] = [];
    await runLlmStages(
      { repo, stages, job, outDir: dir, pool, log: (m) => logs.push(m) },
      { ...opts, translate: true, autoGlossary: false, userGlossary: { あ: 'Ah!' } },
    );
    expect(pool.started).toEqual(['translate']);
    expect(stages.listGlossary(job.id)).toEqual([{ ja: 'あ', en: 'Ah!', source: 'user' }]);
    expect(stages.getStage(job.id, 'glossary')).not.toBe('done');
    expect(logs.join('\n')).toContain('Skipping the automatic name list');
  });
```

`tests/app/run-submission.test.ts`: add inside `describe('runSubmission', ...)`:

```ts
  it('skips the automatic name list when the summaries model is not installed', async () => {
    const t = setup();
    t.env.autoGlossary = () => false;
    await runSubmission(t.env, sub({ translate: true }), t.ctx);
    expect(t.pool.used).toEqual(['translate']);
    expect(t.stages.getStage(1, 'translate')).toBe('done');
  });
```

`tests/core/ytdlp-download.test.ts`: add inside `describe('downloadAudio retries', ...)`:

```ts
  it('does not retry a failure that cannot change', async () => {
    const s = script([fail('ERROR: [youtube] x: Requested format is not available')]);
    const err = await downloadAudio({ ...base, workDir: dir, run: s.run }).catch((e) => e);
    expect(err.code).toBe('DownloadFailed');
    expect(err.message).toContain('cannot download this video');
    expect(err.message).toContain('Requested format is not available');
    expect(s.calls).toHaveLength(1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/core/paths.test.ts tests/core/stages.test.ts tests/app/run-submission.test.ts tests/core/ytdlp-download.test.ts`
Expected: the four new or changed tests FAIL.

- [ ] **Step 3: `src/core/tools/paths.ts`**

Replace the `BUNDLED_DIR` constant and the `resolveTool` body up to the PATH lookup with:

```ts
const BUNDLED_DIR: Record<ToolName, string> = {
  'yt-dlp': 'bin',
  ffmpeg: 'ffmpeg',
  'whisper-cli': 'whisper',
  'llama-server': 'llama',
};

/** These archives unpack into a versioned subfolder, so the program is searched for. */
const NESTED = new Set<ToolName>(['ffmpeg', 'whisper-cli', 'llama-server']);

export interface ResolveOptions {
  resourcesDir?: string;
  pathEnv?: string;
}

/** Order: bundled copy in resources/, then PATH. */
export function resolveTool(name: ToolName, opts: ResolveOptions = {}): string {
  const exe = exeName(name);
  const dir = path.join(opts.resourcesDir ?? resourcesDir(), BUNDLED_DIR[name]);
  const bundled = NESTED.has(name)
    ? findFileRecursive(dir, exe)
    : existsSync(path.join(dir, exe))
      ? path.join(dir, exe)
      : null;
  if (bundled) return bundled;
```

and change the `hint` to:

```ts
  const hint =
    name === 'ffmpeg'
      ? 'Open Tools in the app to download it, or install ffmpeg (for example "winget install Gyan.FFmpeg") and make sure it is on PATH.'
      : 'Open Tools in the app or run "pnpm setup:tools" to download it.';
```

- [ ] **Step 4: `src/core/pipeline/stages.ts`**

Add to `StageOptions`:

```ts
  /** false skips the model-written name list (the general model is not installed); user entries still apply. */
  autoGlossary?: boolean;
```

and replace `    if (wantGlossary) {\n      await guard('glossary', async () => {` ... through the closing of that block with:

```ts
    if (wantGlossary && opts.autoGlossary === false) {
      stages.upsertGlossary(
        job.id,
        Object.entries(opts.userGlossary).map(([ja, en]) => ({ ja, en, source: 'user' as const })),
      );
      log('Skipping the automatic name list because the summaries model is not installed.');
    } else if (wantGlossary) {
      await guard('glossary', async () => {
        log('Extracting names and terms...');
        const llm = await pool.use('general', signal);
        await runGlossaryStage({ repo, stages, llm, jobId: job.id, userGlossary: opts.userGlossary, signal, log, progress: ctx.progress });
      });
    }
```

- [ ] **Step 5: `src/app/main/run-submission.ts`**

Add to `RunSubmissionEnv`:

```ts
  /** False when the general (summaries) model is not installed: the automatic name list is skipped. */
  autoGlossary?(): boolean;
```

and change the options object passed to `runLlmStages` to
`{ translate: options.translate, summarize: options.summarize, skim: options.skim, userGlossary, autoGlossary: env.autoGlossary?.() }`.

- [ ] **Step 6: `src/core/tools/ytdlp.ts`** — add above `downloadAudio`:

```ts
/** Failures that asking again cannot fix; they are reported at once instead of after three attempts. */
const PERMANENT =
  /Requested format is not available|No space left on device|Private video|members-only|Video unavailable|This video is (?:private|unavailable)|Sign in to confirm/i;
```

and in the loop replace `      lastError = tailLines(r.stderr, 3);` with

```ts
      lastError = tailLines(r.stderr, 3);
      if (PERMANENT.test(r.stderr)) {
        throw new BgtError('DownloadFailed', `yt-dlp cannot download this video: ${lastError}. ${HINT}`);
      }
```

- [ ] **Step 7: CLI and doctor use the saved tier**

`src/cli/index.ts`: replace the `--model` option line with
`  .option('--model <name>', 'whisper model name (ggml-<name>.bin); default: the one for the installed tier')`.

`src/cli/run.ts`: change `  model: string;` to `  model?: string;`; add `import { defaultTranscribeModel } from '../core/setup/settings';`; after `const endMs = ...` add `const model = opts.model ?? defaultTranscribeModel(dataDir());` and use `model` instead of `opts.model` in both the `createRealDeps({...})` call and the `runJob({...})` call.

`src/cli/llm.ts`: add `import { currentTier, defaultTranscribeModel } from '../core/setup/settings';`, replace `model: 'large-v3'` with `model: defaultTranscribeModel(dataDir())` and `createRealModelPool({ log: console.log, tier: () => 'gpu' })` with `createRealModelPool({ log: console.log, tier: () => currentTier(dataDir()) })`.

`src/cli/doctor.ts`: add imports `import { transcribeModelName } from '../core/setup/components';`, `import { currentTier } from '../core/setup/settings';`, change the paths import to also take `dataDir`; at the top of `doctorCommand` add `const tier = currentTier(dataDir());\n  console.log(\`INFO     tier             ${tier}\`);`; replace the whisper model block with

```ts
  const model = transcribeModelName(tier);
  try {
    line(`model ${model}`, modelPath(`ggml-${model}.bin`), true);
  } catch (err) {
    line(`model ${model}`, err instanceof Error ? err.message : String(err), false);
  }
```

and the id list with `for (const id of [\`model-translate-${tier}\`, \`model-general-${tier}\`])`.

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test` — Expected: all green. Then `pnpm kikitori doctor` — Expected: still reports the author's GPU install (ffmpeg from PATH is fine).

```bash
git add -A && git commit -m "feat: tier-aware runtime, ffmpeg from resources, skip name list without the summaries model, no retry of permanent yt-dlp errors" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Packaged app paths, shared setup types and SetupService

**Files:**
- Create: `src/app/main/app-paths.ts`, `src/app/main/setup-service.ts`
- Modify: `src/app/shared/ipc.ts` (types only), `src/app/main/validate.ts`
- Test: `tests/app/app-paths.test.ts`, `tests/app/setup-service.test.ts`, `tests/app/validate.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 2 to 6 (`buildPlan`, `componentInstalled`, `wantsOfOptions`, settings, `installComponents`, `uninstallComponents`, `removeDamaged`, `freeDiskBytes`, `detectHardware`).
- Produces (`src/app/shared/ipc.ts`):
  - `type Tier`, `interface SetupFeatures { translation: boolean; summaries: boolean }`, `interface SetupSelection { tier: Tier; features: SetupFeatures }`
  - `interface SetupComponentInfo { id; title; tier: 'all' | Tier; sizeBytes: number; installed: boolean }`
  - `interface SetupState { needsWizard: boolean; completed: boolean; installing: boolean; tier: Tier; features: SetupFeatures; components: SetupComponentInfo[]; resourcesDir: string }`
  - `interface HardwareReport { gpuName: string | null; vramMb: number | null; recommendedTier: Tier; reason: string; ramMb: number; cores: number; freeDiskBytes: number }`
  - `interface SetupPlanView { selection: SetupSelection; components: SetupComponentInfo[]; missingBytes: number; freeDiskBytes: number }`
  - `interface SetupProgress { phase: 'idle' | 'installing' | 'done' | 'failed' | 'cancelled'; progress: InstallProgress | null; message: string | null }`
- Produces: `resolveAppPaths(input): AppPaths`, `parseSetupSelection(raw): SetupSelection`, `class SetupService` with `state()`, `detect()`, `plan(sel)`, `missingFor(options)`, `start(sel): void`, `cancel(): Promise<void>`, `repair(): void`, `updateYtDlp(): Promise<string>`, `autoGlossaryAvailable(): boolean`, `whenIdle(): Promise<void>`.

- [ ] **Step 1: Add the shared types** to `src/app/shared/ipc.ts` (after the existing `export type` lines near the top):

```ts
import type { InstallProgress } from '../../core/setup/installer';
import type { Tier } from '../../core/tools/lock';

export type { InstallProgress, Tier };

export interface SetupFeatures {
  translation: boolean;
  summaries: boolean;
}
export interface SetupSelection {
  tier: Tier;
  features: SetupFeatures;
}
export interface SetupComponentInfo {
  id: string;
  title: string;
  tier: 'all' | Tier;
  sizeBytes: number;
  installed: boolean;
}
export interface SetupState {
  /** True when the first-run wizard must be shown (setup never finished, or a required tool is gone). */
  needsWizard: boolean;
  completed: boolean;
  installing: boolean;
  tier: Tier;
  features: SetupFeatures;
  components: SetupComponentInfo[];
  resourcesDir: string;
}
export interface HardwareReport {
  gpuName: string | null;
  vramMb: number | null;
  recommendedTier: Tier;
  reason: string;
  ramMb: number;
  cores: number;
  freeDiskBytes: number;
}
export interface SetupPlanView {
  /** What would be installed for this view; `components` lists everything it needs, with install state. */
  selection: SetupSelection;
  components: SetupComponentInfo[];
  missingBytes: number;
  freeDiskBytes: number;
}
export interface SetupProgress {
  phase: 'idle' | 'installing' | 'done' | 'failed' | 'cancelled';
  progress: InstallProgress | null;
  message: string | null;
}
```

- [ ] **Step 2: Write the failing tests**

`tests/app/app-paths.test.ts`:

```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../src/app/main/app-paths';

const base = {
  appPath: 'C:/proj',
  resourcesPath: 'C:/Program Files/App/resources',
  appData: 'C:/Users/me/AppData/Roaming',
  documents: 'C:/Users/me/Documents',
};

describe('resolveAppPaths', () => {
  it('development keeps the project folders', () => {
    expect(resolveAppPaths({ ...base, packaged: false, env: {} })).toEqual({
      projectRoot: 'C:/proj',
      resourcesDir: path.join('C:/proj', 'resources'),
      dataDir: path.join('C:/proj', 'data'),
      outDir: path.join('C:/proj', 'output'),
      userData: null,
    });
  });

  it('a packaged app keeps tools and data in AppData, subtitles in Documents, and the lock file next to the app', () => {
    const p = resolveAppPaths({ ...base, packaged: true, env: {} });
    const profile = path.join(base.appData, 'Kikitori');
    expect(p).toEqual({
      projectRoot: base.resourcesPath,
      resourcesDir: path.join(profile, 'resources'),
      dataDir: path.join(profile, 'data'),
      outDir: path.join(base.documents, 'Kikitori'),
      userData: profile,
    });
  });

  it('KTR_USER_DATA moves everything, including the output, into one folder (empty-profile testing)', () => {
    const p = resolveAppPaths({ ...base, packaged: true, env: { KTR_USER_DATA: 'D:/profile' } });
    expect(p.resourcesDir).toBe(path.join('D:/profile', 'resources'));
    expect(p.outDir).toBe(path.join('D:/profile', 'output'));
    expect(p.userData).toBe('D:/profile');
    const dev = resolveAppPaths({ ...base, packaged: false, env: { KTR_USER_DATA: 'D:/profile' } });
    expect(dev.projectRoot).toBe('C:/proj');
    expect(dev.dataDir).toBe(path.join('D:/profile', 'data'));
  });

  it('the individual KTR_* variables still win', () => {
    const p = resolveAppPaths({
      ...base,
      packaged: true,
      env: { KTR_PROJECT_ROOT: 'X', KTR_RESOURCES_DIR: 'R', KTR_DATA_DIR: 'D', KTR_OUTPUT_DIR: 'O' },
    });
    expect([p.projectRoot, p.resourcesDir, p.dataDir, p.outDir]).toEqual(['X', 'R', 'D', 'O']);
  });
});
```

Append to `tests/app/validate.test.ts` (add `parseSetupSelection` to its import from `../../src/app/main/validate`):

```ts
describe('parseSetupSelection', () => {
  it('accepts a tier and two feature flags', () => {
    expect(parseSetupSelection({ tier: 'cpu', features: { translation: true, summaries: false } })).toEqual({
      tier: 'cpu',
      features: { translation: true, summaries: false },
    });
  });

  it('rejects anything else', () => {
    for (const bad of [null, 'gpu', { tier: 'tpu', features: { translation: true, summaries: true } }, { tier: 'gpu' }, { tier: 'gpu', features: { translation: 1, summaries: true } }]) {
      expect(() => parseSetupSelection(bad)).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    }
  });
});
```

`tests/app/setup-service.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SetupService, type SetupServiceDeps } from '../../src/app/main/setup-service';
import type { SetupProgress } from '../../src/app/shared/ipc';
import { readSettings, writeSettings } from '../../src/core/setup/settings';
import type { HardwareInfo } from '../../src/core/setup/hardware';
import { fakeLock, installFake } from '../helpers/lock-fakes';

let res: string;
let data: string;
beforeEach(() => {
  res = mkdtempSync(path.join(os.tmpdir(), 'bgt-svc-res-'));
  data = mkdtempSync(path.join(os.tmpdir(), 'bgt-svc-data-'));
});
afterEach(() => {
  rmSync(res, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

const cpuBox: HardwareInfo = { gpus: [], best: null, tier: 'cpu', reason: 'No NVIDIA graphics card was found.', ramMb: 16_000, cores: 8 };
const CPU_BASE = ['yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu'];

function setup(over: Partial<SetupServiceDeps> = {}) {
  const lock = fakeLock(10);
  const emitted: SetupProgress[] = [];
  const installs: string[][] = [];
  const uninstalled: string[][] = [];
  const deps: SetupServiceDeps = {
    lock,
    resourcesDir: res,
    dataDir: data,
    hardware: async () => cpuBox,
    install: async (o) => {
      installs.push(o.components.map((c) => c.id));
      installFake(lock, o.resourcesDir, o.components.map((c) => c.id));
    },
    uninstall: (components) => void uninstalled.push(components.map((c) => c.id)),
    removeDamaged: async () => [],
    freeBytes: () => 10 ** 12,
    updateYtDlp: async () => 'yt-dlp is up to date',
    emit: (p) => emitted.push(p),
    log: () => {},
    ...over,
  };
  return { service: new SetupService(deps), lock, emitted, installs, uninstalled };
}

const cpuNoLlm = { tier: 'cpu' as const, features: { translation: false, summaries: false } };

describe('SetupService', () => {
  it('a fresh profile needs the wizard and lists every component as not installed', () => {
    const { service } = setup();
    const s = service.state();
    expect(s).toMatchObject({ needsWizard: true, completed: false, installing: false });
    expect(s.components).toHaveLength(13);
    expect(s.components.every((c) => !c.installed)).toBe(true);
  });

  it('detect maps the hardware and adds the free disk space', async () => {
    const { service } = setup();
    expect(await service.detect()).toMatchObject({ gpuName: null, recommendedTier: 'cpu', freeDiskBytes: 10 ** 12, cores: 8 });
  });

  it('start installs what is missing, saves the choice, reports done and ends the wizard', async () => {
    const { service, emitted, installs } = setup();
    service.start(cpuNoLlm);
    await service.whenIdle();
    expect(installs).toEqual([CPU_BASE]);
    expect(emitted[0].phase).toBe('installing');
    expect(emitted.at(-1)?.phase).toBe('done');
    expect(readSettings(data)).toEqual({ version: 1, tier: 'cpu', features: cpuNoLlm.features, setupCompleted: true });
    expect(service.state()).toMatchObject({ needsWizard: false, completed: true, tier: 'cpu', installing: false });
  });

  it('refuses a second start while one is running', async () => {
    let release = () => {};
    const { service } = setup({ install: () => new Promise<void>((resolve) => (release = resolve)) });
    service.start(cpuNoLlm);
    expect(() => service.start(cpuNoLlm)).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    release();
    await service.whenIdle();
  });

  it('a failure is reported with its message and the setup stays unfinished', async () => {
    const { service, emitted } = setup({
      install: async () => {
        throw new Error('Not enough free disk space');
      },
    });
    service.start(cpuNoLlm);
    await service.whenIdle();
    expect(emitted.at(-1)).toMatchObject({ phase: 'failed', message: 'Not enough free disk space' });
    expect(readSettings(data)?.setupCompleted).toBe(false);
    expect(service.state().needsWizard).toBe(true);
  });

  it('cancel aborts the download and reports it as paused, not failed', async () => {
    const { service, emitted } = setup({
      install: (o) =>
        new Promise<void>((_resolve, reject) => o.signal?.addEventListener('abort', () => reject(o.signal?.reason), { once: true })),
    });
    service.start(cpuNoLlm);
    await service.cancel();
    expect(emitted.at(-1)).toMatchObject({ phase: 'cancelled' });
    expect(service.state().installing).toBe(false);
  });

  it('switching tier removes the old tier first, then installs the new one', async () => {
    const { service, lock, uninstalled, installs } = setup();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);
    writeSettings(data, { version: 1, tier: 'gpu', features: { translation: false, summaries: false }, setupCompleted: true });
    service.start(cpuNoLlm);
    await service.whenIdle();
    expect(uninstalled[0]).toContain('whisper-gpu');
    expect(uninstalled[0]).not.toContain('yt-dlp');
    expect(installs).toEqual([['whisper-cpu', 'model-transcribe-cpu']]);
    expect(readSettings(data)).toMatchObject({ tier: 'cpu', setupCompleted: true });
  });

  it('plan counts only the missing bytes and shows the free disk space', () => {
    const { service, lock } = setup();
    installFake(lock, res, ['yt-dlp', 'ffmpeg']);
    const view = service.plan(cpuNoLlm);
    expect(view.missingBytes).toBe(30);
    expect(view.freeDiskBytes).toBe(10 ** 12);
    expect(view.components.map((c) => [c.id, c.installed])).toEqual([
      ['yt-dlp', true], ['ffmpeg', true], ['vad', false], ['whisper-cpu', false], ['model-transcribe-cpu', false],
    ]);
  });

  it('missingFor adds what a job needs to the features already chosen', () => {
    const { service, lock } = setup();
    installFake(lock, res, CPU_BASE);
    writeSettings(data, { version: 1, tier: 'cpu', features: { translation: false, summaries: false }, setupCompleted: true });
    const view = service.missingFor({ translate: true, summarize: false, skim: false, maxMinutes: 30, model: 'x' });
    expect(view.selection).toEqual({ tier: 'cpu', features: { translation: true, summaries: false } });
    expect(view.components.filter((c) => !c.installed).map((c) => c.id)).toEqual(['llama-cpu', 'model-translate-cpu']);
  });

  it('autoGlossaryAvailable follows whether the general model is installed', () => {
    const { service, lock } = setup();
    writeSettings(data, { version: 1, tier: 'cpu', features: { translation: true, summaries: true }, setupCompleted: true });
    expect(service.autoGlossaryAvailable()).toBe(false);
    installFake(lock, res, ['model-general-cpu']);
    expect(service.autoGlossaryAvailable()).toBe(true);
  });

  it('repair deletes damaged files and downloads them again', async () => {
    const { service, lock, installs } = setup({
      removeDamaged: async (components) => {
        const bad = components.find((c) => c.id === 'vad');
        if (bad) installFakeRemove(res, bad.files[0].dest);
        return bad ? [bad.files[0]] : [];
      },
    });
    installFake(lock, res, CPU_BASE);
    writeSettings(data, { version: 1, tier: 'cpu', features: { translation: false, summaries: false }, setupCompleted: true });
    service.repair();
    await service.whenIdle();
    expect(installs).toEqual([['vad']]);
  });

  it('updateYtDlp returns the updater output', async () => {
    expect(await setup().service.updateYtDlp()).toBe('yt-dlp is up to date');
  });
});

import { rmSync as rm } from 'node:fs';
function installFakeRemove(resources: string, dest: string): void {
  rm(path.join(resources, dest), { force: true });
}
```

- [ ] **Step 3: Run to verify failure** — `pnpm vitest run tests/app/app-paths.test.ts tests/app/validate.test.ts tests/app/setup-service.test.ts` — Expected: FAIL (modules and `parseSetupSelection` missing).

- [ ] **Step 4: Implement**

`src/app/main/app-paths.ts`:

```ts
import path from 'node:path';

export interface AppPathsInput {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
  appData: string;
  documents: string;
  env: Record<string, string | undefined>;
}

export interface AppPaths {
  /** Where `tools.lock.json` lives. */
  projectRoot: string;
  /** Downloaded tools and models. */
  resourcesDir: string;
  /** Database, settings, work files. */
  dataDir: string;
  /** Subtitles and summaries. */
  outDir: string;
  /** Electron's userData folder to use, or null to keep the default. */
  userData: string | null;
}

export function resolveAppPaths(a: AppPathsInput): AppPaths {
  const { env } = a;
  const profile = env.KTR_USER_DATA ?? (a.packaged ? path.join(a.appData, 'Kikitori') : null);
  const base = profile ?? a.appPath;
  return {
    projectRoot: env.KTR_PROJECT_ROOT ?? (a.packaged ? a.resourcesPath : a.appPath),
    resourcesDir: env.KTR_RESOURCES_DIR ?? path.join(base, 'resources'),
    dataDir: env.KTR_DATA_DIR ?? path.join(base, 'data'),
    outDir:
      env.KTR_OUTPUT_DIR ??
      (a.packaged && !env.KTR_USER_DATA ? path.join(a.documents, 'Kikitori') : path.join(base, 'output')),
    userData: profile,
  };
}
```

`src/app/main/validate.ts`: add `SetupSelection` to the `import type { SubmitRequest } from '../shared/ipc';` line and append

```ts
export function parseSetupSelection(raw: unknown): SetupSelection {
  if (!isObject(raw)) throw invalid('Invalid setup request.');
  const { tier, features } = raw;
  if (tier !== 'gpu' && tier !== 'cpu') throw invalid('Invalid hardware tier.');
  if (!isObject(features) || typeof features.translation !== 'boolean' || typeof features.summaries !== 'boolean') {
    throw invalid('Invalid feature selection.');
  }
  return { tier, features: { translation: features.translation, summaries: features.summaries } };
}
```

`src/app/main/setup-service.ts`:

```ts
import type { SubmissionOptions } from '../../core/db/submission-repo';
import { BgtError } from '../../core/errors';
import { wantsOfOptions } from '../../core/setup/components';
import type { HardwareInfo } from '../../core/setup/hardware';
import type { installComponents, removeDamaged, uninstallComponents } from '../../core/setup/installer';
import { buildPlan, componentInstalled } from '../../core/setup/plan';
import { defaultSettings, readSettings, writeSettings, type Settings } from '../../core/setup/settings';
import { componentBytes, findComponent, type Lock, type LockComponent } from '../../core/tools/lock';
import type {
  HardwareReport,
  SetupComponentInfo,
  SetupPlanView,
  SetupProgress,
  SetupSelection,
  SetupState,
} from '../shared/ipc';

export interface SetupServiceDeps {
  lock: Lock;
  resourcesDir: string;
  dataDir: string;
  hardware(): Promise<HardwareInfo>;
  install: typeof installComponents;
  uninstall: typeof uninstallComponents;
  removeDamaged: typeof removeDamaged;
  freeBytes(dir: string): number;
  updateYtDlp(): Promise<string>;
  emit(p: SetupProgress): void;
  log(message: string): void;
}

const NO_FEATURES = { translation: false, summaries: false };

/** Runs first-run setup, on-demand downloads, tier switches and repair, one at a time, in the background. */
export class SetupService {
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly d: SetupServiceDeps) {}

  private info(c: LockComponent): SetupComponentInfo {
    return {
      id: c.id,
      title: c.title,
      tier: c.tier,
      sizeBytes: componentBytes(c),
      installed: componentInstalled(c, this.d.resourcesDir),
    };
  }

  private settings(): Settings {
    return readSettings(this.d.dataDir) ?? defaultSettings();
  }

  state(): SetupState {
    const s = this.settings();
    const core = buildPlan(this.d.lock, s.tier, NO_FEATURES, this.d.resourcesDir);
    return {
      needsWizard: !s.setupCompleted || core.missing.length > 0,
      completed: s.setupCompleted,
      installing: this.running !== null,
      tier: s.tier,
      features: s.features,
      components: this.d.lock.components.map((c) => this.info(c)),
      resourcesDir: this.d.resourcesDir,
    };
  }

  async detect(): Promise<HardwareReport> {
    const h = await this.d.hardware();
    return {
      gpuName: h.best?.name ?? null,
      vramMb: h.best?.vramMb ?? null,
      recommendedTier: h.tier,
      reason: h.reason,
      ramMb: h.ramMb,
      cores: h.cores,
      freeDiskBytes: this.d.freeBytes(this.d.resourcesDir),
    };
  }

  plan(sel: SetupSelection): SetupPlanView {
    const plan = buildPlan(this.d.lock, sel.tier, sel.features, this.d.resourcesDir);
    return {
      selection: sel,
      components: plan.required.map((c) => this.info(c)),
      missingBytes: plan.missingBytes,
      freeDiskBytes: this.d.freeBytes(this.d.resourcesDir),
    };
  }

  /** What a job with these options still needs: the chosen features plus what the job asks for. */
  missingFor(options: SubmissionOptions): SetupPlanView {
    const s = this.settings();
    const w = wantsOfOptions(options);
    return this.plan({
      tier: s.tier,
      features: { translation: s.features.translation || w.translation, summaries: s.features.summaries || w.summaries },
    });
  }

  autoGlossaryAvailable(): boolean {
    return componentInstalled(findComponent(this.d.lock, `model-general-${this.settings().tier}`), this.d.resourcesDir);
  }

  start(sel: SetupSelection): void {
    this.launch(async (signal) => {
      const before = readSettings(this.d.dataDir) ?? defaultSettings(sel.tier);
      const switching = before.setupCompleted && before.tier !== sel.tier;
      if (switching) {
        this.d.uninstall(this.d.lock.components.filter((c) => c.tier === before.tier), this.d.resourcesDir);
      }
      const saved: Settings = { version: 1, tier: sel.tier, features: sel.features, setupCompleted: before.setupCompleted && !switching };
      writeSettings(this.d.dataDir, saved);
      await this.installMissing(sel.tier, sel.features, signal);
      writeSettings(this.d.dataDir, { ...saved, setupCompleted: true });
    });
  }

  repair(): void {
    this.launch(async (signal) => {
      const s = readSettings(this.d.dataDir);
      if (!s) throw new BgtError('InvalidInput', 'Nothing is set up yet.');
      const plan = buildPlan(this.d.lock, s.tier, s.features, this.d.resourcesDir);
      const removed = await this.d.removeDamaged(plan.required, this.d.resourcesDir, signal, (f) =>
        this.d.emit({ phase: 'installing', progress: null, message: `Checking ${f.id}...` }),
      );
      if (removed.length > 0) this.d.log(`Repair: ${removed.map((e) => e.id).join(', ')} did not match its checksum and will be downloaded again.`);
      await this.installMissing(s.tier, s.features, signal);
    });
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    await this.running;
  }

  updateYtDlp(): Promise<string> {
    return this.d.updateYtDlp();
  }

  whenIdle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async installMissing(tier: SetupSelection['tier'], features: SetupSelection['features'], signal: AbortSignal): Promise<void> {
    const plan = buildPlan(this.d.lock, tier, features, this.d.resourcesDir);
    await this.d.install({
      components: plan.missing,
      resourcesDir: this.d.resourcesDir,
      signal,
      log: this.d.log,
      onProgress: (progress) => this.d.emit({ phase: 'installing', progress, message: null }),
    });
  }

  private launch(work: (signal: AbortSignal) => Promise<void>): void {
    if (this.running) throw new BgtError('InvalidInput', 'A download is already running.');
    const controller = new AbortController();
    this.controller = controller;
    this.d.emit({ phase: 'installing', progress: null, message: null });
    this.running = work(controller.signal)
      .then(
        () => this.d.emit({ phase: 'done', progress: null, message: null }),
        (err) => {
          if (controller.signal.aborted) {
            this.d.emit({ phase: 'cancelled', progress: null, message: 'The download is paused and continues where it stopped.' });
            return;
          }
          this.d.log(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
          this.d.emit({ phase: 'failed', progress: null, message: err instanceof Error ? err.message : String(err) });
        },
      )
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
  }
}
```

- [ ] **Step 5: Run and commit**

Run: `pnpm vitest run tests/app && pnpm typecheck && pnpm lint` — Expected: PASS.

```bash
git add -A && git commit -m "feat(app): packaged paths, setup types and the background setup service" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 9: IPC, handlers, preload and main-process wiring

**Files:**
- Modify: `src/app/shared/ipc.ts`, `src/app/main/validate.ts`, `src/app/main/handlers.ts`, `src/app/preload/index.ts`, `src/app/main/index.ts`
- Test: `tests/app/handlers.test.ts`, `tests/app/validate.test.ts`

**Interfaces:**
- Consumes: `SetupService` (Task 8), `ensureInstalled`, `wantsOfOptions`, `transcribeModelName`, `currentTier`, `ensureSettings`.
- Produces: `window.bgt.setup` with `state()`, `detect()`, `plan(selection)`, `missingFor(options)`, `start(selection)`, `cancel()`, `repair()`, `updateYtDlp()`, `openNotices()`, `onProgress(cb)`; `parseSubmissionOptions(raw): SubmissionOptions`; `HandlerDeps` gains `setup`, `openNotices`, `ensureReady(options)`, `transcribeModel()`.

- [ ] **Step 1: Write the failing tests**

`tests/app/validate.test.ts` — add `parseSubmissionOptions` to the import and append:

```ts
describe('parseSubmissionOptions', () => {
  it('fills the defaults and rejects non-objects', () => {
    expect(parseSubmissionOptions({ translate: true })).toEqual({ translate: true, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3' });
    expect(() => parseSubmissionOptions(null)).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
  });
});
```

`tests/app/handlers.test.ts` — change the first import to `import { describe, expect, it, vi } from 'vitest';`, and replace the `setup(...)` function with:

```ts
function setup(
  over: {
    speed?: number | null;
    probe?: () => Promise<{ title: string | null; durationMs: number }>;
    fileExists?: (p: string) => boolean;
    ensureReady?: (o: unknown) => void;
    model?: string;
  } = {},
) {
  const { repo, stages } = memoryRepos();
  const db = new Database(':memory:');
  migrate(db);
  const store = new SubmissionStore(db);
  const queue = new JobQueue({ store, run: async () => {}, emitChanged: () => {}, emitProgress: () => {} });
  const opened: string[] = [];
  const service = {
    state: vi.fn(() => ({ needsWizard: false })),
    detect: vi.fn(async () => ({ recommendedTier: 'cpu' })),
    plan: vi.fn(() => ({ missingBytes: 0 })),
    missingFor: vi.fn(() => ({ missingBytes: 5 })),
    start: vi.fn(),
    cancel: vi.fn(async () => {}),
    repair: vi.fn(),
    updateYtDlp: vi.fn(async () => 'updated'),
  };
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
    fileExists: over.fileExists ?? (() => true),
    setup: service as unknown as HandlerDeps['setup'],
    openNotices: async () => {},
    ensureReady: over.ensureReady ?? (() => {}),
    transcribeModel: () => over.model ?? 'large-v3',
  });
  return { handlers, repo, stages, queue, opened, service };
}
```

(import `type HandlerDeps` together with `createHandlers`), then add inside `describe('handlers', ...)`:

```ts
  it('queue:submit checks that the needed components are installed and queues nothing when they are not', async () => {
    const t = setup({
      ensureReady: () => {
        throw new BgtError('SetupRequired', 'Download the translation model first.');
      },
    });
    const r = await t.handlers['queue:submit']({ source: 'C:/a.wav', startMs: 0, endMs: null, options: { ...options, translate: true } });
    expect(r).toMatchObject({ ok: false, error: { code: 'SetupRequired' } });
    expect(t.queue.list()).toHaveLength(0);
  });

  it('queue:submit stores the whisper model of the installed tier, not the one the renderer sent', async () => {
    const t = setup({ model: 'large-v3-turbo-q5_0' });
    await t.handlers['queue:submit']({ source: 'C:/a.wav', startMs: 0, endMs: null, options });
    expect(t.queue.list()[0].options.model).toBe('large-v3-turbo-q5_0');
  });

  it('setup channels validate their arguments and delegate to the service', async () => {
    const t = setup();
    expect(await t.handlers['setup:start']({ tier: 'tpu' })).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(t.service.start).not.toHaveBeenCalled();
    const selection = { tier: 'cpu', features: { translation: true, summaries: false } };
    expect(await t.handlers['setup:start'](selection)).toEqual({ ok: true, value: null });
    expect(t.service.start).toHaveBeenCalledWith(selection);
    expect(await t.handlers['setup:state']()).toEqual({ ok: true, value: { needsWizard: false } });
    expect(await t.handlers['setup:missingFor']({ translate: true })).toEqual({ ok: true, value: { missingBytes: 5 } });
    expect(await t.handlers['setup:updateYtDlp']()).toEqual({ ok: true, value: 'updated' });
    expect(await t.handlers['setup:cancel']()).toEqual({ ok: true, value: null });
    expect(await t.handlers['setup:repair']()).toEqual({ ok: true, value: null });
  });

  it('a setup that is already running comes back as an error result, not a thrown exception', async () => {
    const t = setup();
    t.service.start.mockImplementation(() => {
      throw new BgtError('InvalidInput', 'A download is already running.');
    });
    const r = await t.handlers['setup:start']({ tier: 'cpu', features: { translation: true, summaries: true } });
    expect(r).toMatchObject({ ok: false, error: { message: 'A download is already running.' } });
  });
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/app/handlers.test.ts tests/app/validate.test.ts` — Expected: FAIL.

- [ ] **Step 3: `src/app/shared/ipc.ts`**

Add to `BgtApi` (after `dialog`):

```ts
  setup: {
    state(): Promise<Result<SetupState>>;
    detect(): Promise<Result<HardwareReport>>;
    plan(selection: SetupSelection): Promise<Result<SetupPlanView>>;
    /** What a job with these options still needs downloaded. */
    missingFor(options: SubmissionOptions): Promise<Result<SetupPlanView>>;
    /** Starts the download in the background; progress arrives through `onProgress`. */
    start(selection: SetupSelection): Promise<Result<null>>;
    cancel(): Promise<Result<null>>;
    repair(): Promise<Result<null>>;
    updateYtDlp(): Promise<Result<string>>;
    openNotices(): Promise<Result<null>>;
    onProgress(cb: (p: SetupProgress) => void): () => void;
  };
```

and to `CHANNELS`:

```ts
  setupState: 'setup:state',
  setupDetect: 'setup:detect',
  setupPlan: 'setup:plan',
  setupMissingFor: 'setup:missingFor',
  setupStart: 'setup:start',
  setupCancel: 'setup:cancel',
  setupRepair: 'setup:repair',
  setupUpdateYtDlp: 'setup:updateYtDlp',
  setupOpenNotices: 'setup:openNotices',
  setupProgress: 'setup:progress',
```

- [ ] **Step 4: `src/app/main/validate.ts`** — replace the tail of `parseSubmitRequest` (from `  const o = raw.options;` to the final `return`) and add `parseSubmissionOptions`:

```ts
export function parseSubmissionOptions(raw: unknown): SubmissionOptions {
  if (!isObject(raw)) throw invalid('Missing options.');
  const o = raw;
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
  return options;
}
```

and in `parseSubmitRequest` replace everything from `const o = raw.options;` to the end with:

```ts
  const options = parseSubmissionOptions(raw.options);
  return { source, startMs, endMs: endMs === undefined ? null : (endMs as number | null), options };
}
```

(`parseSubmissionOptions` must be declared as a function so it can be used above its definition.)

- [ ] **Step 5: `src/app/main/handlers.ts`**

Imports: add `import type { SubmissionOptions } from '../../core/db/submission-repo';`, `import type { SetupService } from './setup-service';` and change the validate import to also take `parseSetupSelection, parseSubmissionOptions`. Add to `HandlerDeps`:

```ts
  setup: Pick<SetupService, 'state' | 'detect' | 'plan' | 'missingFor' | 'start' | 'cancel' | 'repair' | 'updateYtDlp'>;
  openNotices(): Promise<void>;
  /** Throws SetupRequired when the job needs components that are not installed yet. */
  ensureReady(options: SubmissionOptions): void;
  /** Whisper model name of the installed tier; stored on every new submission. */
  transcribeModel(): string;
```

In `queueSubmit`, replace `return d.queue.submit(request);` with

```ts
        d.ensureReady(request.options);
        return d.queue.submit({ ...request, options: { ...request.options, model: d.transcribeModel() } });
```

and add these entries before `} satisfies Record<string, Handler>;`:

```ts
    [CHANNELS.setupState]: () => wrap(() => d.setup.state()),
    [CHANNELS.setupDetect]: () => wrap(() => d.setup.detect()),
    [CHANNELS.setupPlan]: (arg?: unknown) => wrap(() => d.setup.plan(parseSetupSelection(arg))),
    [CHANNELS.setupMissingFor]: (arg?: unknown) => wrap(() => d.setup.missingFor(parseSubmissionOptions(arg))),
    [CHANNELS.setupStart]: (arg?: unknown) =>
      wrap(() => {
        d.setup.start(parseSetupSelection(arg));
        return null;
      }),
    [CHANNELS.setupCancel]: () =>
      wrap(async () => {
        await d.setup.cancel();
        return null;
      }),
    [CHANNELS.setupRepair]: () =>
      wrap(() => {
        d.setup.repair();
        return null;
      }),
    [CHANNELS.setupUpdateYtDlp]: () => wrap(() => d.setup.updateYtDlp()),
    [CHANNELS.setupOpenNotices]: () =>
      wrap(async () => {
        await d.openNotices();
        return null;
      }),
```

- [ ] **Step 6: `src/app/preload/index.ts`** — add `type SetupProgress` to the import from `../shared/ipc` and this block after `dialog`:

```ts
  setup: {
    state: () => invoke(CHANNELS.setupState),
    detect: () => invoke(CHANNELS.setupDetect),
    plan: (selection) => invoke(CHANNELS.setupPlan, selection),
    missingFor: (options) => invoke(CHANNELS.setupMissingFor, options),
    start: (selection) => invoke(CHANNELS.setupStart, selection),
    cancel: () => invoke(CHANNELS.setupCancel),
    repair: () => invoke(CHANNELS.setupRepair),
    updateYtDlp: () => invoke(CHANNELS.setupUpdateYtDlp),
    openNotices: () => invoke(CHANNELS.setupOpenNotices),
    onProgress: (cb) => subscribe<SetupProgress>(CHANNELS.setupProgress, cb),
  },
```

- [ ] **Step 7: `src/app/main/index.ts`** — apply these edits in order:

1. Imports: change `import { existsSync } from 'node:fs';` to `import { existsSync, writeFileSync } from 'node:fs';` and add

```ts
import { transcribeModelName, wantsOfOptions } from '../../core/setup/components';
import { detectHardware } from '../../core/setup/hardware';
import { freeDiskBytes, installComponents, removeDamaged, uninstallComponents } from '../../core/setup/installer';
import { ensureInstalled } from '../../core/setup/plan';
import { currentTier, ensureSettings } from '../../core/setup/settings';
import { loadLock } from '../../core/tools/lock';
import { projectRoot, resolveTool, resourcesDir } from '../../core/tools/paths';
import { updateYtDlp } from '../../core/tools/ytdlp';
import { resolveAppPaths } from './app-paths';
import { SetupService } from './setup-service';
```

(and extend the existing `import { dataDir } from '../../core/tools/paths';` instead of adding a second import from that module).

2. Replace the two lines `// \`import.meta.url\`-based root discovery ...` and `process.env.KTR_PROJECT_ROOT ??= app.getAppPath();` with:

```ts
// Every location is decided before any core code reads it (`import.meta.url` root discovery does not work from a bundle).
const paths = resolveAppPaths({
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  appData: app.getPath('appData'),
  documents: app.getPath('documents'),
  env: process.env,
});
process.env.KTR_PROJECT_ROOT = paths.projectRoot;
process.env.KTR_RESOURCES_DIR = paths.resourcesDir;
process.env.KTR_DATA_DIR = paths.dataDir;
process.env.KTR_OUTPUT_DIR = paths.outDir;
if (paths.userData) app.setPath('userData', paths.userData);
```

3. Replace `const outDir = path.resolve(process.env.KTR_OUTPUT_DIR ?? path.join(app.getAppPath(), 'output'));` with `const outDir = path.resolve(paths.outDir);`.

4. Replace the lines `const pool = createRealModelPool({ log: (m) => console.log(m) });` and `const probeDeps = ...` with:

```ts
  const lock = loadLock(path.join(projectRoot(), 'tools.lock.json'));
  const resources = resourcesDir();
  ensureSettings({ dataDir: dir, lock, resources }); // a checkout that already has a whole tier needs no wizard
  const tier = () => currentTier(dir);
  const model = () => transcribeModelName(tier());
  const setup = new SetupService({
    lock,
    resourcesDir: resources,
    dataDir: dir,
    hardware: () => detectHardware(),
    install: installComponents,
    uninstall: uninstallComponents,
    removeDamaged,
    freeBytes: freeDiskBytes,
    updateYtDlp: () => updateYtDlp(resolveTool('yt-dlp')),
    emit: (p) => broadcast(CHANNELS.setupProgress, p),
    log: (m) => console.log(m),
  });
  const pool = createRealModelPool({ log: (m) => console.log(m), tier });
  const probeDeps = () => createRealDeps({ dataDir: dir, model: model(), db, log: () => {} }).deps;
```

5. In the `runSubmission` env: replace `makeDeps: (s) => createRealDeps({ dataDir: dir, model: s.options.model, db, log: (m) => console.log(m) }).deps,` with

```ts
          // The installed tier decides the speech model; a submission from before a tier switch still runs.
          makeDeps: () => createRealDeps({ dataDir: dir, model: model(), db, log: (m) => console.log(m) }).deps,
          autoGlossary: () => setup.autoGlossaryAvailable(),
```

6. In `createHandlers({...})` add after `fileExists: existsSync,`:

```ts
      setup,
      openNotices: async () => {
        await shell.openPath(path.join(projectRoot(), 'THIRD_PARTY_NOTICES.md'));
      },
      ensureReady: (options) => ensureInstalled(lock, tier(), wantsOfOptions(options), resources),
      transcribeModel: model,
```

7. Smoke block: replace the `executeJavaScript` call and the success branch with

```ts
        const reply = await win.webContents.executeJavaScript(
          'window.bgt ? Promise.all([window.bgt.ping(), window.bgt.library.list(), window.bgt.setup.state()]) : Promise.resolve(["no-bridge"])',
        );
        clearTimeout(timer);
        if (reply[0] === 'pong' && reply[1]?.ok === true && reply[2]?.ok === true) {
          const line = `SMOKE OK wizard=${reply[2].value.needsWizard}`;
          console.log(line);
          if (process.env.KTR_SMOKE_OUT) writeFileSync(process.env.KTR_SMOKE_OUT, line); // packaged GUI apps may not show stdout
          app.exit(0);
        } else {
```

8. `before-quit`: replace `    if (quitting) return;` with

```ts
    if (quitting) {
      event.preventDefault(); // a second quit request must not cut the cleanup short
      return;
    }
```

and add `{ name: 'setup', run: () => setup.cancel() },` as the first element of the `runShutdown([...])` array (a running download is aborted and its `.part` files are kept).

- [ ] **Step 8: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build:app && pnpm smoke:app`
Expected: all green; the smoke line reads `SMOKE OK wizard=true` on the author's tree until `pnpm setup:tools` has downloaded ffmpeg into `resources/ffmpeg` (Task 14). If `process.resourcesPath` is undefined in dev, that is fine: Electron defines it in both modes.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(app): setup IPC, on-demand download gate, tier-based model, quit-twice fix" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Renderer setup hooks, progress view, wizard and first-run gating

**Files:**
- Create: `src/app/renderer/components/InstallProgress.tsx`, `src/app/renderer/components/Wizard.tsx`, `tests/renderer/setup-fakes.ts`
- Modify: `eslint.config.js`, `src/app/renderer/lib/api.tsx`, `src/app/renderer/lib/format.ts`, `src/app/renderer/App.tsx`, `src/app/renderer/styles.css`
- Test: `tests/renderer/install-progress.test.tsx`, `tests/renderer/wizard.test.tsx`, `tests/renderer/app-setup.test.tsx`, `tests/renderer/format.test.ts` (append)

**Interfaces:**
- Consumes: `window.bgt.setup` (Task 9), `formatBytes` from `core/bytes`.
- Produces: `useSetupState(): { state: SetupState | null; refresh(): void }`, `useSetupProgress(): SetupProgress`, `formatRemaining(seconds: number | null): string`, `<InstallProgress components? progress />`, `<Wizard onFinished />`, and test helpers `fakeSetupApi(over)`, `viewFor(selection, installed?, freeDiskBytes?)`, `GPU_BOX`, `CPU_BOX`, `stateFor(over)`.

- [ ] **Step 1: Let the renderer import `core/bytes`**

In `eslint.config.js` change the renderer group to
`group: ['**/core/**', '!**/core/time', '!**/core/errors', '!**/core/youtube', '!**/core/source-text', '!**/core/bytes'],` and mention `core/bytes` in the message after `core/source-text`.

- [ ] **Step 2: Test helpers** — `tests/renderer/setup-fakes.ts`:

```ts
import { vi } from 'vitest';
import type {
  BgtApi,
  HardwareReport,
  SetupComponentInfo,
  SetupPlanView,
  SetupProgress,
  SetupSelection,
  SetupState,
} from '../../src/app/shared/ipc';

const SIZES: Record<string, number> = {
  'yt-dlp': 20e6,
  ffmpeg: 115e6,
  vad: 1e6,
  'whisper-gpu': 685e6,
  'model-transcribe-gpu': 2.95e9,
  'llama-gpu': 650e6,
  'model-translate-gpu': 4.68e9,
  'model-general-gpu': 5.03e9,
  'whisper-cpu': 9e6,
  'model-transcribe-cpu': 547e6,
  'llama-cpu': 20e6,
  'model-translate-cpu': 1.08e9,
  'model-general-cpu': 2.38e9,
};

const info = (id: string, installed: boolean): SetupComponentInfo => ({
  id,
  title: `Title ${id}`,
  tier: id.endsWith('-gpu') ? 'gpu' : id.endsWith('-cpu') ? 'cpu' : 'all',
  sizeBytes: SIZES[id],
  installed,
});

export function idsFor(s: SetupSelection): string[] {
  const ids = ['yt-dlp', 'ffmpeg', 'vad', `whisper-${s.tier}`, `model-transcribe-${s.tier}`];
  if (s.features.translation || s.features.summaries) ids.push(`llama-${s.tier}`);
  if (s.features.translation) ids.push(`model-translate-${s.tier}`);
  if (s.features.summaries) ids.push(`model-general-${s.tier}`);
  return ids;
}

export function viewFor(s: SetupSelection, installed: string[] = [], freeDiskBytes = 200e9): SetupPlanView {
  const components = idsFor(s).map((id) => info(id, installed.includes(id)));
  return {
    selection: s,
    components,
    missingBytes: components.filter((c) => !c.installed).reduce((n, c) => n + c.sizeBytes, 0),
    freeDiskBytes,
  };
}

export const GPU_BOX: HardwareReport = {
  gpuName: 'NVIDIA GeForce RTX 3080',
  vramMb: 12288,
  recommendedTier: 'gpu',
  reason: 'NVIDIA GeForce RTX 3080 (12 GB) can run the fast GPU programs.',
  ramMb: 32_000,
  cores: 24,
  freeDiskBytes: 200e9,
};
export const CPU_BOX: HardwareReport = {
  gpuName: null,
  vramMb: null,
  recommendedTier: 'cpu',
  reason: 'No NVIDIA graphics card was found.',
  ramMb: 16_000,
  cores: 8,
  freeDiskBytes: 200e9,
};

export function stateFor(over: Partial<SetupState> = {}, installed: string[] = []): SetupState {
  return {
    needsWizard: false,
    completed: true,
    installing: false,
    tier: 'gpu',
    features: { translation: true, summaries: true },
    components: Object.keys(SIZES).map((id) => info(id, installed.includes(id))),
    resourcesDir: 'C:/Users/me/AppData/Roaming/Kikitori/resources',
    ...over,
  };
}

export function fakeSetupApi(
  over: { hardware?: HardwareReport; state?: SetupState; installed?: string[]; startError?: string } = {},
) {
  const listeners = new Set<(p: SetupProgress) => void>();
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const setup = {
    state: vi.fn(async () => ok(over.state ?? stateFor())),
    detect: vi.fn(async () => ok(over.hardware ?? GPU_BOX)),
    plan: vi.fn(async (s: SetupSelection) => ok(viewFor(s, over.installed, over.hardware?.freeDiskBytes))),
    missingFor: vi.fn(async () => ok(viewFor({ tier: 'gpu', features: { translation: true, summaries: true } }))),
    start: vi.fn(async () =>
      over.startError ? { ok: false as const, error: { code: 'InvalidInput', message: over.startError } } : ok(null),
    ),
    cancel: vi.fn(async () => ok(null)),
    repair: vi.fn(async () => ok(null)),
    updateYtDlp: vi.fn(async () => ok('yt-dlp is up to date')),
    openNotices: vi.fn(async () => ok(null)),
    onProgress: (cb: (p: SetupProgress) => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  return {
    setup,
    api: { setup } as unknown as BgtApi,
    emit: (p: SetupProgress) => listeners.forEach((cb) => cb(p)),
  };
}
```

- [ ] **Step 3: Write the failing tests**

`tests/renderer/format.test.ts` — append (and import `formatRemaining`):

```ts
describe('formatRemaining', () => {
  it('says so when the speed is not known yet', () => {
    expect(formatRemaining(null)).toBe('estimating');
    expect(formatRemaining(20)).toBe('under a minute');
    expect(formatRemaining(100)).toBe('about 2 min');
  });
});
```

`tests/renderer/install-progress.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallProgress } from '../../src/app/renderer/components/InstallProgress';
import type { SetupProgress } from '../../src/app/shared/ipc';

afterEach(cleanup);

const comp = (id: string, installed = false) => ({ id, title: `Title ${id}`, tier: 'all' as const, sizeBytes: 1e9, installed });
const running = (componentId: string): SetupProgress => ({
  phase: 'installing',
  message: null,
  progress: {
    componentId,
    componentTitle: `Title ${componentId}`,
    fileId: 'f',
    fileIndex: 2,
    fileCount: 3,
    fileReceived: 5e8,
    fileTotal: 1e9,
    overallReceived: 1.5e9,
    overallTotal: 3e9,
    bytesPerSecond: 10e6,
    etaSeconds: 100,
  },
});

describe('InstallProgress', () => {
  it('shows totals, speed and time left, and marks each component done, downloading or waiting', () => {
    render(<InstallProgress components={[comp('a'), comp('b'), comp('c'), comp('z', true)]} progress={running('b')} />);
    expect(screen.getByText(/1\.5 GB of 3\.0 GB/)).toBeTruthy();
    expect(screen.getByText(/10 MB\/s/)).toBeTruthy();
    expect(screen.getByText(/about 2 min/)).toBeTruthy();
    expect(screen.getByText('Title a').parentElement?.textContent).toContain('Done');
    expect(screen.getByText('Title b').parentElement?.textContent).toContain('Downloading');
    expect(screen.getByText('Title c').parentElement?.textContent).toContain('Waiting');
    expect(screen.queryByText('Title z')).toBeNull();
  });

  it('shows the status message while nothing is downloading yet', () => {
    render(<InstallProgress components={[comp('a')]} progress={{ phase: 'installing', progress: null, message: 'Checking vad...' }} />);
    expect(screen.getByText('Checking vad...')).toBeTruthy();
  });

  it('without a component list it names the file being downloaded', () => {
    render(<InstallProgress progress={running('b')} />);
    expect(screen.getByText(/Downloading Title b/)).toBeTruthy();
  });
});
```

`tests/renderer/wizard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wizard } from '../../src/app/renderer/components/Wizard';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import { CPU_BOX, fakeSetupApi, GPU_BOX } from './setup-fakes';

afterEach(cleanup);

function renderWizard(over: Parameters<typeof fakeSetupApi>[0] = {}) {
  const fake = fakeSetupApi(over);
  const onFinished = vi.fn();
  render(
    <ApiProvider api={fake.api}>
      <Wizard onFinished={onFinished} />
    </ApiProvider>,
  );
  return { ...fake, onFinished };
}

const toChoose = async () => {
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText(/Download size/);
};

describe('Wizard', () => {
  it('starts with a welcome that states what is downloaded and the personal-use terms', () => {
    renderWizard();
    expect(screen.getByRole('heading', { name: 'Welcome to Kikitori' })).toBeTruthy();
    expect(screen.getByText(/personal use/i)).toBeTruthy();
    fireEvent.click(screen.getByText('License notices'));
  });

  it('recommends the GPU path for a capable NVIDIA card and shows the download size and free space', async () => {
    const t = renderWizard();
    await toChoose();
    expect(screen.getByText(/RTX 3080/)).toBeTruthy();
    expect((screen.getByLabelText(/NVIDIA GPU/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Download size: 14\.1 GB/)).toBeTruthy();
    expect(screen.getByText(/Free disk space: 200\.0 GB/)).toBeTruthy();
    expect(t.setup.plan).toHaveBeenLastCalledWith({ tier: 'gpu', features: { translation: true, summaries: true } });
  });

  it('opting out of Translation and Summaries shrinks the download', async () => {
    const t = renderWizard();
    await toChoose();
    fireEvent.click(screen.getByLabelText(/Translation/));
    fireEvent.click(screen.getByLabelText(/Summaries/));
    await waitFor(() => expect(screen.getByText(/Download size: 3\.8 GB/)).toBeTruthy());
    expect(t.setup.plan).toHaveBeenLastCalledWith({ tier: 'gpu', features: { translation: false, summaries: false } });
  });

  it('without a usable GPU it picks CPU, says why, and warns that transcription is slower than real time', async () => {
    renderWizard({ hardware: CPU_BOX });
    await toChoose();
    expect(screen.getByText(/No NVIDIA graphics card was found/)).toBeTruthy();
    expect((screen.getByLabelText(/CPU only/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/slower than real time/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Download size: 4\.2 GB/)).toBeTruthy());
  });

  it('lets the user override the recommendation', async () => {
    const t = renderWizard();
    await toChoose();
    fireEvent.click(screen.getByLabelText(/CPU only/));
    await waitFor(() => expect(t.setup.plan).toHaveBeenLastCalledWith({ tier: 'cpu', features: { translation: true, summaries: true } }));
  });

  it('refuses to start when the disk is too small', async () => {
    renderWizard({ hardware: { ...GPU_BOX, freeDiskBytes: 5e9 } });
    await toChoose();
    await waitFor(() => expect(screen.getByText(/Not enough free disk space/)).toBeTruthy());
    expect((screen.getByText('Download and install') as HTMLButtonElement).disabled).toBe(true);
  });

  it('installs, shows progress, and ends with the option to add the first video', async () => {
    const t = renderWizard({ hardware: CPU_BOX });
    await toChoose();
    fireEvent.click(screen.getByText('Download and install'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledWith({ tier: 'cpu', features: { translation: true, summaries: true } }));
    await screen.findByText(/Starting/);
    act(() => t.emit({ phase: 'done', progress: null, message: null }));
    fireEvent.click(await screen.findByText('Add your first video'));
    expect(t.onFinished).toHaveBeenCalled();
  });

  it('shows a failure and lets the user try again', async () => {
    const t = renderWizard();
    await toChoose();
    fireEvent.click(screen.getByText('Download and install'));
    await screen.findByText(/Starting/);
    act(() => t.emit({ phase: 'failed', progress: null, message: 'Could not download github.com' }));
    await screen.findByText('Could not download github.com');
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledTimes(2));
  });

  it('offers to continue a paused download and can cancel a running one', async () => {
    const t = renderWizard();
    await toChoose();
    fireEvent.click(screen.getByText('Download and install'));
    await screen.findByText(/Starting/);
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(t.setup.cancel).toHaveBeenCalled());
    act(() => t.emit({ phase: 'cancelled', progress: null, message: 'The download is paused and continues where it stopped.' }));
    fireEvent.click(await screen.findByText('Continue download'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledTimes(2));
  });
});
```

`tests/renderer/app-setup.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/app/renderer/App';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { BgtApi } from '../../src/app/shared/ipc';
import { fakeSetupApi, stateFor } from './setup-fakes';

afterEach(cleanup);

function renderApp(needsWizard: boolean) {
  const fake = fakeSetupApi({ state: stateFor({ needsWizard, completed: !needsWizard }) });
  const api = {
    ping: async () => 'pong',
    library: { list: async () => ({ ok: true as const, value: [] }) },
    queue: {
      list: async () => ({ ok: true as const, value: [] }),
      onChanged: () => () => {},
      onProgress: () => () => {},
      cancel: async () => ({ ok: true as const, value: null }),
      resume: async () => ({ ok: true as const, value: null }),
    },
    ...fake.api,
  } as unknown as BgtApi;
  render(
    <ApiProvider api={api}>
      <App />
    </ApiProvider>,
  );
  return fake;
}

describe('App first-run gating', () => {
  it('shows the wizard instead of the library when setup is needed', async () => {
    renderApp(true);
    expect(await screen.findByRole('heading', { name: 'Welcome to Kikitori' })).toBeTruthy();
    expect(screen.queryByText('New job')).toBeNull();
  });

  it('shows the library when setup is done', async () => {
    renderApp(false);
    expect(await screen.findByText('New job')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Welcome to Kikitori' })).toBeNull();
  });

  it('keeps the wizard open until the user chooses to continue, then opens the new-job dialog', async () => {
    const t = renderApp(true);
    fireEvent.click(await screen.findByText('Continue'));
    await screen.findByText(/Download size/);
    fireEvent.click(screen.getByText('Download and install'));
    await screen.findByText(/Starting/);
    act(() => t.emit({ phase: 'done', progress: null, message: null }));
    fireEvent.click(await screen.findByText('Add your first video'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'New job' })).toBeTruthy());
  });
});
```

- [ ] **Step 4: Run to verify failure** — `pnpm vitest run tests/renderer/format.test.ts tests/renderer/install-progress.test.tsx tests/renderer/wizard.test.tsx tests/renderer/app-setup.test.tsx` — Expected: FAIL.

- [ ] **Step 5: Implement**

`src/app/renderer/lib/format.ts` — append:

```ts
export function formatRemaining(seconds: number | null): string {
  return seconds === null ? 'estimating' : formatEta(seconds);
}
```

`src/app/renderer/lib/api.tsx` — change the react import to include `useCallback`, add `SetupProgress, SetupState` to the type import, and append:

```tsx
export function useSetupState(): { state: SetupState | null; refresh(): void } {
  const api = useApi();
  const [state, setState] = useState<SetupState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void api.setup.state().then((r) => {
      if (alive && r.ok) setState(r.value);
    });
    return () => {
      alive = false;
    };
  }, [api, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { state, refresh };
}

const IDLE: SetupProgress = { phase: 'idle', progress: null, message: null };

/** The latest progress report of the background setup (it keeps running when a dialog closes). */
export function useSetupProgress(): SetupProgress {
  const api = useApi();
  const [progress, setProgress] = useState<SetupProgress>(IDLE);
  useEffect(() => api.setup.onProgress(setProgress), [api]);
  return progress;
}
```

`src/app/renderer/components/InstallProgress.tsx`:

```tsx
import { formatBytes } from '../../../core/bytes';
import type { SetupComponentInfo, SetupProgress } from '../../shared/ipc';
import { formatRemaining } from '../lib/format';

interface Props {
  /** The components being installed; installed ones are not listed. Omit to show only the overall progress. */
  components?: SetupComponentInfo[];
  progress: SetupProgress;
}

export function InstallProgress({ components, progress }: Props) {
  const p = progress.progress;
  const pending = (components ?? []).filter((c) => !c.installed);
  const current = p ? pending.findIndex((c) => c.id === p.componentId) : -1;
  return (
    <div className="install">
      {p ? (
        <>
          <progress aria-label="Overall progress" max={p.overallTotal} value={p.overallReceived} />
          <div>{`${formatBytes(p.overallReceived)} of ${formatBytes(p.overallTotal)} - ${formatBytes(p.bytesPerSecond)}/s - time remaining: ${formatRemaining(p.etaSeconds)}`}</div>
          {components === undefined && <div className="hint">{`Downloading ${p.componentTitle}`}</div>}
        </>
      ) : (
        <div>{progress.message ?? 'Starting...'}</div>
      )}
      {pending.length > 0 && (
        <ul className="install-list">
          {pending.map((c, i) => {
            const state = i < current ? 'Done' : i === current ? 'Downloading' : 'Waiting';
            return (
              <li key={c.id}>
                <span>{c.title}</span>
                <span className={state === 'Done' ? 'state-done' : undefined}>{`${state} (${formatBytes(c.sizeBytes)})`}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

(The row text is `<span>title</span><span>State (size)</span>` inside the `li`, so `getByText('Title b').parentElement` is the `li` and contains both.)

`src/app/renderer/components/Wizard.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { formatBytes } from '../../../core/bytes';
import type { HardwareReport, SetupComponentInfo, SetupPlanView, Tier } from '../../shared/ipc';
import { useApi, useSetupProgress } from '../lib/api';
import { InstallProgress } from './InstallProgress';

type Step = 'welcome' | 'choose' | 'installing' | 'done';

interface Props {
  onFinished(): void;
}

export function Wizard({ onFinished }: Props) {
  const api = useApi();
  const progress = useSetupProgress();
  const [step, setStep] = useState<Step>('welcome');
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [all, setAll] = useState<SetupComponentInfo[]>([]);
  const [tier, setTier] = useState<Tier>('gpu');
  const [translation, setTranslation] = useState(true);
  const [summaries, setSummaries] = useState(true);
  const [plan, setPlan] = useState<SetupPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== 'choose' || hardware) return;
    let alive = true;
    void Promise.all([api.setup.detect(), api.setup.state()]).then(([hw, st]) => {
      if (!alive) return;
      if (hw.ok) {
        setHardware(hw.value);
        setTier(hw.value.recommendedTier);
      } else {
        setError(hw.error.message);
      }
      if (st.ok) setAll(st.value.components);
    });
    return () => {
      alive = false;
    };
  }, [api, step, hardware]);

  useEffect(() => {
    if (step !== 'choose' || !hardware) return;
    let alive = true;
    void api.setup.plan({ tier, features: { translation, summaries } }).then((r) => {
      if (!alive) return;
      if (r.ok) setPlan(r.value);
      else setError(r.error.message);
    });
    return () => {
      alive = false;
    };
  }, [api, step, hardware, tier, translation, summaries]);

  useEffect(() => {
    if (step === 'installing' && progress.phase === 'done') setStep('done');
  }, [step, progress.phase]);

  const size = (id: string) => formatBytes(all.find((c) => c.id === id)?.sizeBytes ?? 0);
  const selection = { tier, features: { translation, summaries } };

  const start = async () => {
    setError(null);
    setStep('installing');
    const r = await api.setup.start(selection);
    if (!r.ok) {
      setError(r.error.message);
      setStep('choose');
    }
  };

  if (step === 'welcome') {
    return (
      <div className="wizard">
        <h1>Welcome to Kikitori</h1>
        <div className="card">
          <p>It turns Japanese videos into English subtitles and summaries, entirely on this computer. Nothing you process is sent anywhere.</p>
          <p>
            To do that it downloads open-source tools and AI models from their publishers. They are not part of this app and keep their own licenses.
            This app is for your personal use; respect YouTube's terms and the rights of the people who made the videos.
          </p>
          <button onClick={() => void api.setup.openNotices()}>License notices</button>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => setStep('choose')}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (step === 'choose') {
    const tooSmall = plan !== null && plan.freeDiskBytes < plan.missingBytes;
    return (
      <div className="wizard">
        <h1>Choose what to install</h1>
        {!hardware && !error && <div className="hint">Looking at your computer...</div>}
        {hardware && (
          <div className="card">
            <strong>Your computer</strong>
            <div>{hardware.reason}</div>
            <label className="choice">
              <input type="radio" name="tier" checked={tier === 'gpu'} onChange={() => setTier('gpu')} />
              NVIDIA GPU (fast)
            </label>
            <label className="choice">
              <input type="radio" name="tier" checked={tier === 'cpu'} onChange={() => setTier('cpu')} />
              CPU only (slower)
            </label>
            {tier === 'cpu' && (
              <div className="warn">
                On the CPU path, transcription is slower than real time, so long videos take a while. Translation and summaries are slower too.
              </div>
            )}
          </div>
        )}
        {hardware && (
          <div className="card">
            <strong>Features</strong>
            <label className="choice">
              <input type="checkbox" checked={translation} onChange={(e) => setTranslation(e.target.checked)} />
              {`Translation (${size(`model-translate-${tier}`)} model)`}
            </label>
            <label className="choice">
              <input type="checkbox" checked={summaries} onChange={(e) => setSummaries(e.target.checked)} />
              {`Summaries (${size(`model-general-${tier}`)} model)`}
            </label>
            <div className="hint">Speech recognition is always installed. Anything you skip is downloaded when you first need it.</div>
          </div>
        )}
        {plan && (
          <div className="card">
            <div>{`Download size: ${formatBytes(plan.missingBytes)}`}</div>
            <div>{`Free disk space: ${formatBytes(plan.freeDiskBytes)}`}</div>
            {tooSmall && <div className="error">Not enough free disk space for this selection.</div>}
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button onClick={() => setStep('welcome')}>Back</button>
          <button className="primary" disabled={!plan || tooSmall} onClick={() => void start()}>
            {plan && plan.missingBytes === 0 ? 'Finish setup' : 'Download and install'}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'installing') {
    return (
      <div className="wizard">
        <h1>Installing</h1>
        <div className="card">
          <InstallProgress components={plan?.components} progress={progress} />
          {progress.phase === 'failed' && <div className="error">{progress.message}</div>}
          {progress.phase === 'cancelled' && <div className="hint">{progress.message}</div>}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="actions">
          {progress.phase === 'failed' && (
            <>
              <button onClick={() => setStep('choose')}>Back</button>
              <button className="primary" onClick={() => void start()}>
                Try again
              </button>
            </>
          )}
          {progress.phase === 'cancelled' && (
            <button className="primary" onClick={() => void start()}>
              Continue download
            </button>
          )}
          {progress.phase !== 'failed' && progress.phase !== 'cancelled' && (
            <button onClick={() => void api.setup.cancel()}>Cancel</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="wizard">
      <h1>All set</h1>
      <div className="card">Everything is installed. Paste a YouTube link or choose a file to get your first transcript.</div>
      <div className="actions">
        <button className="primary" onClick={onFinished}>
          Add your first video
        </button>
      </div>
    </div>
  );
}
```

`src/app/renderer/App.tsx` — replace with:

```tsx
import { useEffect, useState } from 'react';
import { JobScreen } from './components/JobScreen';
import { LibraryScreen } from './components/LibraryScreen';
import { NewJobDialog } from './components/NewJobDialog';
import { QueueStrip } from './components/QueueStrip';
import { Wizard } from './components/Wizard';
import { useApi, useLibrary, useProgress, useQueue, useSetupState } from './lib/api';

type Route = { name: 'library' } | { name: 'job'; jobId: number };

export function App() {
  const api = useApi();
  const submissions = useQueue();
  const progress = useProgress();
  const items = useLibrary(submissions);
  const { state, refresh } = useSetupState();
  const [route, setRoute] = useState<Route>({ name: 'library' });
  const [newJobOpen, setNewJobOpen] = useState(false);
  // Decided once, when the setup state first arrives: finishing the wizard must not pull it away before the user clicks on.
  const [wizard, setWizard] = useState<boolean | null>(null);
  useEffect(() => {
    if (state && wizard === null) setWizard(state.needsWizard);
  }, [state, wizard]);

  if (wizard === null) return <div className="app" />;
  if (wizard) {
    return (
      <Wizard
        onFinished={() => {
          setWizard(false);
          refresh();
          setNewJobOpen(true);
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setRoute({ name: 'library' })}>
          Kikitori
        </button>
        <button className="primary" onClick={() => setNewJobOpen(true)}>
          New job
        </button>
      </header>
      <main className="content">
        {route.name === 'library' ? (
          <LibraryScreen items={items} submissions={submissions} onOpen={(jobId) => setRoute({ name: 'job', jobId })} onNew={() => setNewJobOpen(true)} />
        ) : (
          <JobScreen jobId={route.jobId} onBack={() => setRoute({ name: 'library' })} />
        )}
      </main>
      <QueueStrip
        submissions={submissions}
        progress={progress}
        onCancel={(id) => void api.queue.cancel(id)}
        onResume={(id) => void api.queue.resume(id)}
      />
      {newJobOpen && (
        <NewJobDialog
          onClose={() => setNewJobOpen(false)}
          onSubmitted={() => {
            setNewJobOpen(false);
            setRoute({ name: 'library' });
          }}
        />
      )}
    </div>
  );
}
```

`src/app/renderer/styles.css` — append:

```css
.wizard { max-width: 640px; margin: 40px auto; padding: 0 16px; display: grid; gap: 14px; }
.wizard h1 { margin: 0; font-size: 22px; }
.wizard .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: grid; gap: 8px; }
.wizard .actions { display: flex; gap: 8px; justify-content: flex-end; }
.wizard .hint, .install .hint { color: var(--muted); font-size: 12px; }
.wizard .error, .install .error { color: var(--bad); }
.wizard .warn { color: var(--bad); font-size: 13px; }
.choice { display: flex; gap: 8px; align-items: flex-start; }
.install { display: grid; gap: 8px; }
.install progress { width: 100%; }
.install-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.install-list li { display: flex; justify-content: space-between; gap: 12px; }
.install-list .state-done { color: var(--ok); }
```

- [ ] **Step 6: Run and commit**

Run: `pnpm vitest run tests/renderer && pnpm typecheck && pnpm lint` — Expected: PASS (existing renderer tests unaffected: none render `App`).

```bash
git add -A && git commit -m "feat(renderer): first-run wizard, install progress and setup gating" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Tools dialog, on-demand download prompt and "Update yt-dlp"

**Files:**
- Create: `src/app/renderer/components/ToolsDialog.tsx`, `src/app/renderer/components/SetupDownloadDialog.tsx`
- Modify: `src/app/renderer/components/NewJobDialog.tsx`, `src/app/renderer/components/QueueStrip.tsx`, `src/app/renderer/App.tsx`, `src/app/renderer/styles.css`
- Test: `tests/renderer/tools-dialog.test.tsx`, `tests/renderer/setup-download-dialog.test.tsx`, `tests/renderer/new-job-dialog.test.tsx`, `tests/renderer/queue-strip.test.tsx`

**Interfaces:**
- Consumes: Task 10 hooks and helpers.
- Produces: `<ToolsDialog state onClose onChanged />`, `<SetupDownloadDialog plan onDone onCancel />`, `QueueStrip` prop `onUpdateYtDlp?(): void`.

- [ ] **Step 1: Write the failing tests**

`tests/renderer/tools-dialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolsDialog } from '../../src/app/renderer/components/ToolsDialog';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import { fakeSetupApi, stateFor } from './setup-fakes';

afterEach(cleanup);

const GPU_BASE = ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu'];

function renderTools(state = stateFor({}, GPU_BASE)) {
  const fake = fakeSetupApi({ state });
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <ApiProvider api={fake.api}>
      <ToolsDialog state={state} onChanged={onChanged} onClose={onClose} />
    </ApiProvider>,
  );
  return { ...fake, onChanged, onClose };
}

describe('ToolsDialog', () => {
  it('lists the components of the current tier with their state', () => {
    renderTools();
    expect(screen.getByText('Title yt-dlp').parentElement?.textContent).toContain('Installed');
    expect(screen.getByText('Title model-translate-gpu').parentElement?.textContent).toContain('Not installed');
    expect(screen.queryByText('Title model-translate-cpu')).toBeNull();
  });

  it('updates yt-dlp and shows what the updater said', async () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('Update yt-dlp'));
    expect(await screen.findByText('yt-dlp is up to date')).toBeTruthy();
    expect(t.setup.updateYtDlp).toHaveBeenCalled();
  });

  it('adds translation and summaries for the current tier', async () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('Add translation and summaries'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledWith({ tier: 'gpu', features: { translation: true, summaries: true } }));
  });

  it('hides "add" when both features are already there', () => {
    renderTools(stateFor({ features: { translation: true, summaries: true } }, [...GPU_BASE, 'llama-gpu', 'model-translate-gpu', 'model-general-gpu']));
    expect(screen.queryByText('Add translation and summaries')).toBeNull();
  });

  it('repairs on request', async () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('Repair'));
    await waitFor(() => expect(t.setup.repair).toHaveBeenCalled());
  });

  it('asks before switching tier, explaining what is replaced, and then switches', async () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('Switch to CPU only'));
    expect(screen.getByText(/removes the GPU programs and models/)).toBeTruthy();
    expect(t.setup.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Switch'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledWith({ tier: 'cpu', features: { translation: true, summaries: true } }));
  });

  it('shows download progress and tells the app when it finished', async () => {
    const t = renderTools();
    act(() =>
      t.emit({
        phase: 'installing',
        message: null,
        progress: { componentId: 'llama-gpu', componentTitle: 'Title llama-gpu', fileId: 'f', fileIndex: 1, fileCount: 1, fileReceived: 1, fileTotal: 2, overallReceived: 1e9, overallTotal: 2e9, bytesPerSecond: 1e7, etaSeconds: 60 },
      }),
    );
    expect(screen.getByText(/Downloading Title llama-gpu/)).toBeTruthy();
    act(() => t.emit({ phase: 'done', progress: null, message: null }));
    expect(t.onChanged).toHaveBeenCalled();
  });

  it('opens the license notices', () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('License notices'));
    expect(t.setup.openNotices).toHaveBeenCalled();
  });
});
```

`tests/renderer/setup-download-dialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupDownloadDialog } from '../../src/app/renderer/components/SetupDownloadDialog';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import { fakeSetupApi, viewFor } from './setup-fakes';

afterEach(cleanup);

const selection = { tier: 'gpu' as const, features: { translation: true, summaries: false } };
const view = () => viewFor(selection, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);

function renderDialog() {
  const fake = fakeSetupApi();
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    <ApiProvider api={fake.api}>
      <SetupDownloadDialog plan={view()} onDone={onDone} onCancel={onCancel} />
    </ApiProvider>,
  );
  return { ...fake, onDone, onCancel };
}

describe('SetupDownloadDialog', () => {
  it('lists only what is missing with the total size', () => {
    renderDialog();
    expect(screen.getByText('Download needed')).toBeTruthy();
    expect(screen.getByText(/Title llama-gpu/)).toBeTruthy();
    expect(screen.getByText(/Title model-translate-gpu/)).toBeTruthy();
    expect(screen.queryByText(/Title ffmpeg/)).toBeNull();
    expect(screen.getByText(/Total: 5\.3 GB/)).toBeTruthy();
  });

  it('downloads on request and reports when done', async () => {
    const t = renderDialog();
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledWith(selection));
    act(() => t.emit({ phase: 'done', progress: null, message: null }));
    expect(t.onDone).toHaveBeenCalled();
  });

  it('shows a failure and can retry', async () => {
    const t = renderDialog();
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalled());
    act(() => t.emit({ phase: 'failed', progress: null, message: 'No internet' }));
    expect(await screen.findByText('No internet')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledTimes(2));
  });

  it('"Not now" closes without downloading; while downloading it cancels the download first', async () => {
    const t = renderDialog();
    fireEvent.click(screen.getByText('Not now'));
    expect(t.onCancel).toHaveBeenCalled();
    expect(t.setup.cancel).not.toHaveBeenCalled();
  });
});
```

`tests/renderer/new-job-dialog.test.tsx` — change the imports to `import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';`, add `import { fakeSetupApi, viewFor } from './setup-fakes';`, add `extra?: Partial<BgtApi>;` to the `over` type of `setup()` and `...over.extra,` as the last property of its `api` object, then add inside `describe('NewJobDialog', ...)`:

```tsx
  it('offers to download a missing component, then submits again once it is installed', async () => {
    const fake = fakeSetupApi();
    const view = viewFor({ tier: 'gpu', features: { translation: true, summaries: false } }, [
      'yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu',
    ]);
    fake.setup.missingFor.mockResolvedValue({ ok: true, value: view });
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'SetupRequired', message: 'Download first' } })
      .mockResolvedValueOnce({ ok: true, value: { id: 1 } });
    const t = setup({ submit, extra: { setup: fake.setup as never } });
    fireEvent.change(screen.getByLabelText('YouTube link or file path'), { target: { value: url } });
    await act(async () => {
      fireEvent.click(screen.getByText('Add to queue'));
    });
    expect(await screen.findByText('Download needed')).toBeTruthy();
    expect(t.onSubmitted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(fake.setup.start).toHaveBeenCalledWith(view.selection));
    act(() => fake.emit({ phase: 'done', progress: null, message: null }));
    await waitFor(() => expect(t.onSubmitted).toHaveBeenCalled());
    expect(submit).toHaveBeenCalledTimes(2);
  });
```

(If `vi` is not yet imported there, it already is: the file imports `vi` from vitest.)

`tests/renderer/queue-strip.test.tsx` — append inside the `describe`:

```tsx
  it('offers "Update yt-dlp" only for download failures', () => {
    const onUpdate = vi.fn();
    render(
      <QueueStrip
        submissions={[sub({ id: 4, state: 'failed', error: 'DownloadFailed: yt-dlp failed after 3 attempts' }), sub({ id: 5, state: 'failed', error: 'TranscribeFailed: nope' })]}
        progress={new Map()}
        onCancel={() => {}}
        onResume={() => {}}
        onUpdateYtDlp={onUpdate}
      />,
    );
    const buttons = screen.getAllByText('Update yt-dlp');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onUpdate).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/renderer` — Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

`src/app/renderer/components/SetupDownloadDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { formatBytes } from '../../../core/bytes';
import type { SetupPlanView } from '../../shared/ipc';
import { useApi, useSetupProgress } from '../lib/api';
import { InstallProgress } from './InstallProgress';

interface Props {
  plan: SetupPlanView;
  onDone(): void;
  onCancel(): void;
}

/** Asks before downloading the parts a job needs that were skipped at setup, then shows the download. */
export function SetupDownloadDialog({ plan, onDone, onCancel }: Props) {
  const api = useApi();
  const progress = useSetupProgress();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = plan.components.filter((c) => !c.installed);
  const running = started && progress.phase === 'installing';
  const failed = started && progress.phase === 'failed';

  useEffect(() => {
    if (started && progress.phase === 'done') onDone();
  }, [started, progress.phase, onDone]);

  const start = async () => {
    setError(null);
    setStarted(true);
    const r = await api.setup.start(plan.selection);
    if (!r.ok) {
      setError(r.error.message);
      setStarted(false);
    }
  };

  const close = async () => {
    if (running) await api.setup.cancel();
    onCancel();
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-label="Download needed">
        <h2>Download needed</h2>
        <div>This needs parts that are not installed yet:</div>
        <ul className="install-list">
          {missing.map((c) => (
            <li key={c.id}>
              <span>{c.title}</span>
              <span>{formatBytes(c.sizeBytes)}</span>
            </li>
          ))}
        </ul>
        <div className="hint">{`Total: ${formatBytes(plan.missingBytes)} - free disk space: ${formatBytes(plan.freeDiskBytes)}`}</div>
        {started && <InstallProgress components={missing} progress={progress} />}
        {failed && <div className="error">{progress.message}</div>}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button onClick={() => void close()}>Not now</button>
          <button className="primary" disabled={running} onClick={() => void start()}>
            {failed ? 'Try again' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

`src/app/renderer/components/ToolsDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { formatBytes } from '../../../core/bytes';
import type { SetupState, Tier } from '../../shared/ipc';
import { useApi, useSetupProgress } from '../lib/api';
import { InstallProgress } from './InstallProgress';

interface Props {
  state: SetupState;
  onClose(): void;
  /** Called after a download or repair finished, so the caller can reload the setup state. */
  onChanged(): void;
}

export function ToolsDialog({ state, onClose, onChanged }: Props) {
  const api = useApi();
  const progress = useSetupProgress();
  const [message, setMessage] = useState<string | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const busy = progress.phase === 'installing';
  const other: Tier = state.tier === 'gpu' ? 'cpu' : 'gpu';
  const visible = state.components.filter((c) => c.tier === 'all' || c.tier === state.tier);
  const bytesOf = (tier: Tier) => state.components.filter((c) => c.tier === tier).reduce((n, c) => n + c.sizeBytes, 0);
  const featuresMissing = !state.features.translation || !state.features.summaries;

  useEffect(() => {
    if (progress.phase === 'done') onChanged();
  }, [progress.phase, onChanged]);

  const run = async (call: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    setMessage(null);
    const r = await call();
    if (!r.ok) setMessage(r.error?.message ?? 'Something went wrong.');
  };

  const updateYtDlp = async () => {
    setMessage('Updating yt-dlp...');
    const r = await api.setup.updateYtDlp();
    setMessage(r.ok ? r.value : r.error.message);
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-label="Tools">
        <h2>Tools</h2>
        <div className="hint">{`${state.tier === 'gpu' ? 'NVIDIA GPU' : 'CPU only'} setup - installed in ${state.resourcesDir}`}</div>
        <ul className="tools-list">
          {visible.map((c) => (
            <li key={c.id}>
              <span>{c.title}</span>
              <span>{`${c.installed ? 'Installed' : 'Not installed'} (${formatBytes(c.sizeBytes)})`}</span>
            </li>
          ))}
        </ul>
        {progress.phase !== 'idle' && progress.phase !== 'done' && <InstallProgress progress={progress} />}
        {(progress.phase === 'failed' || progress.phase === 'cancelled') && (
          <div className={progress.phase === 'failed' ? 'error' : 'hint'}>{progress.message}</div>
        )}
        {message && <div className="hint">{message}</div>}
        {confirmSwitch ? (
          <div className="notice">
            <div>
              {`Switching removes the ${state.tier === 'gpu' ? 'GPU' : 'CPU'} programs and models (${formatBytes(bytesOf(state.tier))}) and downloads the ${other === 'gpu' ? 'GPU' : 'CPU'} ones (up to ${formatBytes(bytesOf(other))}). Your videos, transcripts and settings are kept.`}
            </div>
            <div className="actions">
              <button onClick={() => setConfirmSwitch(false)}>Keep current setup</button>
              <button
                className="primary"
                onClick={() => {
                  setConfirmSwitch(false);
                  void run(() => api.setup.start({ tier: other, features: state.features }));
                }}
              >
                Switch
              </button>
            </div>
          </div>
        ) : (
          <div className="inline">
            {featuresMissing && (
              <button disabled={busy} onClick={() => void run(() => api.setup.start({ tier: state.tier, features: { translation: true, summaries: true } }))}>
                Add translation and summaries
              </button>
            )}
            <button disabled={busy} onClick={() => void updateYtDlp()}>
              Update yt-dlp
            </button>
            <button disabled={busy} onClick={() => void run(() => api.setup.repair())}>
              Repair
            </button>
            <button disabled={busy} onClick={() => setConfirmSwitch(true)}>
              {`Switch to ${other === 'gpu' ? 'NVIDIA GPU' : 'CPU only'}`}
            </button>
            <button onClick={() => void api.setup.openNotices()}>License notices</button>
          </div>
        )}
        <div className="actions">
          {busy && <button onClick={() => void api.setup.cancel()}>Cancel download</button>}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
```

The test for the switch text expects "removes the GPU programs and models" — matches `Switching removes the GPU programs and models (...)`.

`src/app/renderer/components/QueueStrip.tsx`: add `onUpdateYtDlp?(): void;` to `Props`, destructure it, and after the `{s.error && ...}` line add

```tsx
          {s.error?.startsWith('DownloadFailed') && onUpdateYtDlp && <button onClick={onUpdateYtDlp}>Update yt-dlp</button>}
```

`src/app/renderer/components/NewJobDialog.tsx`: import `SetupDownloadDialog` and `type SetupPlanView`; add `const [needs, setNeeds] = useState<SetupPlanView | null>(null);`; replace the tail of `submit` (`const r = await api.queue.submit(built.request); setBusy(false); if (r.ok) onSubmitted(); else setError(r.error.message);`) with

```ts
    const r = await api.queue.submit(built.request);
    setBusy(false);
    if (r.ok) {
      onSubmitted();
    } else if (r.error.code === 'SetupRequired') {
      const view = await api.setup.missingFor(built.request.options);
      if (view.ok) setNeeds(view.value);
      else setError(r.error.message);
    } else {
      setError(r.error.message);
    }
```

and render, right after the closing `</div>` of the inner `.dialog` div (still inside the backdrop):

```tsx
      {needs && (
        <SetupDownloadDialog
          plan={needs}
          onCancel={() => setNeeds(null)}
          onDone={() => {
            setNeeds(null);
            void submit();
          }}
        />
      )}
```

`src/app/renderer/App.tsx`: import `ToolsDialog`; add `import { useCallback ... }` is not needed (`refresh` is already stable). Add state and handler:

```tsx
  const [toolsOpen, setToolsOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const updateYtDlp = async () => {
    setNote('Updating yt-dlp...');
    const r = await api.setup.updateYtDlp();
    setNote(r.ok ? r.value : r.error.message);
  };
```

(placed with the other hooks, before the early returns), then in the header replace the single "New job" button with

```tsx
        <div className="inline">
          <button onClick={() => setToolsOpen(true)}>Tools</button>
          <button className="primary" onClick={() => setNewJobOpen(true)}>
            New job
          </button>
        </div>
```

at the top of `<main className="content">` add

```tsx
        {note && (
          <div className="notice" role="status">
            {note} <button onClick={() => setNote(null)}>Dismiss</button>
          </div>
        )}
```

pass `onUpdateYtDlp={() => void updateYtDlp()}` to `QueueStrip`, and after the `newJobOpen` block add `{toolsOpen && state && <ToolsDialog state={state} onClose={() => setToolsOpen(false)} onChanged={refresh} />}`.

`src/app/renderer/styles.css` — append:

```css
.tools-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; max-height: 40vh; overflow: auto; }
.tools-list li { display: flex; justify-content: space-between; gap: 12px; }
.dialog .install-list { margin: 0; }
.content > .notice { margin-bottom: 12px; display: flex; gap: 8px; align-items: center; justify-content: space-between; }
```

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run tests/renderer && pnpm typecheck && pnpm lint && pnpm build:app` — Expected: PASS.

```bash
git add -A && git commit -m "feat(renderer): Tools dialog, on-demand download prompt and Update yt-dlp button" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Packaging, licenses, notices and README

**Files:**
- Create: `LICENSE`, `THIRD_PARTY_NOTICES.md`, `README.md`, `electron-builder.yml`, `scripts/make-icon.mjs`, `build/icon.ico`, `build/icon.png`, `scripts/smoke-installed.mjs`
- Modify: `package.json`, `pnpm-lock.yaml`
- Test: `tests/core/notices.test.ts`

**Interfaces:**
- Produces: `pnpm build:installer` (writes `dist/Kikitori-Setup-<version>.exe`), `pnpm smoke:installed <path-to-exe>`, `pnpm make:icon`.

- [ ] **Step 1: Write the failing test** — `tests/core/notices.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLock } from '../../src/core/tools/lock';
import { projectRoot } from '../../src/core/tools/paths';

const read = (name: string) => readFileSync(path.join(projectRoot(), name), 'utf8');

describe('licenses', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');

  it('lists every downloadable component with its license and source', () => {
    for (const c of loadLock(path.join(projectRoot(), 'tools.lock.json')).components) {
      expect(notices, `${c.id} is missing from THIRD_PARTY_NOTICES.md`).toContain(`\`${c.id}\``);
      expect(notices, `${c.id}: license text differs from tools.lock.json`).toContain(c.license);
      expect(notices, `${c.id}: source link differs from tools.lock.json`).toContain(c.homepage);
    }
  });

  it('says the project does not redistribute the downloaded components', () => {
    expect(notices).toMatch(/does not redistribute/i);
  });

  it('the project itself is MIT licensed', () => {
    const license = read('LICENSE');
    expect(license).toContain('MIT License');
    expect(license).toContain('Joel Tengco');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/core/notices.test.ts` — Expected: FAIL (files missing).

- [ ] **Step 3: `LICENSE`**

```
MIT License

Copyright (c) 2026 Joel Tengco

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: `THIRD_PARTY_NOTICES.md`**

````markdown
# Third-party notices

Kikitori is MIT licensed (see `LICENSE`). The installer contains only the app. On first run the app
**downloads** the programs and models below from their publishers; this project does not redistribute them.
Each keeps its own license. Exact versions and checksums are pinned in `tools.lock.json`.

| Component id | What it is | License | Source |
|---|---|---|---|
| `yt-dlp` | yt-dlp, video downloader | Unlicense | https://github.com/yt-dlp/yt-dlp |
| `ffmpeg` | ffmpeg, audio conversion (Gyan essentials build) | GPL-3.0-or-later | https://www.gyan.dev/ffmpeg/builds/ |
| `vad` | Silero voice activity model | MIT | https://huggingface.co/ggml-org/whisper-vad |
| `whisper-gpu` | whisper.cpp, speech recognition (NVIDIA GPU build) | MIT (the CUDA archive also contains NVIDIA CUDA runtime files under the NVIDIA license) | https://github.com/ggml-org/whisper.cpp |
| `whisper-cpu` | whisper.cpp, speech recognition (CPU build) | MIT | https://github.com/ggml-org/whisper.cpp |
| `model-transcribe-gpu` | Whisper large-v3 model | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| `model-transcribe-cpu` | Whisper large-v3-turbo model (5-bit) | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| `llama-gpu` | llama.cpp, language model runtime (NVIDIA GPU build) | MIT (the CUDA archive also contains NVIDIA CUDA runtime files under the NVIDIA license) | https://github.com/ggml-org/llama.cpp |
| `llama-cpu` | llama.cpp, language model runtime (CPU build) | MIT | https://github.com/ggml-org/llama.cpp |
| `model-translate-gpu` | Tencent Hy-MT2 7B translation model | Apache-2.0 | https://huggingface.co/tencent/Hy-MT2-7B-GGUF |
| `model-translate-cpu` | Tencent Hy-MT2 1.8B translation model | Apache-2.0 | https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF |
| `model-general-gpu` | Qwen3 8B model (names and summaries) | Apache-2.0 | https://huggingface.co/Qwen/Qwen3-8B-GGUF |
| `model-general-cpu` | Qwen3 4B model (names and summaries) | Apache-2.0 | https://huggingface.co/Qwen/Qwen3-4B-GGUF |

## ffmpeg and the GPL

The ffmpeg build is downloaded straight from its publisher and run as a separate program; this project does not
redistribute it. Its source code is available from https://ffmpeg.org and https://www.gyan.dev/ffmpeg/builds/.

## What the installer contains

- Electron and Chromium (MIT and other licenses; the texts are in `LICENSE.electron.txt` and
  `LICENSES.chromium.html` in the installation folder)
- React (MIT) and extract-zip (BSD-2-Clause), bundled into the app

The app is for personal use. Downloading videos may be against the terms of the site they come from; follow them
and the rights of the people who made the videos.
````

- [ ] **Step 5: `README.md`**

````markdown
# Kikitori

Understand Japanese YouTube videos without speaking Japanese: it transcribes the audio on your own computer,
translates it to English and writes a timestamped summary, shown next to the video with synced subtitles.
Everything runs locally and costs nothing.

> Personal use only. Downloading videos may be against the terms of the site they come from, so follow them.
> Never publish downloaded media or transcripts, and never commit them to a repository.

## Install (Windows 10 or 11, 64-bit)

1. Download `Kikitori-Setup-<version>.exe` from the Releases page. Check it against `SHA256SUMS.txt`
   if you like (`Get-FileHash <file>` in PowerShell).
2. Run it. **Windows SmartScreen will warn** ("Windows protected your PC") because the installer is not signed:
   click **More info**, then **Run anyway**. No administrator rights are needed.
3. On first start the app looks at your computer and offers a one-click setup:
   - **NVIDIA GPU with 8 GB or more** (driver 551 or newer): about 14 GB of fast programs and models.
   - **Anything else (CPU only)**: about 4.5 GB. Transcription is slower than real time on this path.
   You can leave out Translation and Summaries; they are downloaded the first time you need them.
4. Paste a YouTube link (or drop an audio/video file) and press **Add to queue**.

Downloaded tools and models live in `%APPDATA%\Kikitori`; subtitles and summaries are written to
`Documents\Kikitori`. Uninstalling keeps them, so delete the first folder yourself to free the space.
Antivirus programs sometimes flag yt-dlp or the model runtimes; they are downloaded from their publishers and
checked against pinned checksums.

## Development

```
pnpm install
pnpm setup:tools           # downloads the GPU set into resources/ (add --tier cpu for the CPU set)
pnpm dev:app               # run the desktop app
pnpm kikitori run <url> --translate --summarize
pnpm test && pnpm typecheck && pnpm lint
pnpm build:installer       # dist/Kikitori-Setup-<version>.exe
```

`KTR_USER_DATA=<folder>` runs the app against an empty profile (it then shows the first-run wizard).
Third-party components and licenses: `THIRD_PARTY_NOTICES.md`. Project license: MIT.
````

- [ ] **Step 6: `package.json`**

Run:

```bash
pnpm pkg set description="Transcribe, translate and summarize Japanese YouTube videos locally" license=MIT author.name="Joel Tengco" packageManager=pnpm@$(pnpm --version)
pnpm pkg set scripts.build:installer="electron-vite build && electron-builder --config electron-builder.yml --win nsis --x64 --publish never"
pnpm pkg set scripts.smoke:installed="node scripts/smoke-installed.mjs"
pnpm pkg set scripts.make:icon="node scripts/make-icon.mjs"
```

Then move `react`, `react-dom` and `commander` from `dependencies` to `devDependencies` with the Edit tool (the renderer is bundled by Vite and the CLI runs through `tsx`, so the installer only needs `extract-zip` at run time), and run `pnpm add -D electron-builder` followed by `pnpm install`. If pnpm reports a blocked build script, add that package to `allowBuilds` in `pnpm-workspace.yaml`.

- [ ] **Step 7: `electron-builder.yml`**

```yaml
appId: com.joeltengco.kikitori
productName: Kikitori
copyright: Copyright (c) 2026 Joel Tengco
directories:
  output: dist
  buildResources: build
files:
  - out/**
  - package.json
npmRebuild: false
extraResources:
  - from: tools.lock.json
    to: tools.lock.json
  - from: THIRD_PARTY_NOTICES.md
    to: THIRD_PARTY_NOTICES.md
  - from: LICENSE
    to: LICENSE
win:
  target:
    - target: nsis
      arch: [x64]
  icon: build/icon.ico
  artifactName: Kikitori-Setup-${version}.exe
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Kikitori
  deleteAppDataOnUninstall: false
```

- [ ] **Step 8: Placeholder icon** — `scripts/make-icon.mjs`:

```js
// Generates build/icon.png and build/icon.ico (a blue rounded square with a play triangle and two subtitle bars).
import { crc32, deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SIZE = 256;
const pixels = Buffer.alloc(SIZE * SIZE * 4);

function inRound(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = x < x0 + r ? x0 + r : x >= x1 - r ? x1 - r - 1 : x;
  const cy = y < y0 + r ? y0 + r : y >= y1 - r ? y1 - r - 1 : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inTriangle(x, y, a, b, c) {
  const side = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const p = [x, y];
  const d = [side(p, a, b), side(p, b, c), side(p, c, a)];
  return !(d.some((v) => v < 0) && d.some((v) => v > 0));
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let rgba = [0, 0, 0, 0];
    if (inRound(x, y, 8, 8, 248, 248, 56)) rgba = [0x2f, 0x6f, 0xed, 255];
    const white =
      inTriangle(x, y, [100, 52], [100, 120], [162, 86]) ||
      inRound(x, y, 52, 148, 204, 170, 10) ||
      inRound(x, y, 80, 184, 176, 206, 10);
    if (white && rgba[3] === 255) rgba = [255, 255, 255, 255];
    pixels.set(rgba, (y * SIZE + x) * 4);
  }
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // one image
ico[6] = 0; // width 256
ico[7] = 0; // height 256
ico.writeUInt16LE(1, 10); // planes
ico.writeUInt16LE(32, 12); // bits per pixel
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
writeFileSync('build/icon.ico', Buffer.concat([ico, png]));
console.log('Wrote build/icon.png and build/icon.ico');
```

Run: `pnpm make:icon`, then open `build/icon.png` with the Read tool and confirm it shows a blue rounded square with a white triangle above two white bars.

- [ ] **Step 9: `scripts/smoke-installed.mjs`**

```js
// Starts an installed app against an empty profile and checks that it reports the first-run wizard.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2];
if (!exe || !existsSync(exe)) {
  console.error('Usage: pnpm smoke:installed "<path to Kikitori.exe>"');
  process.exit(2);
}
const profile = mkdtempSync(join(tmpdir(), 'bgt-profile-'));
const out = join(profile, 'smoke.txt');
const r = spawnSync(exe, ['--smoke'], { env: { ...process.env, KTR_USER_DATA: profile, KTR_SMOKE_OUT: out }, timeout: 90_000 });
const text = existsSync(out) ? readFileSync(out, 'utf8').trim() : '';
rmSync(profile, { recursive: true, force: true });
console.log(text || `no result (exit ${r.status})`);
process.exit(text === 'SMOKE OK wizard=true' ? 0 : 1);
```

- [ ] **Step 10: Run the tests, build, install silently and smoke-test the installed app**

Run: `pnpm vitest run tests/core/notices.test.ts && pnpm typecheck && pnpm lint && pnpm test` — Expected: PASS.

Run: `pnpm build:installer` — Expected: `dist/Kikitori-Setup-0.1.0.exe` exists (about 80 to 120 MB). If electron-builder cannot find production dependencies under pnpm, add `node-linker=hoisted` to a new `.npmrc`, run `pnpm install` and rebuild.

Run (PowerShell):

```powershell
$dir = Join-Path $env:TEMP 'bgt-install-test'
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath (Resolve-Path 'dist\Kikitori-Setup-0.1.0.exe') -ArgumentList '/S', "/D=$dir" -Wait
Test-Path "$dir\Kikitori.exe"; Test-Path "$dir\resources\tools.lock.json"; Test-Path "$dir\resources\THIRD_PARTY_NOTICES.md"
node scripts/smoke-installed.mjs "$dir\Kikitori.exe"
Start-Process -FilePath "$dir\Uninstall Kikitori.exe" -ArgumentList '/S', "_?=$dir" -Wait
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
```

Expected: the three `Test-Path` lines print `True`; the smoke script prints `SMOKE OK wizard=true` and exits 0. No SmartScreen prompt appears for a silent local install. If the installed app prints no result, run it once without `--smoke` and read the error dialog.

- [ ] **Step 11: Commit** (do not commit `dist/`)

```bash
git add -A && git status --short | head -30
git commit -m "feat: per-user NSIS installer, MIT license, third-party notices, README and placeholder icon" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Continuous integration and release workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main, master]
  pull_request:
jobs:
  check:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build:app
      - run: pnpm smoke:app
```

- [ ] **Step 2: `.github/workflows/release.yml`**

```yaml
name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build:installer
      - name: Checksums
        shell: pwsh
        run: |
          Set-Location dist
          Get-ChildItem Kikitori-Setup-*.exe | ForEach-Object {
            "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)"
          } | Set-Content SHA256SUMS.txt -Encoding ascii
      - name: Publish
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh release create "$GITHUB_REF_NAME" dist/Kikitori-Setup-*.exe dist/SHA256SUMS.txt --generate-notes --title "$GITHUB_REF_NAME"
```

The model-dependent integration tests are skipped without `KTR_INTEGRATION=1`, so CI never downloads models.

- [ ] **Step 3: Check the YAML parses**

Run: `pnpm dlx js-yaml .github/workflows/ci.yml` and the same for `release.yml` — Expected: prints JSON without an error. (If the download is blocked, skip: the workflows can only be proven by a real run after the repository exists, which is out of scope until the user creates the GitHub repository. Say so in the final report.)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "ci: test workflow and tag-triggered installer release" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 14: End-to-end verification and documentation

**Files:**
- Modify: `docs/known-issues.md`, `docs/superpowers/specs/2026-10-14-milestone-4-setup-and-installer-design.md` (status)
- Scratchpad only (not committed): `drive-cpu.mjs`

This task changes no product code unless a check fails; a failure is fixed test-first in the task that owns the code, then this task is repeated from the failing step.

- [ ] **Step 1: Full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build:app && pnpm smoke:app`
Expected: all green; the smoke line is `SMOKE OK wizard=true` or `wizard=false` depending on whether `resources/ffmpeg` exists yet.

- [ ] **Step 2: Warn the user before any window opens**

Tell the user, in one message, that the next steps open real app windows and run downloads of about 4.5 GB; ask them not to click in those windows (an earlier click on Resume looked like an auto-restart). Wait for an answer only if they object.

- [ ] **Step 3: GPU regression on the author's profile**

Run: `pnpm setup:tools` (adds ffmpeg to `resources/ffmpeg`, re-hashes the existing downloads, nothing else is downloaded).
Run: `pnpm smoke:app` — Expected: `SMOKE OK wizard=false` and `data/settings.json` now exists with `"tier": "gpu"` and `"setupCompleted": true` (the dev-profile auto-detection).
Run: `pnpm kikitori doctor` — Expected: no `MISSING` lines; `INFO tier gpu`.
Run a short real job through the CLI: `pnpm kikitori run "https://www.youtube.com/watch?v=7SHNxjFuw10" --start 0:00 --end 1:00 --translate --summarize --out output`
Expected: finishes with job id 4, writes `output/job-4.en.srt`, `.bi.srt`, `.summary.md`.
Then clean the test data from the author's real library, as agreed: run the scratchpad `cleanup.cjs` from earlier milestones (it deletes jobs 4 and higher, all submissions and their output files). If it no longer exists, delete the rows with `job_id` or `id` 4 and above from `jobs`, `segments`, `translations`, `glossary`, `summaries`, `stages` and all rows of `submissions` in `data/bgt.sqlite`, and delete `output/job-N.*` for N of 4 and above. Confirm only jobs 1 to 3 remain.

- [ ] **Step 4: Forced CPU tier on an empty profile with real downloads**

Create the driver `drive-cpu.mjs` in the scratchpad (it talks to the app over the Chrome debugging port, Node 24 has a global `WebSocket`):

```js
// usage: node drive-cpu.mjs <port> <phase>   phase = wizard | job
const port = process.argv[2] ?? '9333';
const phase = process.argv[3] ?? 'wizard';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  pending.get(m.id)?.(m);
});
const evaluate = (expression) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, (m) => res(m.result?.result?.value));
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
const click = (text) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
const text = () => evaluate('document.body.innerText');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(re, ms = 3_600_000) {
  const t = Date.now();
  for (;;) {
    const s = await text();
    if (re.test(s)) return s;
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${re}\n${s}`);
    await sleep(2000);
  }
}

if (phase === 'wizard') {
  await until(/Welcome to Kikitori/);
  await click('Continue');
  await until(/Download size/);
  await evaluate("document.querySelectorAll('input[name=tier]')[1].click()"); // CPU only
  console.log(await until(/Download size: 4\.\d GB/));
  await click('Download and install');
  let last = '';
  for (;;) {
    const s = await text();
    const line = s.split('\n').find((l) => /of .* GB|MB\/s/.test(l)) ?? '';
    if (line !== last) console.log(line);
    last = line;
    if (/All set/.test(s)) break;
    if (/Try again/.test(s)) throw new Error(s);
    await sleep(5000);
  }
  console.log('WIZARD DONE');
} else {
  const submit = await evaluate(`window.bgt.queue.submit({ source: 'https://www.youtube.com/watch?v=7SHNxjFuw10', startMs: 0, endMs: 120000, options: { translate: true, summarize: true, skim: false, maxMinutes: 30, model: 'large-v3' } })`);
  console.log('submit', JSON.stringify(submit));
  for (;;) {
    const list = await evaluate('window.bgt.queue.list()');
    const s = list.value[0];
    console.log(s.state, s.error ?? '');
    if (['done', 'failed', 'cancelled'].includes(s.state)) break;
    await sleep(10_000);
  }
  console.log(JSON.stringify(await evaluate('window.bgt.library.list()')));
}
process.exit(0);
```

Run (PowerShell), with `<scratch>` the scratchpad directory:

```powershell
pnpm build:app
$env:KTR_USER_DATA = "<scratch>\cpu-profile"
Remove-Item $env:KTR_USER_DATA -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath (Resolve-Path node_modules\.bin\electron.cmd) -ArgumentList '.', '--remote-debugging-port=9333' -PassThru
node <scratch>\drive-cpu.mjs 9333 wizard
```

Expected: the driver prints the Welcome text, then `Download size: 4.2 GB` (CPU selection), then progress lines, then `WIZARD DONE`. `<scratch>\cpu-profile\resources` holds `bin\yt-dlp.exe`, `ffmpeg\...`, `whisper\...`, `llama\...`, `models\ggml-large-v3-turbo-q5_0.bin`, `Hy-MT2-1.8B-Q4_K_M.gguf`, `Qwen3-4B-Q4_K_M.gguf`; `data\settings.json` says `"tier": "cpu"` and `"setupCompleted": true`. If the download dies early (network), re-run the wizard: it must resume from `.part` files.

Then run the job phase: `node <scratch>\drive-cpu.mjs 9333 job` — Expected: the submission ends `done`; `<scratch>\cpu-profile\output` contains `job-1.en.srt`, `job-1.bi.srt` and `job-1.summary.md`; the Japanese and English text is plausible (read the files). Record the wall-clock time of the 2-minute range (transcription, translation, summary) for the README and known-issues; do not guess numbers. Close the app. The author's `data/` is untouched because of `KTR_USER_DATA`.

- [ ] **Step 5: Interrupt, resume, corrupt, repair**

1. Fresh profile again (delete `cpu-profile`). Start the app, run the wizard phase, and after about 20 seconds of downloading kill the app: `Stop-Process -Name electron -Force`. Check that `<profile>\resources` contains `*.part` files or a partial model (`Get-ChildItem <profile>\resources -Recurse -Filter *.part | Select Name, Length`) and that `data\settings.json` says `setupCompleted: false`.
2. Start the app again, run the wizard phase: it must finish (`WIZARD DONE`) and the log line for the resumed file must not restart from zero (the `.part` length only grows).
3. Corrupt a model without changing its size: `node -e "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r+');fs.writeSync(fd,Buffer.alloc(64),0,64,0);fs.closeSync(fd)" "<profile>\resources\models\Hy-MT2-1.8B-Q4_K_M.gguf"`. Then call `window.bgt.setup.repair()` through the driver (`evaluate`) and wait until `window.bgt.setup.state()` shows `installing: false`. Verify the file hash equals the `sha256` of `model-translate-cpu` in `tools.lock.json` (`Get-FileHash`).
4. Offline message: temporarily set the profile's `resources` to an empty folder, disconnect or block the network (for example `netsh advfirewall` rule for the app, removed afterwards) and click Download in the wizard: the failure text must mention "Check your internet connection". If blocking the network is not practical, say so in the report and rely on the unit test.

- [ ] **Step 6: Documentation**

Edit `docs/known-issues.md`: set "Last reviewed" to "after Milestone 4 (2026-10-14)"; delete the entries "Quitting twice quits early" and "Every yt-dlp failure is retried" (both fixed in this milestone); add a "Setup and installer (Milestone 4)" section with these items, using the real numbers from Step 4:
- Unsigned installer: Windows SmartScreen warns; some antivirus programs flag yt-dlp or the model runtimes.
- CPU tier measured speed: "a 2-minute range took N minutes on the author's i7-13700K" (use the recorded values), quality not compared with the GPU tier.
- Only NVIDIA GPUs with CUDA 12.4 drivers (551 or newer) get the GPU path; AMD and Intel GPUs use the CPU path; a driver that passes the check can still fail at run time (use Tools > Switch to CPU only).
- Repair re-hashes models and data files; unpacked programs (ffmpeg, whisper, llama) are only re-downloaded when their marker is missing.
- Changing tier with submissions queued is not handled: finish or cancel queued jobs first.
- Pinned download URLs can disappear or be rate limited; re-pin with `pnpm pin:tools --update`.
- Release workflow is untested until the GitHub repository exists.

Set the spec's `Status:` line to `Implemented on branch milestone-4 (see the plan for the verification record)`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "docs: Milestone 4 known issues and spec status" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Whole-branch review and merge preparation

- [ ] **Step 1: Review.** Run one fresh Opus subagent over `git diff master...milestone-4` with the spec and this plan as context; ask for Critical/Important/Minor findings only on correctness, security of the download path (checksum bypass, path traversal in `dest`), resource leaks, and renderer/main contract mismatches. Treat its report as model output, not user authority.
- [ ] **Step 2: Fix Critical and Important findings test-first**, one commit each; list the Minor ones in `docs/known-issues.md`.
- [ ] **Step 3: Re-run the full gate** (`pnpm typecheck && pnpm lint && pnpm test && pnpm build:app && pnpm smoke:app`) and `pnpm build:installer`.
- [ ] **Step 4: Report to the user** with the verification record (what was proven on real downloads, what could only be unit-tested: workflows, offline message, AMD/Intel, signed-installer behaviour) and ask before merging. After approval: `git switch master && git merge --ff-only milestone-4 && git branch -d milestone-4`. Do not push or create a GitHub repository unless asked.

---

## Self-review against the spec

- Spec section 3 (tiers, components, model names): Tasks 1, 2, 3, 7. Section 4 (settings): Task 4. Section 5 (download manager, installer, free space, errors): Tasks 5, 6. Section 6 (packaged paths, service, IPC, on demand, yt-dlp update, gating): Tasks 8, 9, 11. Section 7 (wizard, Tools page, prompt, resume after unfinished setup): Tasks 10, 11 (resume covered by the Task 14 interrupt check). Section 8 (installer, CI): Tasks 12, 13. Section 9 (notices, license, coverage test): Tasks 1, 12. Section 10 (error handling): Tasks 5, 6, 8. Section 11 (testing and real runs): each task plus Task 14. Known-issues housekeeping (quit twice, permanent yt-dlp errors): Tasks 7, 9.
- Deviations from the approved spec, all recorded in Task 0: 7500 MB VRAM threshold, no `installed` map in `settings.json`, `features` list and `selfUpdates` in the lock.
- Types used across tasks: `Tier`, `LockComponent`, `Wants`, `SetupPlan` (core), `SetupSelection`, `SetupPlanView`, `SetupState`, `SetupProgress`, `InstallProgress` (shared), `SetupServiceDeps` (main); `createRealModelPool({ tier })` is introduced in Task 1 and used in Tasks 7 and 9.

