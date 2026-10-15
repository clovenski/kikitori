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
  /** Runs on the finished `.part` before it is renamed. Throwing a BgtError fails the download without a retry. */
  verify?(part: string): Promise<void>;
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
      await opts.verify?.(part);
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
