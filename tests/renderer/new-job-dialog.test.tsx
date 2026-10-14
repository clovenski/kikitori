// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewJobDialog } from '../../src/app/renderer/components/NewJobDialog';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { BgtApi } from '../../src/app/shared/ipc';

afterEach(cleanup);

function setup(over: Partial<{ probe: BgtApi['source']['probe']; submit: BgtApi['queue']['submit'] }> = {}) {
  const submit = vi.fn(over.submit ?? (async () => ({ ok: true as const, value: { id: 1 } as never })));
  const api = {
    source: {
      probe: over.probe ?? (async () => ({ ok: true as const, value: { title: 'My stream', durationMs: 600_000 } })),
      estimate: async () => ({ ok: true as const, value: 120 }),
    },
    queue: { submit },
    dialog: { pickMedia: async () => ({ ok: true as const, value: 'C:/clip.wav' }), pickGlossary: async () => ({ ok: true as const, value: null }), pathForFile: () => 'C:/dropped.wav' },
  } as unknown as BgtApi;
  const onClose = vi.fn();
  const onSubmitted = vi.fn();
  render(
    <ApiProvider api={api}>
      <NewJobDialog onClose={onClose} onSubmitted={onSubmitted} />
    </ApiProvider>,
  );
  return { submit, onClose, onSubmitted };
}

const url = 'https://www.youtube.com/watch?v=7SHNxjFuw10';

describe('NewJobDialog', () => {
  it('probes the URL on blur and shows the title, duration and estimate', async () => {
    setup();
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: url } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(screen.getByText('My stream')).toBeTruthy();
    expect(screen.getByText(/0:10:00/)).toBeTruthy();
    expect(screen.getByText(/about 2 min/)).toBeTruthy();
  });

  it('shows a probe error without blocking another attempt', async () => {
    setup({ probe: async () => ({ ok: false as const, error: { code: 'DownloadFailed', message: 'blocked by YouTube' } }) });
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: url } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(screen.getByText('blocked by YouTube')).toBeTruthy();
  });

  it('submits a valid request and reports success', async () => {
    const t = setup();
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: url } });
    await act(async () => {
      fireEvent.blur(input);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Add to queue'));
    });
    expect(t.submit).toHaveBeenCalledWith(
      expect.objectContaining({ source: url, startMs: 0, endMs: null, options: expect.objectContaining({ translate: true, summarize: true, skim: false }) }),
    );
    expect(t.onSubmitted).toHaveBeenCalled();
  });

  it('blocks submission with a message for skim + translate', async () => {
    const t = setup();
    fireEvent.change(screen.getByLabelText('YouTube link or file path'), { target: { value: url } });
    fireEvent.click(screen.getByLabelText('Skim (summary only)'));
    await act(async () => {
      fireEvent.click(screen.getByText('Add to queue'));
    });
    expect(t.submit).not.toHaveBeenCalled();
    expect(screen.getByText(/Skim skips full translation/)).toBeTruthy();
  });

  it('fills the source from the file chooser and from a dropped file', async () => {
    setup();
    await act(async () => {
      fireEvent.click(screen.getByText('Choose file'));
    });
    expect((screen.getByLabelText('YouTube link or file path') as HTMLInputElement).value).toBe('C:/clip.wav');
    await act(async () => {
      fireEvent.drop(screen.getByText(/Drop a file here/), { dataTransfer: { files: [new File(['x'], 'dropped.wav')] } });
    });
    expect((screen.getByLabelText('YouTube link or file path') as HTMLInputElement).value).toBe('C:/dropped.wav');
  });
});
