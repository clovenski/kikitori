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

async function hfFile(
  repo: string,
  pick: (name: string) => boolean,
): Promise<{ name: string; url: string; sha256: string; rev: string }> {
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
  const ytSum = sums
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === 'yt-dlp.exe')?.[0];
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
  const cuda = wh.assets
    .filter((a) => /^whisper-cublas-.+-bin-x64\.zip$/.test(a.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .at(-1);
  const cpu = wh.assets.find((a) => a.name === 'whisper-bin-x64.zip');
  const asset = cuda ?? cpu;
  if (!asset) {
    throw new Error(
      `No Windows x64 whisper.cpp asset in ${wh.tag_name}: ${wh.assets.map((a) => a.name).join(', ')}`,
    );
  }
  if (!cuda) console.warn('WARNING: no CUDA build in this whisper.cpp release; pinning the CPU build.');
  const whSha = asset.digest?.startsWith('sha256:')
    ? asset.digest.slice(7)
    : await sha256OfUrl(asset.browser_download_url);
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
  tools.push({
    id: 'model-large-v3',
    version: large.rev,
    url: large.url,
    sha256: large.sha256,
    kind: 'file',
    dest: `models/${large.name}`,
  });
  const vad = await hfFile('ggml-org/whisper-vad', (n) => /^ggml-silero-v[\d.]+\.bin$/.test(n));
  tools.push({
    id: 'vad-silero',
    version: vad.rev,
    url: vad.url,
    sha256: vad.sha256,
    kind: 'file',
    dest: `models/${vad.name}`,
  });

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
