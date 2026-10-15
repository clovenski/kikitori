import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLock } from '../../src/core/tools/lock';
import { projectRoot } from '../../src/core/tools/paths';

const read = (name: string) => readFileSync(path.join(projectRoot(), name), 'utf8');

describe('licences', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');

  it('lists every downloadable component with its licence and source', () => {
    for (const c of loadLock(path.join(projectRoot(), 'tools.lock.json')).components) {
      expect(notices, `${c.id} is missing from THIRD_PARTY_NOTICES.md`).toContain(`\`${c.id}\``);
      expect(notices, `${c.id}: licence text differs from tools.lock.json`).toContain(c.license);
      expect(notices, `${c.id}: source link differs from tools.lock.json`).toContain(c.homepage);
    }
  });

  it('says the project does not redistribute the downloaded components', () => {
    expect(notices).toMatch(/does not redistribute/i);
  });

  it('the project itself is MIT licensed', () => {
    const licence = read('LICENSE');
    expect(licence).toContain('MIT License');
    expect(licence).toContain('Joel Tengco');
  });
});
