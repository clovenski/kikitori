// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupDownloadDialog } from '../../src/app/renderer/components/SetupDownloadDialog';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import { fakeSetupApi, viewFor } from './setup-fakes';

afterEach(cleanup);

const selection = { tier: 'gpu' as const, features: { translation: true, summaries: false } };
const view = () => viewFor(selection, ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu']);

function renderDialog() {
  const fake = fakeSetupApi();
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    <ApiProvider api={fake.api}>
      <SetupDownloadDialog plan={view()} onDone={onDone} onCancel={onCancel} />
    </ApiProvider>,
  );
  return { ...fake, onDone, onCancel };
}

describe('SetupDownloadDialog', () => {
  it('lists only what is missing with the total size', () => {
    renderDialog();
    expect(screen.getByText('Download needed')).toBeTruthy();
    expect(screen.getByText(/Title llama-gpu/)).toBeTruthy();
    expect(screen.getByText(/Title model-translate-gpu/)).toBeTruthy();
    expect(screen.queryByText(/Title ffmpeg/)).toBeNull();
    expect(screen.getByText(/Total: 5\.3 GB/)).toBeTruthy();
  });

  it('downloads on request and reports when done', async () => {
    const t = renderDialog();
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledWith(selection));
    act(() => t.emit({ phase: 'done', progress: null, message: null }));
    expect(t.onDone).toHaveBeenCalled();
  });

  it('shows a failure and can retry', async () => {
    const t = renderDialog();
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalled());
    act(() => t.emit({ phase: 'failed', progress: null, message: 'No internet' }));
    expect(await screen.findByText('No internet')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledTimes(2));
  });

  it('"Not now" closes without downloading', () => {
    const t = renderDialog();
    fireEvent.click(screen.getByText('Not now'));
    expect(t.onCancel).toHaveBeenCalled();
    expect(t.setup.cancel).not.toHaveBeenCalled();
  });
});
