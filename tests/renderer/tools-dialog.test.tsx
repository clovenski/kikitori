// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolsDialog } from '../../src/app/renderer/components/ToolsDialog';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import { fakeSetupApi, stateFor } from './setup-fakes';

afterEach(cleanup);

const GPU_BASE = ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu'];

function renderTools(state = stateFor({}, GPU_BASE)) {
  const fake = fakeSetupApi({ state });
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <ApiProvider api={fake.api}>
      <ToolsDialog state={state} onChanged={onChanged} onClose={onClose} />
    </ApiProvider>,
  );
  return { ...fake, onChanged, onClose };
}

describe('ToolsDialog', () => {
  it('lists the components of the current tier with their state', () => {
    renderTools();
    expect(screen.getByText('Title yt-dlp').parentElement?.textContent).toContain('Installed');
    expect(screen.getByText('Title model-translate-gpu').parentElement?.textContent).toContain('Not installed');
    expect(screen.queryByText('Title model-translate-cpu')).toBeNull();
  });

  it('updates yt-dlp and shows what the updater said', async () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('Update yt-dlp'));
    expect(await screen.findByText('yt-dlp is up to date')).toBeTruthy();
    expect(t.setup.updateYtDlp).toHaveBeenCalled();
  });

  it('adds translation and summaries for the current tier', async () => {
    const t = renderTools(stateFor({ features: { translation: false, summaries: false } }, GPU_BASE));
    fireEvent.click(screen.getByText('Add translation and summaries'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledWith({ tier: 'gpu', features: { translation: true, summaries: true } }));
  });

  it('hides "add" when both features are already there', () => {
    renderTools(stateFor({ features: { translation: true, summaries: true } }, [...GPU_BASE, 'llama-gpu', 'model-translate-gpu', 'model-general-gpu']));
    expect(screen.queryByText('Add translation and summaries')).toBeNull();
  });

  it('repairs on request', async () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('Repair'));
    await waitFor(() => expect(t.setup.repair).toHaveBeenCalled());
  });

  it('asks before switching tier, explaining what is replaced, and then switches', async () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('Switch to CPU only'));
    expect(screen.getByText(/removes the GPU programs and models/)).toBeTruthy();
    expect(t.setup.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Switch'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledWith({ tier: 'cpu', features: { translation: true, summaries: true } }));
  });

  it('shows download progress and tells the app when it finished', async () => {
    const t = renderTools();
    act(() =>
      t.emit({
        phase: 'installing',
        message: null,
        progress: { componentId: 'llama-gpu', componentTitle: 'Title llama-gpu', fileId: 'f', fileIndex: 1, fileCount: 1, fileReceived: 1, fileTotal: 2, overallReceived: 1e9, overallTotal: 2e9, bytesPerSecond: 1e7, etaSeconds: 60 },
      }),
    );
    expect(screen.getByText(/Downloading Title llama-gpu/)).toBeTruthy();
    act(() => t.emit({ phase: 'done', progress: null, message: null }));
    expect(t.onChanged).toHaveBeenCalled();
  });

  it('opens the licence notices', () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('Licence notices'));
    expect(t.setup.openNotices).toHaveBeenCalled();
  });
});
