// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiProvider, unwrap, useLibrary, useProgress, useQueue } from '../../src/app/renderer/lib/api';
import type { BgtApi, Submission } from '../../src/app/shared/ipc';

afterEach(cleanup);

describe('unwrap', () => {
  it('returns the value or throws the error message', () => {
    expect(unwrap({ ok: true, value: 3 })).toBe(3);
    expect(() => unwrap({ ok: false, error: { code: 'X', message: 'broken' } })).toThrow('broken');
  });
});

function fakeApi() {
  const changed = new Set<(s: Submission[]) => void>();
  const progress = new Set<(p: { submissionId: number; event: { stage: 'translate'; done: number; total: number; message: string } }) => void>();
  const sub = { id: 1, state: 'running' } as Submission;
  const api = {
    queue: {
      list: async () => ({ ok: true as const, value: [sub] }),
      onChanged: (cb: (s: Submission[]) => void) => {
        changed.add(cb);
        return () => changed.delete(cb);
      },
      onProgress: (cb: never) => {
        progress.add(cb);
        return () => progress.delete(cb);
      },
    },
    library: { list: async () => ({ ok: true as const, value: [{ jobId: 5, title: 'T' }] }) },
  } as unknown as BgtApi;
  return { api, changed, progress };
}

function Probe() {
  const subs = useQueue();
  const progress = useProgress();
  const items = useLibrary(subs);
  return (
    <div>
      <span data-testid="subs">{subs.length}</span>
      <span data-testid="items">{items.length}</span>
      <span data-testid="progress">{progress.get(1)?.done ?? 'none'}</span>
    </div>
  );
}

describe('hooks', () => {
  it('load the queue and library and follow pushed updates', async () => {
    const { api, changed, progress } = fakeApi();
    render(
      <ApiProvider api={api}>
        <Probe />
      </ApiProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId('subs').textContent).toBe('1');
    expect(screen.getByTestId('items').textContent).toBe('1');
    expect(screen.getByTestId('progress').textContent).toBe('none');

    act(() => {
      for (const cb of progress) cb({ submissionId: 1, event: { stage: 'translate', done: 2, total: 3, message: '' } });
    });
    expect(screen.getByTestId('progress').textContent).toBe('2');

    act(() => {
      for (const cb of changed) cb([]);
    });
    expect(screen.getByTestId('subs').textContent).toBe('0');
  });
});
