import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateService, type UpdaterPort } from '../../src/app/main/update-service';
import type { UpdateState } from '../../src/app/shared/ipc';

afterEach(() => vi.useRealTimers());

function setup(over: { enabled?: boolean; canQuit?: boolean } = {}) {
  const updater = {
    check: vi.fn<UpdaterPort['check']>(async () => null),
    download: vi.fn<UpdaterPort['download']>(async () => {}),
    install: vi.fn<UpdaterPort['install']>(),
  };
  const emitted: UpdateState[] = [];
  const log = vi.fn();
  const canQuit = vi.fn(() => over.canQuit ?? true);
  const service = new UpdateService({
    updater,
    enabled: over.enabled ?? true,
    canQuit,
    emit: (s) => emitted.push(s),
    log,
    startDelayMs: 1000,
    intervalMs: 10_000,
  });
  return { service, updater, emitted, log, canQuit };
}

describe('UpdateService.check', () => {
  it('reports an available version without downloading it', async () => {
    const t = setup();
    t.updater.check.mockResolvedValue({ version: '0.3.0' });
    expect(await t.service.check()).toEqual({ phase: 'available', version: '0.3.0' });
    expect(t.service.state()).toEqual({ phase: 'available', version: '0.3.0' });
    expect(t.emitted).toEqual([{ phase: 'available', version: '0.3.0' }]);
    expect(t.updater.download).not.toHaveBeenCalled();
  });

  it('stays idle when the app is up to date', async () => {
    const t = setup();
    expect(await t.service.check()).toEqual({ phase: 'idle' });
    expect(t.emitted).toEqual([]);
  });

  it('throws when the check fails, and keeps the earlier state', async () => {
    const t = setup();
    t.updater.check.mockResolvedValueOnce({ version: '0.3.0' }).mockRejectedValueOnce(new Error('offline'));
    await t.service.check();
    await expect(t.service.check()).rejects.toThrow('offline');
    expect(t.service.state()).toEqual({ phase: 'available', version: '0.3.0' });
  });

  it('shares one check between callers that arrive together', async () => {
    const t = setup();
    await Promise.all([t.service.check(), t.service.check()]);
    expect(t.updater.check).toHaveBeenCalledTimes(1);
  });

  it('is refused when updates are not available (development builds)', async () => {
    const t = setup({ enabled: false });
    await expect(t.service.check()).rejects.toThrow(/installed app/);
    expect(t.updater.check).not.toHaveBeenCalled();
  });

  it('does not look again while a download runs or an update is ready', async () => {
    const t = setup();
    t.updater.check.mockResolvedValue({ version: '0.3.0' });
    await t.service.check();
    await t.service.download();
    await t.service.check();
    expect(t.updater.check).toHaveBeenCalledTimes(1);
    expect(t.service.state()).toEqual({ phase: 'ready', version: '0.3.0' });
  });
});

describe('UpdateService.download', () => {
  it('does nothing until the user asks, and only for an announced update', async () => {
    const t = setup();
    await t.service.download();
    expect(t.updater.download).not.toHaveBeenCalled();
  });

  it('reports whole-number progress and ends ready', async () => {
    const t = setup();
    t.updater.check.mockResolvedValue({ version: '0.3.0' });
    t.updater.download.mockImplementation(async (onProgress) => {
      onProgress(10.4);
      onProgress(10.9);
      onProgress(55);
      onProgress(100);
    });
    await t.service.check();
    t.emitted.length = 0;
    await t.service.download();
    expect(t.emitted).toEqual([
      { phase: 'downloading', version: '0.3.0', percent: 0 },
      { phase: 'downloading', version: '0.3.0', percent: 10 },
      { phase: 'downloading', version: '0.3.0', percent: 55 },
      { phase: 'downloading', version: '0.3.0', percent: 100 },
      { phase: 'ready', version: '0.3.0' },
    ]);
  });

  it('ignores a second request while downloading', async () => {
    const t = setup();
    t.updater.check.mockResolvedValue({ version: '0.3.0' });
    let finish = () => {};
    t.updater.download.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    await t.service.check();
    const first = t.service.download();
    await t.service.download();
    expect(t.updater.download).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(t.service.state().phase).toBe('ready');
  });

  it('records a failure with the version, and a retry can succeed', async () => {
    const t = setup();
    t.updater.check.mockResolvedValue({ version: '0.3.0' });
    t.updater.download.mockRejectedValueOnce(new Error('connection reset'));
    await t.service.check();
    await t.service.download();
    expect(t.service.state()).toEqual({ phase: 'failed', version: '0.3.0', message: 'connection reset' });
    await t.service.download();
    expect(t.service.state()).toEqual({ phase: 'ready', version: '0.3.0' });
  });
});

describe('UpdateService.install', () => {
  async function ready(t: ReturnType<typeof setup>) {
    t.updater.check.mockResolvedValue({ version: '0.3.0' });
    await t.service.check();
    await t.service.download();
  }

  it('installs only a downloaded update', async () => {
    const t = setup();
    expect(t.service.install()).toBe(false);
    t.updater.check.mockResolvedValue({ version: '0.3.0' });
    await t.service.check();
    expect(t.service.install()).toBe(false);
    expect(t.updater.install).not.toHaveBeenCalled();
  });

  it('restarts into the new version', async () => {
    const t = setup();
    await ready(t);
    expect(t.service.install()).toBe(true);
    expect(t.updater.install).toHaveBeenCalledTimes(1);
  });

  it('does not restart when the user keeps a running job going', async () => {
    const t = setup({ canQuit: false });
    await ready(t);
    expect(t.service.install()).toBe(false);
    expect(t.updater.install).not.toHaveBeenCalled();
    expect(t.service.state()).toEqual({ phase: 'ready', version: '0.3.0' });
  });
});

describe('UpdateService schedule', () => {
  it('checks shortly after start and then on an interval, and a failed background check is only logged', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.updater.check.mockRejectedValue(new Error('offline'));
    t.service.start();
    expect(t.updater.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.updater.check).toHaveBeenCalledTimes(1);
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('offline'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.updater.check).toHaveBeenCalledTimes(2);
    t.service.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.updater.check).toHaveBeenCalledTimes(2);
  });

  it('never checks when disabled', async () => {
    vi.useFakeTimers();
    const t = setup({ enabled: false });
    t.service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.updater.check).not.toHaveBeenCalled();
  });
});
