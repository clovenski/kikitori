// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/app/renderer/App';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { BgtApi } from '../../src/app/shared/ipc';
import { channel, fakeChannelsApi, feedItem } from './channel-fakes';
import { fakeSetupApi, stateFor } from './setup-fakes';

afterEach(cleanup);

function renderApp(needsWizard: boolean, channelsOver: Parameters<typeof fakeChannelsApi>[0] = {}) {
  const fake = fakeSetupApi({ state: stateFor({ needsWizard, completed: !needsWizard }) });
  const ch = fakeChannelsApi(channelsOver);
  const api = {
    setup: fake.setup,
    channels: ch.channels,
    ping: async () => 'pong',
    library: { list: async () => ({ ok: true as const, value: [] }) },
    queue: {
      list: async () => ({ ok: true as const, value: [] }),
      onChanged: () => () => {},
      onProgress: () => () => {},
      cancel: async () => ({ ok: true as const, value: null }),
      resume: async () => ({ ok: true as const, value: null }),
    },
    source: {
      probe: async () => ({ ok: false as const, error: { code: 'Error', message: 'offline' } }),
      estimate: async () => ({ ok: true as const, value: null }),
    },
  } as unknown as BgtApi;
  render(
    <ApiProvider api={api}>
      <App />
    </ApiProvider>,
  );
  return { ...fake, ch };
}

describe('App first-run gating', () => {
  it('shows the wizard instead of the library when setup is needed', async () => {
    renderApp(true);
    expect(await screen.findByRole('heading', { name: 'Welcome to Kikitori' })).toBeTruthy();
    expect(screen.queryByText('New job')).toBeNull();
  });

  it('shows the library when setup is done', async () => {
    renderApp(false);
    expect((await screen.findAllByText('New job')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Welcome to Kikitori' })).toBeNull();
  });

  it('keeps the wizard open until the user chooses to continue, then opens the new-job dialog', async () => {
    const t = renderApp(true);
    fireEvent.click(await screen.findByText('Continue'));
    await screen.findByText(/Download size/);
    fireEvent.click(screen.getByText('Download and install'));
    await screen.findByText(/Starting/);
    act(() => t.emit({ phase: 'done', progress: null, message: null }));
    fireEvent.click(await screen.findByText('Add your first video'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'New job' })).toBeTruthy());
  });
});

describe('App channels', () => {
  it('shows how many videos are new on the Channels button, not counting ones that already have a job', async () => {
    renderApp(false, {
      channels: [channel(1)],
      feed: [feedItem('aaaaaaaaaaa'), feedItem('bbbbbbbbbbb'), feedItem('ccccccccccc', { job: { jobId: 3, status: 'done' } })],
    });
    const button = await screen.findByRole('button', { name: /Channels/ });
    await waitFor(() => expect(button.textContent).toContain('2'));
  });

  it('Process on a feed item opens the New job dialog with its link filled in', async () => {
    renderApp(false, { channels: [channel(1)], feed: [feedItem('7SHNxjFuw10')] });
    fireEvent.click(await screen.findByRole('button', { name: /Channels/ }));
    fireEvent.click(await screen.findByText('Process'));
    const dialog = await screen.findByRole('dialog', { name: 'New job' });
    expect(dialog).toBeTruthy();
    expect((screen.getByLabelText('YouTube link or file path') as HTMLInputElement).value).toBe('https://www.youtube.com/watch?v=7SHNxjFuw10');
  });
});
