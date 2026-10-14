import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGlossaryFile } from '../../src/core/llm/glossary-file';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-gloss-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (content: string) => {
  const file = path.join(dir, 'glossary.json');
  writeFileSync(file, content);
  return file;
};

describe('loadGlossaryFile', () => {
  it('reads a flat object of strings', () => {
    expect(loadGlossaryFile(write('{"ゆりまる":"Yurimaru"}'))).toEqual({ ゆりまる: 'Yurimaru' });
  });

  it('reads a file saved with a UTF-8 byte-order mark (Notepad, PowerShell 5.1)', () => {
    expect(loadGlossaryFile(write('﻿{"ゆりまる":"Yurimaru"}'))).toEqual({ ゆりまる: 'Yurimaru' });
  });

  it.each([
    ['not json', '{oops'],
    ['an array', '["a"]'],
    ['non-string values', '{"a": 1}'],
  ])('rejects %s with InvalidInput', (_n, content) => {
    expect(() => loadGlossaryFile(write(content))).toThrow(
      expect.objectContaining({ code: 'InvalidInput', message: expect.stringContaining('glossary.json') }),
    );
  });

  it('rejects a missing file with InvalidInput', () => {
    expect(() => loadGlossaryFile(path.join(dir, 'nope.json'))).toThrow(
      expect.objectContaining({ code: 'InvalidInput' }),
    );
  });
});
