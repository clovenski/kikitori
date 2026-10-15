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
