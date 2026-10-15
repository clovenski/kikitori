// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewJobDialog } from '../../src/app/renderer/components/NewJobDialog';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { BgtApi } from '../../src/app/shared/ipc';
import { fakeSetupApi, viewFor } from './setup-fakes';

afterEach(cleanup);

function setup(
  over: Partial<{
    probe: BgtApi['source']['probe'];
    submit: BgtApi['queue']['submit'];
    pickMedia: BgtApi['dialog']['pickMedia'];
    pickGlossary: BgtApi['dialog']['pickGlossary'];
    extra: Partial<BgtApi>;
    initialSource: string;
  }> = {},
) {
  const submit = vi.fn(over.submit ?? (async () => ({ ok: true as const, value: { id: 1 } as never })));
  const api = {
    source: {
      probe: over.probe ?? (async () => ({ ok: true as const, value: { title: 'My stream', durationMs: 600_000 } })),
      estimate: async () => ({ ok: true as const, value: 120 }),
    },
    queue: { submit },
    dialog: {
      pickMedia: over.pickMedia ?? (async () => ({ ok: true as const, value: 'C:/clip.wav' })),
      pickGlossary: over.pickGlossary ?? (async () => ({ ok: true as const, value: null })),
      pathForFile: () => 'C:/dropped.wav',
    },
    ...over.extra,
  } as unknown as BgtApi;
  const onClose = vi.fn();
  const onSubmitted = vi.fn();
  render(
    <ApiProvider api={api}>
      <NewJobDialog onClose={onClose} onSubmitted={onSubmitted} initialSource={over.initialSource} />
    </ApiProvider>,
  );
  return { submit, onClose, onSubmitted };
}

const url = 'https://www.youtube.com/watch?v=7SHNxjFuw10';

describe('NewJobDialog', () => {
  it('opens filled in and probed when given an initial source (the Process hand-off)', async () => {
    const probe = vi.fn(async () => ({ ok: true as const, value: { title: 'From the feed', durationMs: 300_000 } }));
    setup({ probe, initialSource: url });
    expect((screen.getByLabelText('YouTube link or file path') as HTMLInputElement).value).toBe(url);
    expect(await screen.findByText('From the feed')).toBeTruthy();
    expect(probe).toHaveBeenCalledTimes(1);
  });

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

  it('offers to download a missing component, then submits again once it is installed', async () => {
    const fake = fakeSetupApi();
    const view = viewFor({ tier: 'gpu', features: { translation: true, summaries: false } }, [
      'yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu',
    ]);
    fake.setup.missingFor.mockResolvedValue({ ok: true, value: view });
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'SetupRequired', message: 'Download first' } })
      .mockResolvedValueOnce({ ok: true, value: { id: 1 } });
    const t = setup({ submit, extra: { setup: fake.setup as never } });
    fireEvent.change(screen.getByLabelText('YouTube link or file path'), { target: { value: url } });
    await act(async () => {
      fireEvent.click(screen.getByText('Add to queue'));
    });
    expect(await screen.findByText('Download needed')).toBeTruthy();
    expect(t.onSubmitted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(fake.setup.start).toHaveBeenCalledWith(view.selection));
    act(() => fake.emit({ phase: 'done', progress: null, message: null }));
    await waitFor(() => expect(t.onSubmitted).toHaveBeenCalled());
    expect(submit).toHaveBeenCalledTimes(2);
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

  it('does not queue while the probe is still running, and says so', async () => {
    let finish: (v: { ok: true; value: { title: string; durationMs: number } }) => void = () => {};
    const t = setup({ probe: () => new Promise((resolve) => (finish = resolve as typeof finish)) });
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: url } });
    await act(async () => {
      fireEvent.blur(input);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Add to queue'));
    });
    expect(t.submit).not.toHaveBeenCalled();
    expect(screen.getByText(/Still reading the video/)).toBeTruthy();
    await act(async () => finish({ ok: true, value: { title: 'T', durationMs: 600_000 } }));
  });

  it('does not queue a source whose probe failed, and shows why', async () => {
    const t = setup({ probe: async () => ({ ok: false as const, error: { code: 'DownloadFailed', message: 'video is private' } }) });
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: url } });
    await act(async () => {
      fireEvent.blur(input);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Add to queue'));
    });
    expect(t.submit).not.toHaveBeenCalled();
    expect(screen.getAllByText('video is private').length).toBeGreaterThan(0);
  });

  it('probes first when the user clicks Add right after typing (no blur yet), and accepts a long video', async () => {
    const t = setup({ probe: async () => ({ ok: true as const, value: { title: 'Long stream', durationMs: 40 * 60_000 } }) });
    fireEvent.change(screen.getByLabelText('YouTube link or file path'), { target: { value: url } });
    await act(async () => {
      fireEvent.click(screen.getByText('Add to queue'));
    });
    expect(t.submit).toHaveBeenCalledTimes(1);
  });

  it('probes the same source again after a failed probe, so a transient error is not a dead end', async () => {
    let calls = 0;
    setup({
      probe: async () =>
        ++calls === 1
          ? { ok: false as const, error: { code: 'DownloadFailed', message: 'network hiccup' } }
          : { ok: true as const, value: { title: 'Second try', durationMs: 600_000 } },
    });
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: url } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(screen.getByText('network hiccup')).toBeTruthy();
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(screen.getByText('Second try')).toBeTruthy();
  });

  it('shows an error instead of throwing when the file chooser fails', async () => {
    setup({ pickMedia: async () => ({ ok: false as const, error: { code: 'Error', message: 'the dialog could not open' } }) });
    await act(async () => {
      fireEvent.click(screen.getByText('Choose file'));
    });
    expect(screen.getByText('the dialog could not open')).toBeTruthy();
  });

  it('shows an error instead of throwing when the glossary chooser fails', async () => {
    setup({ pickGlossary: async () => ({ ok: false as const, error: { code: 'Error', message: 'no glossary dialog' } }) });
    await act(async () => {
      fireEvent.click(screen.getByText('Glossary file...'));
    });
    expect(screen.getByText('no glossary dialog')).toBeTruthy();
  });

  it('probes a pasted path without the surrounding quotes', async () => {
    const probe = vi.fn(async () => ({ ok: true as const, value: { title: 'Clip', durationMs: 60_000 } }));
    setup({ probe });
    const q = String.fromCharCode(34);
    const input = screen.getByLabelText('YouTube link or file path');
    fireEvent.change(input, { target: { value: q + 'C:/my clips/a b.wav' + q } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(probe).toHaveBeenCalledWith('C:/my clips/a b.wav');
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
