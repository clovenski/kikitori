import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OutputDirService } from '../../src/app/main/output-dir';
import { defaultSettings, readSettings, writeSettings } from '../../src/core/setup/settings';

let root: string;
let dataDir: string;
let defaultDir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bgt-outdir-'));
  dataDir = path.join(root, 'data');
  defaultDir = path.join(root, 'Documents', 'Kikitori');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function service(over: { locked?: boolean; pick?: (current: string) => Promise<string | null> } = {}) {
  return new OutputDirService({
    dataDir,
    defaultDir,
    locked: over.locked ?? false,
    pick: over.pick ?? (async () => null),
  });
}

describe('OutputDirService', () => {
  it('uses the default folder until one is chosen', () => {
    expect(service().info()).toEqual({ dir: defaultDir, isDefault: true, locked: false });
    expect(service().current()).toBe(defaultDir);
  });

  it('a chosen folder is created, saved in the settings file and used from then on', async () => {
    const chosen = path.join(root, 'my subtitles');
    const s = service({ pick: async () => chosen });
    expect(await s.choose()).toEqual({ dir: chosen, isDefault: false, locked: false });
    expect(existsSync(chosen)).toBe(true);
    expect(readSettings(dataDir)?.outputDir).toBe(chosen);
    expect(service().current()).toBe(chosen); // a fresh service (an app restart) reads it back
  });

  it('shows the folder the picker should start in, and changes nothing when the picker is cancelled', async () => {
    let shown = '';
    const s = service({
      pick: async (current) => {
        shown = current;
        return null;
      },
    });
    expect(await s.choose()).toBeNull();
    expect(shown).toBe(defaultDir);
    expect(readSettings(dataDir)).toBeNull();
  });

  it('refuses a folder it cannot write to and keeps the old one', async () => {
    const notAFolder = path.join(root, 'file.txt');
    writeFileSync(notAFolder, 'x');
    const s = service({ pick: async () => path.join(notAFolder, 'inside') });
    await expect(s.choose()).rejects.toThrow(/can't write to/i);
    expect(s.current()).toBe(defaultDir);
    expect(readSettings(dataDir)).toBeNull();
  });

  it('leaves no test file behind in the chosen folder', async () => {
    const chosen = path.join(root, 'out');
    await service({ pick: async () => chosen }).choose();
    expect(readdirSync(chosen)).toEqual([]);
  });

  it('keeps the rest of the settings when the folder changes, and reset goes back to the default', async () => {
    writeSettings(dataDir, { ...defaultSettings('cpu'), setupCompleted: true });
    const chosen = path.join(root, 'out');
    const s = service({ pick: async () => chosen });
    await s.choose();
    expect(readSettings(dataDir)).toMatchObject({ tier: 'cpu', setupCompleted: true, outputDir: chosen });
    expect(s.reset()).toEqual({ dir: defaultDir, isDefault: true, locked: false });
    expect(readSettings(dataDir)).toEqual({ ...defaultSettings('cpu'), setupCompleted: true });
    expect(JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))).not.toHaveProperty('outputDir');
  });

  it('an output folder fixed by the environment wins and cannot be changed', async () => {
    writeSettings(dataDir, { ...defaultSettings('cpu'), outputDir: path.join(root, 'saved') });
    const s = service({ locked: true, pick: async () => path.join(root, 'other') });
    expect(s.info()).toEqual({ dir: defaultDir, isDefault: false, locked: true });
    expect(s.current()).toBe(defaultDir);
    await expect(s.choose()).rejects.toThrow(/KTR_OUTPUT_DIR/);
    expect(() => s.reset()).toThrow(/KTR_OUTPUT_DIR/);
  });
});
