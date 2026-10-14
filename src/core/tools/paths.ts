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
