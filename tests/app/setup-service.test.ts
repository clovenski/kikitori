import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SetupService, type SetupServiceDeps } from '../../src/app/main/setup-service';
import type { SetupProgress } from '../../src/app/shared/ipc';
import type { HardwareInfo } from '../../src/core/setup/hardware';
import { readSettings, writeSettings } from '../../src/core/setup/settings';
import { fakeLock, installFake } from '../helpers/lock-fakes';

let res: string;
let data: string;
beforeEach(() => {
  res = mkdtempSync(path.join(os.tmpdir(), 'bgt-svc-res-'));
  data = mkdtempSync(path.join(os.tmpdir(), 'bgt-svc-data-'));
});
afterEach(() => {
  rmSync(res, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

const cpuBox: HardwareInfo = { gpus: [], best: null, tier: 'cpu', reason: 'No NVIDIA graphics card was found.', ramMb: 16_000, cores: 8 };
const CPU_BASE = ['yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu'];

function setup(over: Partial<SetupServiceDeps> = {}) {
  const lock = fakeLock(10);
  const emitted: SetupProgress[] = [];
  const installs: string[][] = [];
  const uninstalled: string[][] = [];
  const deps: SetupServiceDeps = {
    lock,
    resourcesDir: res,
    dataDir: data,
    hardware: async () => cpuBox,
    install: async (o) => {
      installs.push(o.components.map((c) => c.id));
      installFake(lock, o.resourcesDir, o.components.map((c) => c.id));
    },
    uninstall: (components) => void uninstalled.push(components.map((c) => c.id)),
    removeDamaged: async () => [],
    freeBytes: () => 10 ** 12,
    updateYtDlp: async () => 'yt-dlp is up to date',
    emit: (p) => emitted.push(p),
    log: () => {},
    ...over,
  };
  return { service: new SetupService(deps), lock, emitted, installs, uninstalled };
}

const cpuNoLlm = { tier: 'cpu' as const, features: { translation: false, summaries: false } };

describe('SetupService', () => {
  it('a fresh profile needs the wizard and lists every component as not installed', () => {
    const { service } = setup();
    const s = service.state();
    expect(s).toMatchObject({ needsWizard: true, completed: false, installing: false });
    expect(s.components).toHaveLength(13);
    expect(s.components.every((c) => !c.installed)).toBe(true);
  });

  it('detect maps the hardware and adds the free disk space', async () => {
    const { service } = setup();
    expect(await service.detect()).toMatchObject({ gpuName: null, recommendedTier: 'cpu', freeDiskBytes: 10 ** 12, cores: 8 });
  });

  it('start installs what is missing, saves the choice, reports done and ends the wizard', async () => {
    const { service, emitted, installs } = setup();
    service.start(cpuNoLlm);
    await service.whenIdle();
    expect(installs).toEqual([CPU_BASE]);
    expect(emitted[0].phase).toBe('installing');
    expect(emitted.at(-1)?.phase).toBe('done');
    expect(readSettings(data)).toEqual({ version: 1, tier: 'cpu', features: cpuNoLlm.features, setupCompleted: true });
    expect(service.state()).toMatchObject({ needsWizard: false, completed: true, tier: 'cpu', installing: false });
  });

  it('refuses a second start while one is running', async () => {
    let release = () => {};
    const { service } = setup({ install: () => new Promise<void>((resolve) => (release = resolve)) });
    service.start(cpuNoLlm);
    expect(() => service.start(cpuNoLlm)).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    release();
    await service.whenIdle();
  });

  it('a failure is reported with its message and the setup stays unfinished', async () => {
    const { service, emitted } = setup({
      install: async () => {
        throw new Error('Not enough free disk space');
      },
    });
    service.start(cpuNoLlm);
    await service.whenIdle();
    expect(emitted.at(-1)).toMatchObject({ phase: 'failed', message: 'Not enough free disk space' });
    expect(readSettings(data)?.setupCompleted).toBe(false);
    expect(service.state().needsWizard).toBe(true);
  });

  it('cancel aborts the download and reports it as paused, not failed', async () => {
    const { service, emitted } = setup({
      install: (o) =>
        new Promise<void>((_resolve, reject) => o.signal?.addEventListener('abort', () => reject(o.signal?.reason), { once: true })),
    });
    service.start(cpuNoLlm);
    await service.cancel();
    expect(emitted.at(-1)).toMatchObject({ phase: 'cancelled' });
    expect(service.state().installing).toBe(false);
  });

  it('switching tier removes the old tier first, then installs the new one', async () => {
    const { service, lock, uninstalled, installs } = setup();
    installFake(lock, res, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);
    writeSettings(data, { version: 1, tier: 'gpu', features: { translation: false, summaries: false }, setupCompleted: true });
    service.start(cpuNoLlm);
    await service.whenIdle();
    expect(uninstalled[0]).toContain('whisper-gpu');
    expect(uninstalled[0]).not.toContain('yt-dlp');
    expect(installs).toEqual([['whisper-cpu', 'model-transcribe-cpu']]);
    expect(readSettings(data)).toMatchObject({ tier: 'cpu', setupCompleted: true });
  });

  it('plan counts only the missing bytes and shows the free disk space', () => {
    const { service, lock } = setup();
    installFake(lock, res, ['yt-dlp', 'ffmpeg']);
    const view = service.plan(cpuNoLlm);
    expect(view.missingBytes).toBe(30);
    expect(view.freeDiskBytes).toBe(10 ** 12);
    expect(view.components.map((c) => [c.id, c.installed])).toEqual([
      ['yt-dlp', true], ['ffmpeg', true], ['vad', false], ['whisper-cpu', false], ['model-transcribe-cpu', false],
    ]);
  });

  it('missingFor adds what a job needs to the features already chosen', () => {
    const { service, lock } = setup();
    installFake(lock, res, CPU_BASE);
    writeSettings(data, { version: 1, tier: 'cpu', features: { translation: false, summaries: false }, setupCompleted: true });
    const view = service.missingFor({ translate: true, summarize: false, skim: false, maxMinutes: 30, model: 'x' });
    expect(view.selection).toEqual({ tier: 'cpu', features: { translation: true, summaries: false } });
    expect(view.components.filter((c) => !c.installed).map((c) => c.id)).toEqual(['llama-cpu', 'model-translate-cpu']);
  });

  it('autoGlossaryAvailable follows whether the general model is installed', () => {
    const { service, lock } = setup();
    writeSettings(data, { version: 1, tier: 'cpu', features: { translation: true, summaries: true }, setupCompleted: true });
    expect(service.autoGlossaryAvailable()).toBe(false);
    installFake(lock, res, ['model-general-cpu']);
    expect(service.autoGlossaryAvailable()).toBe(true);
  });

  it('repair deletes damaged files and downloads them again', async () => {
    const { service, lock, installs } = setup({
      removeDamaged: async (components) => {
        const bad = components.find((c) => c.id === 'vad');
        if (bad) rmSync(path.join(res, bad.files[0].dest), { force: true });
        return bad ? [bad.files[0]] : [];
      },
    });
    installFake(lock, res, CPU_BASE);
    writeSettings(data, { version: 1, tier: 'cpu', features: { translation: false, summaries: false }, setupCompleted: true });
    service.repair();
    await service.whenIdle();
    expect(installs).toEqual([['vad']]);
  });

  it('updateYtDlp returns the updater output', async () => {
    expect(await setup().service.updateYtDlp()).toBe('yt-dlp is up to date');
  });
});
