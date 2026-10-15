// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/app/renderer/App';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { BgtApi } from '../../src/app/shared/ipc';
import { fakeSetupApi, stateFor } from './setup-fakes';

afterEach(cleanup);

function renderApp(needsWizard: boolean) {
  const fake = fakeSetupApi({ state: stateFor({ needsWizard, completed: !needsWizard }) });
  const api = {
    ...fake.api,
    ping: async () => 'pong',
    library: { list: async () => ({ ok: true as const, value: [] }) },
    queue: {
      list: async () => ({ ok: true as const, value: [] }),
      onChanged: () => () => {},
      onProgress: () => () => {},
      cancel: async () => ({ ok: true as const, value: null }),
      resume: async () => ({ ok: true as const, value: null }),
    },
  } as unknown as BgtApi;
  render(
    <ApiProvider api={api}>
      <App />
    </ApiProvider>,
  );
  return fake;
}

describe('App first-run gating', () => {
  it('shows the wizard instead of the library when setup is needed', async () => {
    renderApp(true);
    expect(await screen.findByRole('heading', { name: 'Welcome to BG Auto Translator' })).toBeTruthy();
    expect(screen.queryByText('New job')).toBeNull();
  });

  it('shows the library when setup is done', async () => {
    renderApp(false);
    expect((await screen.findAllByText('New job')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Welcome to BG Auto Translator' })).toBeNull();
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
