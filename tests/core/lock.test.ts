import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  componentBytes,
  componentModelPath,
  findComponent,
  loadLock,
  markerPath,
  validateLock,
  type Lock,
  type LockEntry,
} from '../../src/core/tools/lock';
import { projectRoot } from '../../src/core/tools/paths';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-lock-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entry = (over: Partial<LockEntry> = {}): LockEntry => ({
  id: 'e1',
  version: '1',
  url: 'https://example.com/a',
  sha256: 'a'.repeat(64),
  size: 10,
  kind: 'file',
  dest: 'models/t.gguf',
  ...over,
});

const lock = (over: Partial<Lock['components'][number]> = {}): Lock => ({
  platform: 'win32-x64',
  components: [
    {
      id: 'model-translate-gpu',
      title: 'Translation model',
      features: ['translation'],
      tier: 'gpu',
      license: 'Apache-2.0',
      homepage: 'https://example.com',
      files: [entry()],
      ...over,
    },
  ],
});

describe('componentModelPath', () => {
  it('returns the resources path of a component file that exists', () => {
    mkdirSync(path.join(root, 'models'), { recursive: true });
    writeFileSync(path.join(root, 'models', 't.gguf'), 'x');
    expect(componentModelPath(lock(), 'model-translate-gpu', root)).toBe(path.join(root, 'models', 't.gguf'));
  });

  it('throws ToolMissing for an unknown component or a missing file', () => {
    expect(() => componentModelPath(lock(), 'nope', root)).toThrow(expect.objectContaining({ code: 'ToolMissing' }));
    expect(() => componentModelPath(lock(), 'model-translate-gpu', root)).toThrow(
      expect.objectContaining({ code: 'ToolMissing', message: expect.stringContaining('setup:tools') }),
    );
  });
});

describe('helpers', () => {
  it('findComponent and componentBytes', () => {
    const l = lock({ files: [entry({ size: 5 }), entry({ id: 'e2', size: 7 })] });
    expect(componentBytes(findComponent(l, 'model-translate-gpu'))).toBe(12);
  });

  it('markerPath differs for merged archives', () => {
    expect(markerPath(entry({ kind: 'zip', dest: 'llama' }), root)).toBe(path.join(root, 'llama', '.sha256'));
    expect(markerPath(entry({ kind: 'zip', dest: 'llama', merge: true, id: 'cudart' }), root)).toBe(
      path.join(root, 'llama', '.cudart.sha256'),
    );
  });
});

describe('validateLock', () => {
  it('accepts a good lock', () => {
    expect(validateLock(lock())).toEqual([]);
  });

  it('reports every kind of problem', () => {
    const bad = lock({
      license: '',
      files: [
        entry({ sha256: 'xyz', size: 0, url: 'http://example.com/a', dest: '../escape' }),
        entry({ id: 'e1' }),
      ],
    });
    bad.components.push({ ...bad.components[0], files: [entry({ id: 'e3' })] });
    const problems = validateLock(bad).join('\n');
    expect(problems).toMatch(/missing license/);
    expect(problems).toMatch(/sha256/);
    expect(problems).toMatch(/size/);
    expect(problems).toMatch(/https/);
    expect(problems).toMatch(/dest/);
    expect(problems).toMatch(/duplicate file id/);
    expect(problems).toMatch(/duplicate component/);
  });
});

describe('loadLock', () => {
  it('rejects the old flat format with a helpful message', () => {
    const file = path.join(root, 'old.json');
    writeFileSync(file, JSON.stringify({ platform: 'win32-x64', tools: [] }));
    expect(() => loadLock(file)).toThrow(expect.objectContaining({ code: 'InvalidInput', message: expect.stringContaining('old format') }));
  });
});

describe('the committed tools.lock.json', () => {
  it('is valid and covers every component the app asks for', () => {
    const real = loadLock(path.join(projectRoot(), 'tools.lock.json'));
    expect(validateLock(real)).toEqual([]);
    const ids = real.components.map((c) => c.id).sort();
    expect(ids).toEqual(
      [
        'ffmpeg',
        'llama-cpu',
        'llama-gpu',
        'model-general-cpu',
        'model-general-gpu',
        'model-transcribe-cpu',
        'model-transcribe-gpu',
        'model-translate-cpu',
        'model-translate-gpu',
        'vad',
        'whisper-cpu',
        'whisper-gpu',
        'yt-dlp',
      ].sort(),
    );
  });
});
