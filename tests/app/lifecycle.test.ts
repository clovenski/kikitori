import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  denyAllPermissions,
  runShutdown,
  runStartup,
  shouldConfirmQuit,
  startupFailureMessage,
} from '../../src/app/main/lifecycle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('runShutdown', () => {
  it('runs every step in order and reports ok', async () => {
    const order: string[] = [];
    const result = await runShutdown(
      [
        { name: 'queue', run: async () => void order.push('queue') },
        { name: 'models', run: async () => void order.push('models') },
        { name: 'database', run: async () => void order.push('database') },
      ],
      10_000,
      () => {},
    );
    expect(order).toEqual(['queue', 'models', 'database']);
    expect(result.map((r) => r.outcome)).toEqual(['ok', 'ok', 'ok']);
  });

  it('keeps going after a step throws, so the models are still stopped', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    const result = await runShutdown(
      [
        {
          name: 'queue',
          run: async () => {
            throw new Error('shutdown blew up');
          },
        },
        { name: 'models', run: async () => void order.push('models') },
      ],
      10_000,
      (m) => logs.push(m),
    );
    expect(order).toEqual(['models']);
    expect(result).toEqual([
      { name: 'queue', outcome: 'error' },
      { name: 'models', outcome: 'ok' },
    ]);
    expect(logs.join('\n')).toContain('shutdown blew up');
  });

  it('gives up on a step that hangs after the deadline and still runs the next one', async () => {
    const order: string[] = [];
    const pending = runShutdown(
      [
        { name: 'queue', run: () => new Promise<void>(() => {}) }, // never settles
        { name: 'models', run: async () => void order.push('models') },
      ],
      5_000,
      () => {},
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result).toEqual([
      { name: 'queue', outcome: 'timeout' },
      { name: 'models', outcome: 'ok' },
    ]);
    expect(order).toEqual(['models']);
  });
});

describe('shouldConfirmQuit', () => {
  it('asks only while a job is actually running', () => {
    expect(shouldConfirmQuit([])).toBe(false);
    expect(shouldConfirmQuit([{ state: 'queued' }, { state: 'done' }, { state: 'failed' }])).toBe(false);
    expect(shouldConfirmQuit([{ state: 'done' }, { state: 'running' }])).toBe(true);
  });
});

describe('startup failures', () => {
  it('describes an error for the user', () => {
    expect(startupFailureMessage(new Error('database is locked'))).toEqual({
      title: 'BG Auto Translator could not start',
      detail: 'database is locked',
    });
    expect(startupFailureMessage('plain string').detail).toBe('plain string');
    expect(startupFailureMessage(undefined).detail).toMatch(/unknown/i);
  });

  it('runStartup reports a failure once and returns false; success returns true', async () => {
    const onFailure = vi.fn();
    expect(await runStartup(async () => {}, onFailure)).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
    expect(
      await runStartup(async () => {
        throw new Error('migration failed');
      }, onFailure),
    ).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ title: 'BG Auto Translator could not start', detail: 'migration failed' });
  });
});

describe('denyAllPermissions', () => {
  it('refuses every permission request and check', () => {
    let request: (wc: unknown, permission: string, cb: (granted: boolean) => void) => void = () => {};
    let check: (wc: unknown, permission: string) => boolean = () => true;
    denyAllPermissions({
      setPermissionRequestHandler: (h) => (request = h),
      setPermissionCheckHandler: (h) => (check = h),
    });
    const answers: boolean[] = [];
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read']) request(null, p, (g) => answers.push(g));
    expect(answers).toEqual([false, false, false, false]);
    expect(check(null, 'media')).toBe(false);
  });
});
