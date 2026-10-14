import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadLock, type Lock, type LockEntry } from '../src/core/tools/lock';
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
