// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolsDialog } from '../../src/app/renderer/components/ToolsDialog';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { BgtApi, OutputDirInfo, UpdateState } from '../../src/app/shared/ipc';
import { DEFAULT_OUTPUT, fakeOutputApi } from './output-fakes';
import { fakeSetupApi, stateFor } from './setup-fakes';
import { fakeUpdatesApi } from './update-fakes';

afterEach(cleanup);

const GPU_BASE = ['yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu'];

function renderTools(state = stateFor({}, GPU_BASE), checkResult: UpdateState = { phase: 'idle' }, outputInfo: OutputDirInfo = DEFAULT_OUTPUT) {
  const fake = fakeSetupApi({ state });
  const up = fakeUpdatesApi({ phase: 'idle' }, checkResult);
  const out = fakeOutputApi(outputInfo);
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <ApiProvider api={{ ...fake.api, ...up.api, ...out.api } as BgtApi}>
      <ToolsDialog state={state} onChanged={onChanged} onClose={onClose} />
    </ApiProvider>,
  );
  return { ...fake, onChanged, onClose, up, out };
}

describe('ToolsDialog', () => {
  it('lists the components of the current tier with their state', () => {
    renderTools();
    expect(screen.getByText('Title yt-dlp').parentElement?.textContent).toContain('Installed');
    expect(screen.getByText('Title model-translate-gpu').parentElement?.textContent).toContain('Not installed');
    expect(screen.queryByText('Title model-translate-cpu')).toBeNull();
  });

  it('shows the output folder and says it is the default', async () => {
    renderTools();
    expect(await screen.findByText(DEFAULT_OUTPUT.dir)).toBeTruthy();
    expect(screen.getByText(/Default location/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use default folder' })).toBeNull();
  });

  it('changes the output folder through the picker and shows the new one, with a way back to the default', async () => {
    const t = renderTools();
    await screen.findByText(DEFAULT_OUTPUT.dir);
    t.out.output.choose.mockResolvedValueOnce({ ok: true, value: { dir: 'D:/Subs', isDefault: false, locked: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Change folder...' }));
    expect(await screen.findByText('D:/Subs')).toBeTruthy();
    expect(screen.queryByText(/Default location/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use default folder' }));
    expect(await screen.findByText(DEFAULT_OUTPUT.dir)).toBeTruthy();
    expect(t.out.output.reset).toHaveBeenCalledTimes(1);
  });

  it('keeps the current output folder when the picker is cancelled, and shows why a folder was refused', async () => {
    const t = renderTools();
    await screen.findByText(DEFAULT_OUTPUT.dir);
    fireEvent.click(screen.getByRole('button', { name: 'Change folder...' })); // the fake picker is cancelled by default
    await waitFor(() => expect(t.out.output.choose).toHaveBeenCalledTimes(1));
    expect(screen.getByText(DEFAULT_OUTPUT.dir)).toBeTruthy();
    t.out.output.choose.mockResolvedValueOnce({ ok: false, error: { code: 'InvalidInput', message: "Can't write to Z:/nope" } });
    fireEvent.click(screen.getByRole('button', { name: 'Change folder...' }));
    expect(await screen.findByText("Can't write to Z:/nope")).toBeTruthy();
    expect(screen.getByText(DEFAULT_OUTPUT.dir)).toBeTruthy();
  });

  it('cannot change an output folder that the environment fixes', async () => {
    renderTools(stateFor({}, GPU_BASE), { phase: 'idle' }, { dir: 'E:/fixed', isDefault: false, locked: true });
    expect(await screen.findByText('E:/fixed')).toBeTruthy();
    expect(screen.getByText(/KTR_OUTPUT_DIR/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Change folder...' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Use default folder' })).toBeNull();
  });

  it('checks for updates and says what it found', async () => {
    const t = renderTools();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Kikitori is up to date.')).toBeTruthy();
    expect(t.up.updates.check).toHaveBeenCalledTimes(1);
  });

  it('names the new version when one is available, and shows a failed check', async () => {
    const t = renderTools(stateFor({}, GPU_BASE), { phase: 'available', version: '0.3.0' });
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Kikitori 0.3.0 is available.')).toBeTruthy();
    t.up.updates.check.mockResolvedValueOnce({ ok: false, error: { code: 'Error', message: 'offline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Could not check for updates: offline')).toBeTruthy();
  });

  it('closes on Escape and on a press outside the dialog, but not on a press inside it', () => {
    const t = renderTools();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(t.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(t.onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(t.onClose).toHaveBeenCalledTimes(2);
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

  it('opens the license notices', () => {
    const t = renderTools();
    fireEvent.click(screen.getByText('License notices'));
    expect(t.setup.openNotices).toHaveBeenCalled();
  });
});
