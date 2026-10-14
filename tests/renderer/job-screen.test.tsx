// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobScreen } from '../../src/app/renderer/components/JobScreen';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { BgtApi, JobDetail } from '../../src/app/shared/ipc';

afterEach(cleanup);

vi.mock('../../src/app/renderer/components/YouTubePlayer', () => ({
  YouTubePlayer: (p: { onFail(m: string): void; videoId: string }) => (
    <div data-testid="yt" data-video={p.videoId}>
      <button onClick={() => p.onFail('The owner of this video does not allow it to be embedded.')}>fail</button>
    </div>
  ),
}));
vi.mock('../../src/app/renderer/components/LocalPlayer', () => ({
  LocalPlayer: (p: { jobId: number }) => <div data-testid="local" data-job={p.jobId} />,
}));

const detail = (over: Partial<JobDetail['item']> = {}, withEnglish = true): JobDetail => ({
  item: {
    jobId: 1,
    title: 'GRWM',
    source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
    videoId: '7SHNxjFuw10',
    status: 'done',
    rangeStartMs: 0,
    rangeEndMs: 557_000,
    createdAt: '2026-10-14T00:00:00Z',
    hasTranslation: withEnglish,
    hasSummary: true,
    isLocalFile: false,
    ...over,
  },
  lines: [{ id: 1, startMs: 1000, endMs: 2000, ja: 'こんにちは', en: withEnglish ? 'Hello' : null }],
  summaries: [{ level: 'overview', idx: 0, startMs: 0, endMs: 1, text: 'Overview text' }],
});

function mount(d: JobDetail | null, openFolder = vi.fn(async () => ({ ok: true as const, value: null }))) {
  const api = {
    job: {
      get: async () => (d ? { ok: true as const, value: d } : { ok: false as const, error: { code: 'InvalidInput', message: 'There is no job 1.' } }),
      openOutputFolder: openFolder,
    },
  } as unknown as BgtApi;
  render(
    <ApiProvider api={api}>
      <JobScreen jobId={1} onBack={() => {}} />
    </ApiProvider>,
  );
  return { openFolder };
}

describe('JobScreen', () => {
  it('uses the YouTube player for URL jobs and the English transcript by default', async () => {
    mount(detail());
    await act(async () => {});
    expect(screen.getByTestId('yt').getAttribute('data-video')).toBe('7SHNxjFuw10');
    expect(screen.getByText('GRWM')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
    expect((screen.getByLabelText('Subtitles') as HTMLSelectElement).value).toBe('en');
  });

  it('defaults to Japanese when nothing was translated', async () => {
    mount(detail({}, false));
    await act(async () => {});
    expect((screen.getByLabelText('Subtitles') as HTMLSelectElement).value).toBe('ja');
  });

  it('uses the local player for local-file jobs', async () => {
    mount(detail({ isLocalFile: true, videoId: null, source: 'C:/clips/a.wav' }));
    await act(async () => {});
    expect(screen.getByTestId('local').getAttribute('data-job')).toBe('1');
  });

  it('switches to reader mode with a notice and an Open on YouTube link when the embed fails', async () => {
    mount(detail());
    await act(async () => {});
    fireEvent.click(screen.getByText('fail'));
    expect(screen.getByText(/does not allow it to be embedded/)).toBeTruthy();
    expect(screen.getByText('Open on YouTube')).toBeTruthy();
    expect(screen.queryByTestId('yt')).toBeNull();
    expect(screen.getByText('Hello')).toBeTruthy(); // transcript still works
  });

  it('shows the summary tab and opens the output folder', async () => {
    const t = mount(detail());
    await act(async () => {});
    fireEvent.click(screen.getByText('Summary'));
    expect(screen.getByText('Overview text')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('Open output folder'));
    });
    expect(t.openFolder).toHaveBeenCalledWith(1);
  });

  it('shows the error when the job cannot be loaded', async () => {
    mount(null);
    await act(async () => {});
    expect(screen.getByText('There is no job 1.')).toBeTruthy();
  });
});
