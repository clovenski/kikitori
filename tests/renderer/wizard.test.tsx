// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wizard } from '../../src/app/renderer/components/Wizard';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import { CPU_BOX, fakeSetupApi, GPU_BOX, stateFor } from './setup-fakes';

afterEach(cleanup);

function renderWizard(over: Parameters<typeof fakeSetupApi>[0] = {}) {
  const fake = fakeSetupApi({ state: stateFor({ needsWizard: true, completed: false }), ...over });
  const onFinished = vi.fn();
  render(
    <ApiProvider api={fake.api}>
      <Wizard onFinished={onFinished} />
    </ApiProvider>,
  );
  return { ...fake, onFinished };
}

const toChoose = async () => {
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText(/Download size/);
};

describe('Wizard shown again after setup was finished (a required tool went missing)', () => {
  const saved = stateFor({ needsWizard: true, completed: true, tier: 'cpu', features: { translation: false, summaries: true } });

  it('starts from the saved tier and features, not from the hardware recommendation', async () => {
    const t = renderWizard({ state: saved });
    await toChoose();
    expect((screen.getByLabelText(/CPU only/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Translation/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Summaries/) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(t.setup.plan).toHaveBeenLastCalledWith({ tier: 'cpu', features: { translation: false, summaries: true } }));
  });

  it('asks before changing tier, because that removes the installed programs and models', async () => {
    const t = renderWizard({ state: saved });
    await toChoose();
    fireEvent.click(screen.getByLabelText(/NVIDIA GPU/));
    await waitFor(() => expect(t.setup.plan).toHaveBeenLastCalledWith({ tier: 'gpu', features: { translation: false, summaries: true } }));
    fireEvent.click(screen.getByText('Download and install'));
    expect(screen.getByText(/removes the CPU programs and models/)).toBeTruthy();
    expect(t.setup.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Switch'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledWith({ tier: 'gpu', features: { translation: false, summaries: true } }));
  });

  it('keeping the current setup goes back to the saved tier', async () => {
    const t = renderWizard({ state: saved });
    await toChoose();
    fireEvent.click(screen.getByLabelText(/NVIDIA GPU/));
    fireEvent.click(screen.getByText('Download and install'));
    fireEvent.click(screen.getByText('Keep current setup'));
    expect((screen.getByLabelText(/CPU only/) as HTMLInputElement).checked).toBe(true);
    expect(t.setup.start).not.toHaveBeenCalled();
  });
});

describe('Wizard', () => {
  it('starts with a welcome that states what is downloaded and the personal-use terms', () => {
    const t = renderWizard();
    expect(screen.getByRole('heading', { name: 'Welcome to Kikitori' })).toBeTruthy();
    expect(screen.getByText(/personal use/i)).toBeTruthy();
    fireEvent.click(screen.getByText('License notices'));
    expect(t.setup.openNotices).toHaveBeenCalled();
  });

  it('recommends the GPU path for a capable NVIDIA card and shows the download size and free space', async () => {
    const t = renderWizard();
    await toChoose();
    expect(screen.getByText(/RTX 3080/)).toBeTruthy();
    expect((screen.getByLabelText(/NVIDIA GPU/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Download size: 14\.1 GB/)).toBeTruthy();
    expect(screen.getByText(/Free disk space: 200\.0 GB/)).toBeTruthy();
    expect(t.setup.plan).toHaveBeenLastCalledWith({ tier: 'gpu', features: { translation: true, summaries: true } });
  });

  it('opting out of Translation and Summaries shrinks the download', async () => {
    const t = renderWizard();
    await toChoose();
    fireEvent.click(screen.getByLabelText(/Translation/));
    fireEvent.click(screen.getByLabelText(/Summaries/));
    await waitFor(() => expect(screen.getByText(/Download size: 3\.8 GB/)).toBeTruthy());
    expect(t.setup.plan).toHaveBeenLastCalledWith({ tier: 'gpu', features: { translation: false, summaries: false } });
  });

  it('without a usable GPU it picks CPU, says why, and warns that transcription is slower than real time', async () => {
    renderWizard({ hardware: CPU_BOX });
    await toChoose();
    expect(screen.getByText(/No NVIDIA graphics card was found/)).toBeTruthy();
    expect((screen.getByLabelText(/CPU only/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/slower than real time/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Download size: 4\.2 GB/)).toBeTruthy());
  });

  it('lets the user override the recommendation', async () => {
    const t = renderWizard();
    await toChoose();
    fireEvent.click(screen.getByLabelText(/CPU only/));
    await waitFor(() => expect(t.setup.plan).toHaveBeenLastCalledWith({ tier: 'cpu', features: { translation: true, summaries: true } }));
  });

  it('refuses to start when the disk is too small', async () => {
    renderWizard({ hardware: { ...GPU_BOX, freeDiskBytes: 5e9 } });
    await toChoose();
    await waitFor(() => expect(screen.getByText(/Not enough free disk space/)).toBeTruthy());
    expect((screen.getByText('Download and install') as HTMLButtonElement).disabled).toBe(true);
  });

  it('installs, shows progress, and ends with the option to add the first video', async () => {
    const t = renderWizard({ hardware: CPU_BOX });
    await toChoose();
    fireEvent.click(screen.getByText('Download and install'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledWith({ tier: 'cpu', features: { translation: true, summaries: true } }));
    await screen.findByText(/Starting/);
    act(() => t.emit({ phase: 'done', progress: null, message: null }));
    fireEvent.click(await screen.findByText('Add your first video'));
    expect(t.onFinished).toHaveBeenCalled();
  });

  it('shows a failure and lets the user try again', async () => {
    const t = renderWizard();
    await toChoose();
    fireEvent.click(screen.getByText('Download and install'));
    await screen.findByText(/Starting/);
    act(() => t.emit({ phase: 'failed', progress: null, message: 'Could not download github.com' }));
    await screen.findByText('Could not download github.com');
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledTimes(2));
  });

  it('offers to continue a paused download and can cancel a running one', async () => {
    const t = renderWizard();
    await toChoose();
    fireEvent.click(screen.getByText('Download and install'));
    await screen.findByText(/Starting/);
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(t.setup.cancel).toHaveBeenCalled());
    act(() => t.emit({ phase: 'cancelled', progress: null, message: 'The download is paused and continues where it stopped.' }));
    fireEvent.click(await screen.findByText('Continue download'));
    await waitFor(() => expect(t.setup.start).toHaveBeenCalledTimes(2));
  });
});
