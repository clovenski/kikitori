import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Helper processes (whisper-cli, llama-server, yt-dlp, ffmpeg) normally die with their app. After a hard
 * crash they can outlive it and keep a GPU or a download busy. Every helper is recorded here, and the next
 * start of the app or CLI kills the ones whose owner is gone.
 *
 * Killing the wrong process is far worse than leaving an orphan, so every doubt means "do nothing": a
 * record is only acted on when the owner is provably gone AND the pid still belongs to the same process
 * (same image name, started no later than it was recorded). The bookkeeping itself must never break a
 * running job, so every file operation here swallows its errors.
 */
export interface ChildRecord {
  pid: number;
  /** Image name the process was started with. */
  name: string;
  owner: number;
  ownerName: string;
  /** When the helper was recorded (ms). A process that started later than this is a reused pid. */
  startedAt?: number;
}

export interface ProcessProbe {
  /** Image name of the running process, null when there is none, undefined when it could not be determined. */
  imageName(pid: number): string | null | undefined;
  /** Start time (ms since epoch), null when the process is gone, undefined when it could not be determined. */
  startTime(pid: number): number | null | undefined;
  killTree(pid: number): Promise<void>;
}

/** A process that started more than this after the helper was recorded cannot be that helper. */
const REUSE_SLACK_MS = 5_000;

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
    records.push({ pid, name, owner: this.self.pid, ownerName: this.self.name, startedAt: Date.now() });
    this.write(records);
  }

  unregister(pid: number): void {
    const records = this.list();
    const kept = records.filter((r) => r.pid !== pid);
    if (kept.length !== records.length) this.write(kept);
  }

  /** Kills recorded helpers that are provably orphaned. Returns the pids it killed. */
  async reapOrphans(probe: ProcessProbe): Promise<{ killed: number[] }> {
    const killed: number[] = [];
    const keep: ChildRecord[] = [];
    for (const record of this.list()) {
      // 1. The owner must be provably gone. Itself, a live process of the same program, or "cannot tell" all mean no.
      const ownerImage = record.owner === this.self.pid ? this.self.name : probe.imageName(record.owner);
      if (ownerImage === undefined || ownerImage?.toLowerCase() === record.ownerName.toLowerCase()) {
        keep.push(record);
        continue;
      }
      // 2. The pid must still be the same program. Gone or someone else's: just forget the record.
      const running = probe.imageName(record.pid);
      if (running === undefined) {
        keep.push(record); // could not tell; try again next start
        continue;
      }
      if (running === null || base(running) !== base(record.name)) continue;
      // 3. ...and the same process: it must not have started after the helper was recorded.
      if (record.startedAt === undefined) continue; // recorded before identity checks existed: unprovable
      const started = probe.startTime(record.pid);
      if (started === undefined) {
        keep.push(record);
        continue;
      }
      if (started === null || started > record.startedAt + REUSE_SLACK_MS) continue;
      await probe.killTree(record.pid);
      killed.push(record.pid);
    }
    this.write(keep);
    return { killed };
  }

  private write(records: ChildRecord[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(records));
      renameSync(tmp, this.file);
    } catch {
      // A locked or unwritable file (antivirus, another process) must not break the helper being recorded.
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* nothing more to do */
      }
    }
  }
}

const PROBE_TIMEOUT_MS = 5_000;

/** The real process table. Every query has a timeout; a failed query answers "cannot tell" (undefined). */
export const systemProbe: ProcessProbe = {
  imageName(pid) {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: PROBE_TIMEOUT_MS,
      });
      if (r.error || r.status !== 0) return undefined;
      const m = /^"([^"]+)"/.exec((r.stdout ?? '').trim());
      return m ? m[1] : null;
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    if (r.error) return undefined;
    const name = (r.stdout ?? '').trim();
    return r.status === 0 && name !== '' ? name : null;
  },
  startTime(pid) {
    if (process.platform === 'win32') {
      const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() }`;
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      });
      if (r.error || r.status !== 0) return undefined;
      const text = (r.stdout ?? '').trim();
      if (text === '') return null;
      const ms = Number(text);
      return Number.isFinite(ms) ? ms : undefined;
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    if (r.error) return undefined;
    const text = (r.stdout ?? '').trim();
    if (r.status !== 0 || text === '') return null;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : undefined;
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
