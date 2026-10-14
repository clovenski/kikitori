import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockedModelPath, type Lock } from '../../src/core/tools/lock';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-lock-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lock: Lock = {
  platform: 'win32-x64',
  tools: [
    { id: 'model-translate', version: '1', url: 'u', sha256: 's', kind: 'file', dest: 'models/t.gguf' },
  ],
};

describe('lockedModelPath', () => {
  it('returns the resources path of a locked model that exists', () => {
    mkdirSync(path.join(root, 'models'), { recursive: true });
    writeFileSync(path.join(root, 'models', 't.gguf'), 'x');
    expect(lockedModelPath('model-translate', lock, root)).toBe(path.join(root, 'models', 't.gguf'));
  });

  it('throws ToolMissing for an unknown id or a missing file', () => {
    expect(() => lockedModelPath('nope', lock, root)).toThrow(expect.objectContaining({ code: 'ToolMissing' }));
    expect(() => lockedModelPath('model-translate', lock, root)).toThrow(
      expect.objectContaining({ code: 'ToolMissing', message: expect.stringContaining('setup:tools') }),
    );
  });
});
