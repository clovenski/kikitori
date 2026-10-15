// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdateBanner } from '../../src/app/renderer/components/UpdateBanner';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { UpdateState } from '../../src/app/shared/ipc';
import { fakeUpdatesApi } from './update-fakes';

afterEach(cleanup);

function renderBanner(initial: UpdateState) {
  const fake = fakeUpdatesApi(initial);
  render(
    <ApiProvider api={fake.api}>
      <UpdateBanner />
    </ApiProvider>,
  );
  return fake;
}

describe('UpdateBanner', () => {
  it('shows nothing when there is no update', async () => {
    const fake = renderBanner({ phase: 'idle' });
    await waitFor(() => expect(fake.updates.state).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('announces a new version and downloads only when the user asks', async () => {
    const fake = renderBanner({ phase: 'available', version: '0.3.0' });
    expect(await screen.findByText(/Kikitori 0\.3\.0 is available/)).toBeTruthy();
    expect(fake.updates.download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(fake.updates.download).toHaveBeenCalledTimes(1);
  });

  it('"Later" hides the offer until something new is announced', async () => {
    const fake = renderBanner({ phase: 'available', version: '0.3.0' });
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(fake.updates.download).not.toHaveBeenCalled();
    act(() => fake.emit({ phase: 'available', version: '0.3.1' }));
    expect(await screen.findByText(/Kikitori 0\.3\.1 is available/)).toBeTruthy();
  });

  it('shows progress while downloading, then offers the restart', async () => {
    const fake = renderBanner({ phase: 'available', version: '0.3.0' });
    await screen.findByText(/is available/);
    act(() => fake.emit({ phase: 'downloading', version: '0.3.0', percent: 42 }));
    expect(screen.getByText(/Downloading Kikitori 0\.3\.0.*42%/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
    act(() => fake.emit({ phase: 'ready', version: '0.3.0' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart and update' }));
    expect(fake.updates.install).toHaveBeenCalledTimes(1);
  });

  it('shows a failed download and lets the user try again', async () => {
    const fake = renderBanner({ phase: 'failed', version: '0.3.0', message: 'connection reset' });
    expect(await screen.findByText(/connection reset/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(fake.updates.download).toHaveBeenCalledTimes(1);
  });
});
