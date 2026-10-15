import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BgtError } from '../../src/core/errors';
import type { RunResult } from '../../src/core/tools/process';
import { downloadAudio } from '../../src/core/tools/ytdlp';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-dl-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  ytdlpPath: 'yt-dlp.exe',
  ffmpegPath: 'ffmpeg.exe',
  url: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
  section: null,
  backoffMs: 1,
};
const ok: RunResult = { code: 0, stdout: '', stderr: '' };
const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });

/** A fake yt-dlp: each call pops the next scripted result; a success writes the audio file. */
function script(results: (RunResult | Error)[]) {
  const calls: string[][] = [];
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args);
    const next = results[Math.min(calls.length - 1, results.length - 1)];
    if (next instanceof Error) throw next;
    if (next.code === 0) writeFileSync(path.join(dir, 'source.webm'), 'audio');
    return next;
  };
  return { run, calls };
}

describe('downloadAudio retries', () => {
  it('retries a transient failure and succeeds', async () => {
    const s = script([fail('ERROR: ffmpeg exited with code 1'), ok]);
    const file = await downloadAudio({ ...base, workDir: dir, run: s.run });
    expect(path.basename(file)).toBe('source.webm');
    expect(s.calls).toHaveLength(2);
  });

  it('gives up after three attempts with the recent yt-dlp output in the message', async () => {
    const s = script([fail('line one\nHTTP error 403 Forbidden\nERROR: ffmpeg exited with code 1')]);
    const err = await downloadAudio({ ...base, workDir: dir, run: s.run }).catch((e) => e);
    expect(err).toBeInstanceOf(BgtError);
    expect(err.code).toBe('DownloadFailed');
    expect(err.message).toContain('3 attempts');
    expect(err.message).toContain('HTTP error 403 Forbidden');
    expect(s.calls).toHaveLength(3);
  });

  it('removes a partial file between attempts so a stale one is never mistaken for the download', async () => {
    let first = true;
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (first) {
        first = false;
        writeFileSync(path.join(dir, 'source.webm.part'), 'half');
        return fail('ERROR: boom');
      }
      expect(readdirSync(dir)).toEqual([]); // the partial from attempt 1 is gone
      writeFileSync(path.join(dir, 'source.m4a'), 'audio');
      return ok;
    };
    const file = await downloadAudio({ ...base, workDir: dir, run });
    expect(path.basename(file)).toBe('source.m4a');
  });

  it('does not retry an abort', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const s = script([abort]);
    await expect(downloadAudio({ ...base, workDir: dir, run: s.run })).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.calls).toHaveLength(1);
  });

  it('treats a clean exit that produced no file as a failed attempt', async () => {
    const calls: number[] = [];
    const run = async () => {
      calls.push(1);
      if (calls.length === 2) writeFileSync(path.join(dir, 'source.webm'), 'audio');
      return ok;
    };
    const file = await downloadAudio({ ...base, workDir: dir, run });
    expect(path.basename(file)).toBe('source.webm');
    expect(calls).toHaveLength(2);
  });
});
