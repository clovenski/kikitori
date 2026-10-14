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
