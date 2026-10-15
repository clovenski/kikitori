import { vi } from 'vitest';
import type { BgtApi, OutputDirInfo } from '../../src/app/shared/ipc';

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export const DEFAULT_OUTPUT: OutputDirInfo = { dir: 'C:\Users\me\Documents\Kikitori', isDefault: true, locked: false };

export function fakeOutputApi(initial: OutputDirInfo = DEFAULT_OUTPUT) {
  const ok = <T>(value: T): Reply<T> => ({ ok: true, value });
  const output = {
    get: vi.fn(async (): Promise<Reply<OutputDirInfo>> => ok(initial)),
    choose: vi.fn(async (): Promise<Reply<OutputDirInfo | null>> => ok(null)),
    reset: vi.fn(async (): Promise<Reply<OutputDirInfo>> => ok(DEFAULT_OUTPUT)),
  };
  return { output, api: { output } as unknown as BgtApi };
}
