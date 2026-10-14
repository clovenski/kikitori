import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exeName, findVadModel, modelPath, resolveTool } from '../../src/core/tools/paths';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-paths-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const touch = (...parts: string[]) => {
  const file = path.join(root, ...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'x');
  return file;
};

describe('resolveTool', () => {
  it('prefers a bundled binary over PATH', () => {
    const bundled = touch('res', 'bin', exeName('ffmpeg'));
    const pathDir = path.dirname(touch('onpath', exeName('ffmpeg')));
    expect(resolveTool('ffmpeg', { resourcesDir: path.join(root, 'res'), pathEnv: pathDir })).toBe(bundled);
  });

  it('falls back to PATH', () => {
    const onPath = touch('onpath', exeName('ffmpeg'));
    expect(
      resolveTool('ffmpeg', { resourcesDir: path.join(root, 'res'), pathEnv: path.dirname(onPath) }),
    ).toBe(onPath);
  });

  it('finds whisper-cli in a nested folder of the extracted archive', () => {
    const nested = touch('res', 'whisper', 'Release', exeName('whisper-cli'));
    expect(resolveTool('whisper-cli', { resourcesDir: path.join(root, 'res'), pathEnv: '' })).toBe(nested);
  });

  it('throws ToolMissing with a helpful message', () => {
    expect(() => resolveTool('yt-dlp', { resourcesDir: path.join(root, 'res'), pathEnv: '' })).toThrow(
      expect.objectContaining({ code: 'ToolMissing', message: expect.stringContaining('setup:tools') }),
    );
    expect(() => resolveTool('ffmpeg', { resourcesDir: path.join(root, 'res'), pathEnv: '' })).toThrow(
      /PATH/,
    );
  });
});

describe('model paths', () => {
  it('modelPath returns an existing model and throws ToolMissing otherwise', () => {
    const file = touch('res', 'models', 'ggml-large-v3.bin');
    expect(modelPath('ggml-large-v3.bin', path.join(root, 'res'))).toBe(file);
    expect(() => modelPath('ggml-nope.bin', path.join(root, 'res'))).toThrow(
      expect.objectContaining({ code: 'ToolMissing' }),
    );
  });

  it('findVadModel finds a silero model or returns null', () => {
    expect(findVadModel(path.join(root, 'res'))).toBeNull();
    const file = touch('res', 'models', 'ggml-silero-v5.1.2.bin');
    expect(findVadModel(path.join(root, 'res'))).toBe(file);
  });
});
