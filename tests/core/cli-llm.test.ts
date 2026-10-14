import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareLlmOptions } from '../../src/cli/llm';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-cli-llm-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('prepareLlmOptions', () => {
  it('rejects --skim with --translate', () => {
    expect(() => prepareLlmOptions({ skim: true, translate: true, out: 'o' })).toThrow(
      expect.objectContaining({ code: 'InvalidInput' }),
    );
  });

  it('loads the glossary file up front so a bad file fails before any transcription', () => {
    const file = path.join(dir, 'g.json');
    writeFileSync(file, '{oops');
    expect(() => prepareLlmOptions({ translate: true, glossary: file, out: 'o' })).toThrow(
      expect.objectContaining({ code: 'InvalidInput', message: expect.stringContaining('g.json') }),
    );
    writeFileSync(file, '{"a":"b"}');
    expect(prepareLlmOptions({ translate: true, glossary: file, out: 'o' }).userGlossary).toEqual({ a: 'b' });
  });
});
