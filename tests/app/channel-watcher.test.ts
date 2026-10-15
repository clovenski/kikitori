import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelWatcher, type ChannelWatcherDeps } from '../../src/app/main/channel-watcher';
import { ChannelStore } from '../../src/core/db/channel-repo';
import { migrate } from '../../src/core/db/schema';
import { Database } from '../../src/core/db/sqlite';

let store: ChannelStore;
beforeEach(() => {
  vi.useFakeTimers();
  const db = new Database(':memory:');
  migrate(db);
  store = new ChannelStore(db);
  for (const id of ['UCa', 'UCb', 'UCc']) store.addChannel({ youtubeChannelId: id, handle: null, title: id, url: `https://www.youtube.com/channel/${id}` });
});
afterEach(() => vi.useRealTimers());

function make(over: Partial<ChannelWatcherDeps> = {}) {
  const checked: string[] = [];
  const signals: AbortSignal[] = [];
  const onChanged = vi.fn();
  const deps: ChannelWatcherDeps = {
    store,
    check: async (c, signal) => {
      checked.push(c.youtubeChannelId);
      signals.push(signal);
      return { added: 0, error: null };
    },
    canRun: () => true,
    onChanged,
    log: () => {},
    startDelayMs: 1000,
    intervalMs: 10_000,
    pauseMs: 100,
    ...over,
  };
  return { watcher: new ChannelWatcher(deps), checked, signals, onChanged };
}

describe('ChannelWatcher', () => {
  it('checks every channel after the start delay, then again every interval', async () => {
    const { watcher, checked, onChanged } = make();
    watcher.start();
    await vi.advanceTimersByTimeAsync(900);
    expect(checked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checked).toEqual(['UCa', 'UCb', 'UCc']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checked).toHaveLength(6);
    await watcher.stop();
  });

  it('skips a round while it cannot run and tries again at the next one', async () => {
    let allowed = false;
    const { watcher, checked } = make({ canRun: () => allowed });
    watcher.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(checked).toEqual([]);
    allowed = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checked).toEqual(['UCa', 'UCb', 'UCc']);
    await watcher.stop();
  });

  it('refresh runs a check now, and a second request while one runs shares it', async () => {
    let release = () => {};
    let calls = 0;
    const { watcher } = make({
      check: () => {
        calls++;
        return new Promise((resolve) => (release = () => resolve({ added: 1, error: null })));
      },
    });
    const first = watcher.refresh();
    const second = watcher.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    for (let i = 0; i < 3; i++) {
      release();
      await vi.advanceTimersByTimeAsync(200);
    }
    await Promise.all([first, second]);
    expect(calls).toBe(3); // one per channel, in sequence, and the second request did not start another round
  });

  it('refresh(id) checks only that channel', async () => {
    const { watcher, checked } = make();
    await watcher.refresh(2);
    expect(checked).toEqual(['UCb']);
  });

  it('keeps going after one channel throws and logs it', async () => {
    const log = vi.fn();
    const seen: string[] = [];
    const { watcher } = make({
      log,
      check: async (c) => {
        seen.push(c.youtubeChannelId);
        if (c.youtubeChannelId === 'UCb') throw new Error('database is locked');
        return { added: 0, error: null };
      },
    });
    const done = watcher.refresh();
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(seen).toEqual(['UCa', 'UCb', 'UCc']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('database is locked'));
  });

  it('stop aborts a check in progress, waits for it and cancels the timer', async () => {
    let started: AbortSignal | null = null;
    const { watcher, checked } = make({
      check: (_c, signal) =>
        new Promise((_resolve, reject) => {
          started = signal;
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        }),
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).not.toBeNull();
    await watcher.stop();
    expect((started as unknown as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checked).toEqual([]);
  });

  it('refresh does nothing while it cannot run', async () => {
    const { watcher, checked } = make({ canRun: () => false });
    await watcher.refresh();
    expect(checked).toEqual([]);
  });

  it('work run through the watcher (following a channel) is aborted by stop, which waits for it', async () => {
    const { watcher } = make();
    let signal: AbortSignal | null = null;
    let settled = false;
    const work = watcher
      .runTracked(
        (s) =>
          new Promise<string>((_resolve, reject) => {
            signal = s;
            s.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          }),
      )
      .catch((e) => e)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(signal).not.toBeNull();
    expect((signal as unknown as AbortSignal).aborted).toBe(false);
    await watcher.stop();
    expect(settled).toBe(true);
    expect(await work).toMatchObject({ name: 'AbortError' });
  });

  it('work started after stop is already aborted', async () => {
    const { watcher } = make();
    await watcher.stop();
    let seen: boolean | null = null;
    await watcher.runTracked(async (s) => (seen = s.aborted));
    expect(seen).toBe(true);
  });

  it('start after stop gives new work a live signal again', async () => {
    const { watcher } = make();
    await watcher.stop();
    watcher.start();
    let seen: boolean | null = null;
    await watcher.runTracked(async (s) => (seen = s.aborted));
    expect(seen).toBe(false);
    await watcher.stop();
  });
});
