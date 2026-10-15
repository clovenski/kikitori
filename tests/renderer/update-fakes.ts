import { vi } from 'vitest';
import type { BgtApi, UpdateState } from '../../src/app/shared/ipc';

export function fakeUpdatesApi(initial: UpdateState = { phase: 'idle' }, checkResult: UpdateState = initial) {
  const listeners = new Set<(s: UpdateState) => void>();
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const updates = {
    state: vi.fn(async () => ok(initial)),
    check: vi.fn<() => Promise<{ ok: true; value: UpdateState } | { ok: false; error: { code: string; message: string } }>>(async () => ok(checkResult)),
    download: vi.fn(async () => ok(null)),
    install: vi.fn(async () => ok(null)),
    onChanged: (cb: (s: UpdateState) => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  return { updates, api: { updates } as unknown as BgtApi, emit: (s: UpdateState) => listeners.forEach((cb) => cb(s)) };
}
