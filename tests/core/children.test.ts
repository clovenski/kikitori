import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * A fake process table: pid -> image name. `starts` gives each pid's start time (default: long ago, i.e.
 * before anything was recorded). `undefinedFor` makes the probe fail ("cannot tell") for those pids.
 */
function fakeProbe(table: Record<number, string>, opts: { starts?: Record<number, number>; undefinedFor?: number[] } = {}) {
  const killed: number[] = [];
  const probe: ProcessProbe = {
    imageName: (pid) => (opts.undefinedFor?.includes(pid) ? undefined : (table[pid] ?? null)),
    startTime: (pid) => (opts.undefinedFor?.includes(pid) ? undefined : table[pid] === undefined ? null : (opts.starts?.[pid] ?? 0)),
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

  it('never kills a process that merely reuses the recorded pid (it started after the helper was recorded)', async () => {
    new ChildRegistry(file, { pid: 100, name: 'electron.exe' }).register(500, 'ffmpeg.exe');
    // The user's own ffmpeg, started an hour from now relative to the record, happens to have pid 500.
    const { probe, killed } = fakeProbe({ 500: 'ffmpeg.exe' }, { starts: { 500: Date.now() + 3_600_000 } });
    const reaper = new ChildRegistry(file, { pid: 200, name: 'electron.exe' });
    expect(await reaper.reapOrphans(probe)).toEqual({ killed: [] });
    expect(killed).toEqual([]);
    expect(reaper.list()).toEqual([]);
  });

  it('keeps a record and kills nothing when the process table cannot be read (probe failed)', async () => {
    new ChildRegistry(file, { pid: 100, name: 'electron.exe' }).register(500, 'llama-server.exe');
    // The child check fails, owner 100 is absent.
    const childUnknown = fakeProbe({ 500: 'llama-server.exe' }, { undefinedFor: [500] });
    const reaper = new ChildRegistry(file, { pid: 200, name: 'electron.exe' });
    expect(await reaper.reapOrphans(childUnknown.probe)).toEqual({ killed: [] });
    expect(childUnknown.killed).toEqual([]);
    expect(reaper.list().map((r) => r.pid)).toEqual([500]);

    // The owner check fails: the owner might be alive, so its children are left alone.
    const ownerUnknown = fakeProbe({ 500: 'llama-server.exe' }, { undefinedFor: [100] });
    expect(await reaper.reapOrphans(ownerUnknown.probe)).toEqual({ killed: [] });
    expect(ownerUnknown.killed).toEqual([]);
    expect(reaper.list().map((r) => r.pid)).toEqual([500]);
  });

  it('keeps a record when the start time cannot be read, and drops one that predates identity checks', async () => {
    new ChildRegistry(file, { pid: 100, name: 'electron.exe' }).register(500, 'ffmpeg.exe');
    const probe = fakeProbe({ 500: 'ffmpeg.exe' });
    probe.probe.startTime = () => undefined;
    const reaper = new ChildRegistry(file, { pid: 200, name: 'electron.exe' });
    expect(await reaper.reapOrphans(probe.probe)).toEqual({ killed: [] });
    expect(reaper.list().map((r) => r.pid)).toEqual([500]);

    writeFileSync(file, JSON.stringify([{ pid: 700, name: 'ffmpeg.exe', owner: 100, ownerName: 'electron.exe' }]));
    const old = fakeProbe({ 700: 'ffmpeg.exe' });
    expect(await reaper.reapOrphans(old.probe)).toEqual({ killed: [] }); // no startedAt: identity cannot be proven
    expect(old.killed).toEqual([]);
    expect(reaper.list()).toEqual([]);
  });

  it('survives a registry file that cannot be written: bookkeeping must never break a running helper', async () => {
    // A directory where the file should be makes every write fail, as a locked file would on Windows.
    mkdirSync(path.join(dir, 'locked.json'));
    const reg = new ChildRegistry(path.join(dir, 'locked.json'), { pid: 1, name: 'node.exe' });
    expect(() => reg.register(500, 'x.exe')).not.toThrow();
    expect(() => reg.unregister(500)).not.toThrow();
    expect(await reg.reapOrphans(fakeProbe({}).probe)).toEqual({ killed: [] });
  });

  it('keeps the file valid JSON while records change', () => {
    const reg = new ChildRegistry(file, { pid: 1, name: 'node.exe' });
    for (let i = 0; i < 20; i++) reg.register(1000 + i, 'x.exe');
    for (let i = 0; i < 20; i += 2) reg.unregister(1000 + i);
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
    expect(reg.list()).toHaveLength(10);
  });
});
