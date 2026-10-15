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

/**
 * Kills a child and everything it spawned. Resolves once the kill has been carried out: callers that are
 * about to exit (app quit) must wait for it, because grandchildren outlive a taskkill that is cut short.
 */
export function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return Promise.resolve();
  if (process.platform === 'win32') {
    // PyInstaller-style exes (yt-dlp) spawn a worker and ffmpeg; /T takes the whole tree.
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
  }
  child.kill('SIGTERM');
  return Promise.resolve();
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

    // Rejecting waits for the whole tree to be killed, so callers that exit right after an abort
    // (app quit) do not leave grandchildren behind.
    let killing: Promise<void> | null = null;
    const onAbort = () => {
      killing = killTree(child);
      void killing.then(() => reject(signal?.reason));
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
      // Killed because of an abort: that is a rejection, whichever of close/taskkill finishes first.
      if (signal?.aborted) void (killing ?? Promise.resolve()).then(() => reject(signal.reason));
      else resolve({ code, stdout, stderr });
    });
  });
}
