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
    for (const [id, files] of Object.entries(await p.pin())) if (update || !kept.has(id)) kept.set(id, files); // never move a pin that exists
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
