import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeChildRegistry,
  ChildRegistry,
  disableChildRegistry,
  startChildTracking,
  type ProcessProbe,
} from '../../src/core/tools/children';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-children-'));
  file = path.join(dir, 'children.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake process table: pid -> image name. */
function fakeProbe(table: Record<number, string>) {
  const killed: number[] = [];
  const probe: ProcessProbe = {
    imageName: (pid) => table[pid] ?? null,
    killTree: async (pid) => {
      killed.push(pid);
      delete table[pid];
    },
  };
  return { probe, killed, table };
}

describe('ChildRegistry', () => {
  it('records and forgets children, and shares them between instances on the same file', () => {
    const a = new ChildRegistry(file, { pid: 100, name: 'electron.exe' });
    a.register(500, 'whisper-cli.exe');
    a.register(501, 'ffmpeg.exe');
    expect(new ChildRegistry(file, { pid: 200, name: 'node.exe' }).list().map((r) => r.pid)).toEqual([500, 501]);
    a.unregister(500);
    expect(a.list().map((r) => r.pid)).toEqual([501]);
  });

  it('treats a missing or corrupt file as empty', () => {
    const reg = new ChildRegistry(file, { pid: 1, name: 'node.exe' });
    expect(reg.list()).toEqual([]);
    writeFileSync(file, '{not json');
    expect(reg.list()).toEqual([]);
    reg.register(7, 'x.exe');
    expect(reg.list().map((r) => r.pid)).toEqual([7]);
  });

  it('kills a child whose owner is gone and that is still running under the recorded name', async () => {
    new ChildRegistry(file, { pid: 100, name: 'electron.exe' }).register(500, 'llama-server.exe');
    const { probe, killed } = fakeProbe({ 500: 'llama-server.exe' }); // owner 100 is not in the table
    const reaper = new ChildRegistry(file, { pid: 200, name: 'electron.exe' });
    expect(await reaper.reapOrphans(probe)).toEqual({ killed: [500] });
    expect(killed).toEqual([500]);
    expect(reaper.list()).toEqual([]);
  });

  it('never touches children of a live owner (a CLI job running while the app starts)', async () => {
    new ChildRegistry(file, { pid: 100, name: 'node.exe' }).register(500, 'whisper-cli.exe');
    const { probe, killed } = fakeProbe({ 100: 'node.exe', 500: 'whisper-cli.exe' });
    const reaper = new ChildRegistry(file, { pid: 200, name: 'electron.exe' });
    expect(await reaper.reapOrphans(probe)).toEqual({ killed: [] });
    expect(killed).toEqual([]);
    expect(reaper.list().map((r) => r.pid)).toEqual([500]);
  });

  it('never touches its own children', async () => {
    const reg = new ChildRegistry(file, { pid: 200, name: 'electron.exe' });
    reg.register(500, 'yt-dlp.exe');
    const { probe, killed } = fakeProbe({ 500: 'yt-dlp.exe' });
    expect(await reg.reapOrphans(probe)).toEqual({ killed: [] });
    expect(killed).toEqual([]);
  });

  it('treats an owner pid that was reused by an unrelated program as dead', async () => {
    new ChildRegistry(file, { pid: 100, name: 'electron.exe' }).register(500, 'ffmpeg.exe');
    const { probe, killed } = fakeProbe({ 100: 'notepad.exe', 500: 'ffmpeg.exe' });
    const reaper = new ChildRegistry(file, { pid: 200, name: 'electron.exe' });
    expect(await reaper.reapOrphans(probe)).toEqual({ killed: [500] });
    expect(killed).toEqual([500]);
  });

  it('drops records whose process is gone or whose pid now belongs to another program, without killing', async () => {
    const owner = new ChildRegistry(file, { pid: 100, name: 'electron.exe' });
    owner.register(500, 'whisper-cli.exe'); // finished already
    owner.register(501, 'ffmpeg.exe'); // pid reused by something else
    const { probe, killed } = fakeProbe({ 501: 'chrome.exe' });
    const reaper = new ChildRegistry(file, { pid: 200, name: 'electron.exe' });
    expect(await reaper.reapOrphans(probe)).toEqual({ killed: [] });
    expect(killed).toEqual([]);
    expect(reaper.list()).toEqual([]);
  });

  it('compares image names case-insensitively and ignores directories', async () => {
    new ChildRegistry(file, { pid: 100, name: 'electron.exe' }).register(500, 'C:\\tools\\Llama-Server.EXE');
    const { probe, killed } = fakeProbe({ 500: 'llama-server.exe' });
    await new ChildRegistry(file, { pid: 200, name: 'electron.exe' }).reapOrphans(probe);
    expect(killed).toEqual([500]);
  });

  it('startChildTracking cleans up orphans first and then records its own children', async () => {
    new ChildRegistry(file, { pid: 100, name: 'electron.exe' }).register(500, 'whisper-cli.exe');
    const { probe, killed } = fakeProbe({ 500: 'whisper-cli.exe' });
    try {
      expect(await startChildTracking(file, probe)).toEqual({ killed: [500] });
      expect(killed).toEqual([500]);
      expect(activeChildRegistry()).not.toBeNull();
    } finally {
      disableChildRegistry();
    }
  });

  it('keeps the file valid JSON while records change', () => {
    const reg = new ChildRegistry(file, { pid: 1, name: 'node.exe' });
    for (let i = 0; i < 20; i++) reg.register(1000 + i, 'x.exe');
    for (let i = 0; i < 20; i += 2) reg.unregister(1000 + i);
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
    expect(reg.list()).toHaveLength(10);
  });
});
