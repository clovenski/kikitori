import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Helper processes (whisper-cli, llama-server, yt-dlp, ffmpeg) normally die with their app. After a hard
 * crash or a Task Manager kill they can outlive it and keep a GPU or a download busy. Windows job objects
 * are not reachable from Node, so every helper is recorded here and the next start of the app or CLI kills
 * the ones whose owner is gone.
 */
export interface ChildRecord {
  pid: number;
  /** Image name the process was started with; used to be sure a pid has not been reused. */
  name: string;
  owner: number;
  ownerName: string;
}

export interface ProcessProbe {
  /** Image name of the running process with this pid, or null when there is none. */
  imageName(pid: number): string | null;
  killTree(pid: number): Promise<void>;
}

const base = (name: string) => path.basename(name.replace(/\\/g, '/')).toLowerCase();

export class ChildRegistry {
  constructor(
    private readonly file: string,
    private readonly self: { pid: number; name: string } = { pid: process.pid, name: path.basename(process.execPath) },
  ) {}

  list(): ChildRecord[] {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return Array.isArray(data) ? (data as ChildRecord[]) : [];
    } catch {
      return [];
    }
  }

  register(pid: number, name: string): void {
    const records = this.list().filter((r) => r.pid !== pid);
    records.push({ pid, name, owner: this.self.pid, ownerName: this.self.name });
    this.write(records);
  }

  unregister(pid: number): void {
    const records = this.list();
    const kept = records.filter((r) => r.pid !== pid);
    if (kept.length !== records.length) this.write(kept);
  }

  /**
   * Kills recorded helpers whose owner is no longer running. Records of live owners (including this
   * process, or a CLI job running in another terminal) are left alone; records whose process has ended,
   * or whose pid now belongs to another program, are just dropped.
   */
  async reapOrphans(probe: ProcessProbe): Promise<{ killed: number[] }> {
    const killed: number[] = [];
    const keep: ChildRecord[] = [];
    for (const record of this.list()) {
      const ownerLive =
        record.owner === this.self.pid || probe.imageName(record.owner)?.toLowerCase() === record.ownerName.toLowerCase();
      if (ownerLive) {
        keep.push(record);
        continue;
      }
      const running = probe.imageName(record.pid);
      if (running !== null && base(running) === base(record.name)) {
        await probe.killTree(record.pid);
        killed.push(record.pid);
      }
    }
    this.write(keep);
    return { killed };
  }

  private write(records: ChildRecord[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(records));
    renameSync(tmp, this.file);
  }
}

/** The real process table. */
export const systemProbe: ProcessProbe = {
  imageName(pid) {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      const m = /^"([^"]+)"/.exec((r.stdout ?? '').trim());
      return m ? m[1] : null;
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    const name = (r.stdout ?? '').trim();
    return r.status === 0 && name !== '' ? name : null;
  },
  killTree(pid) {
    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.once('error', () => resolve());
        k.once('close', () => resolve());
      });
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    return Promise.resolve();
  },
};

let active: ChildRegistry | null = null;

/** Turns recording on for this process (the app and the CLI do this; tests do not). */
export function enableChildRegistry(file: string): ChildRegistry {
  active = new ChildRegistry(file);
  return active;
}

/** App and CLI startup: kill helpers orphaned by an earlier crash, then record this process's helpers. */
export async function startChildTracking(file: string, probe: ProcessProbe = systemProbe): Promise<{ killed: number[] }> {
  const registry = enableChildRegistry(file);
  return registry.reapOrphans(probe);
}

export function disableChildRegistry(): void {
  active = null;
}

export function activeChildRegistry(): ChildRegistry | null {
  return active;
}
