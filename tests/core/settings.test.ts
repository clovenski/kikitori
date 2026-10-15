import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentTier,
  defaultSettings,
  defaultTranscribeModel,
  ensureSettings,
  readSettings,
  writeSettings,
} from '../../src/core/setup/settings';
import { fakeLock, installFake } from '../helpers/lock-fakes';

let dir: string;
let res: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-settings-'));
  res = mkdtempSync(path.join(os.tmpdir(), 'bgt-settings-res-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(res, { recursive: true, force: true });
});

describe('read/write', () => {
  it('round-trips and leaves no temporary file', () => {
    const s = { ...defaultSettings('cpu'), setupCompleted: true };
    writeSettings(dir, s);
    expect(readSettings(dir)).toEqual(s);
    expect(existsSync(path.join(dir, 'settings.json.tmp'))).toBe(false);
  });

  it('returns null for a missing, corrupt or wrongly shaped file', () => {
    expect(readSettings(dir)).toBeNull();
    writeFileSync(path.join(dir, 'settings.json'), '{oops');
    expect(readSettings(dir)).toBeNull();
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, tier: 'tpu' }));
    expect(readSettings(dir)).toBeNull();
  });

  it('keeps a chosen output folder, and ignores an empty or non-text one', () => {
    writeSettings(dir, { ...defaultSettings('cpu'), outputDir: 'D:/subs' });
    expect(readSettings(dir)?.outputDir).toBe('D:/subs');
    for (const bad of ['', 5, null]) {
      writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...defaultSettings('cpu'), outputDir: bad }));
      expect(readSettings(dir)).toEqual(defaultSettings('cpu'));
    }
  });

  it('currentTier and defaultTranscribeModel follow the saved tier, gpu when unset', () => {
    expect(currentTier(dir)).toBe('gpu');
    expect(defaultTranscribeModel(dir)).toBe('large-v3');
    writeSettings(dir, defaultSettings('cpu'));
    expect(currentTier(dir)).toBe('cpu');
    expect(defaultTranscribeModel(dir)).toBe('large-v3-turbo-q5_0');
  });
});

describe('ensureSettings', () => {
  it('returns saved settings untouched', () => {
    writeSettings(dir, { ...defaultSettings('cpu'), setupCompleted: false });
    expect(ensureSettings({ dataDir: dir, lock: fakeLock(), resources: res }).tier).toBe('cpu');
  });

  it('a profile with nothing installed needs the wizard and writes nothing', () => {
    const s = ensureSettings({ dataDir: dir, lock: fakeLock(), resources: res });
    expect(s.setupCompleted).toBe(false);
    expect(existsSync(path.join(dir, 'settings.json'))).toBe(false);
  });

  it('a development checkout that has a whole tier installed is marked completed with the features it has', () => {
    const lock = fakeLock();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu', 'llama-gpu', 'model-translate-gpu']);
    const s = ensureSettings({ dataDir: dir, lock, resources: res });
    expect(s).toEqual({ version: 1, tier: 'gpu', features: { translation: true, summaries: false }, setupCompleted: true });
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'))).toEqual(s);
  });

  it('detects a complete cpu install too', () => {
    const lock = fakeLock();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu']);
    expect(ensureSettings({ dataDir: dir, lock, resources: res })).toMatchObject({ tier: 'cpu', setupCompleted: true });
  });
});
