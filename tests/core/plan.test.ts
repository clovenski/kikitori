import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlan, componentInstalled, ensureInstalled, entryInstalled } from '../../src/core/setup/plan';
import { findComponent } from '../../src/core/tools/lock';
import { fakeLock, installFake } from '../helpers/lock-fakes';

let res: string;
beforeEach(() => {
  res = mkdtempSync(path.join(os.tmpdir(), 'bgt-plan-'));
});
afterEach(() => rmSync(res, { recursive: true, force: true }));

const none = { translation: false, summaries: false };

describe('entryInstalled', () => {
  const lock = fakeLock(10);

  it('a file counts only when it has the pinned size', () => {
    const entry = findComponent(lock, 'vad').files[0];
    expect(entryInstalled(entry, res)).toBe(false);
    mkdirSync(path.join(res, 'models'), { recursive: true });
    writeFileSync(path.join(res, entry.dest), Buffer.alloc(3));
    expect(entryInstalled(entry, res)).toBe(false);
    writeFileSync(path.join(res, entry.dest), Buffer.alloc(10));
    expect(entryInstalled(entry, res)).toBe(true);
  });

  it('an archive counts when its marker matches the pinned checksum', () => {
    const entry = findComponent(lock, 'whisper-gpu').files[0];
    expect(entryInstalled(entry, res)).toBe(false);
    installFake(lock, res, ['whisper-gpu']);
    expect(entryInstalled(entry, res)).toBe(true);
  });

  it('yt-dlp after "yt-dlp -U" still counts: a self-updating file only has to exist', () => {
    const entry = findComponent(lock, 'yt-dlp').files[0];
    mkdirSync(path.join(res, 'bin'), { recursive: true });
    writeFileSync(path.join(res, entry.dest), Buffer.alloc(12345));
    expect(entryInstalled(entry, res)).toBe(true);
  });
});

describe('buildPlan', () => {
  it('lists only what is missing and counts only the missing bytes', () => {
    const lock = fakeLock(10);
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad']);
    const plan = buildPlan(lock, 'gpu', none, res);
    expect(plan.required.map((c) => c.id)).toEqual(['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);
    expect(plan.missing.map((c) => c.id)).toEqual(['whisper-gpu', 'model-transcribe-gpu']);
    expect(plan.missingBytes).toBe(20);
  });

  it('is empty when everything is installed', () => {
    const lock = fakeLock();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu']);
    expect(buildPlan(lock, 'cpu', none, res).missing).toEqual([]);
    expect(componentInstalled(findComponent(lock, 'whisper-cpu'), res)).toBe(true);
  });
});

describe('ensureInstalled', () => {
  it('throws SetupRequired naming the missing parts and their size', () => {
    const lock = fakeLock(1_000_000_000);
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);
    expect(() => ensureInstalled(lock, 'gpu', { translation: true, summaries: false }, res)).toThrow(
      expect.objectContaining({
        code: 'SetupRequired',
        message: expect.stringMatching(/Title of llama-gpu.*Title of model-translate-gpu.*2\.0 GB/),
      }),
    );
  });

  it('does nothing when everything needed is there', () => {
    const lock = fakeLock();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);
    expect(() => ensureInstalled(lock, 'gpu', none, res)).not.toThrow();
  });
});
