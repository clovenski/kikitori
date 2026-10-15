// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueStrip } from '../../src/app/renderer/components/QueueStrip';
import type { ProgressEvent, Submission } from '../../src/app/shared/ipc';

afterEach(cleanup);

const sub = (over: Partial<Submission>): Submission => ({
  id: 1,
  source: 'https://www.youtube.com/watch?v=QGWaK-UF5QU',
  startMs: 0,
  endMs: null,
  options: { translate: true, summarize: true, skim: false, maxMinutes: 30, model: 'large-v3' },
  state: 'queued',
  jobId: null,
  error: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('QueueStrip', () => {
  it('renders nothing when there is nothing to show', () => {
    const { container } = render(<QueueStrip submissions={[]} progress={new Map()} onCancel={() => {}} onResume={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('shows the running submission with its stage and percentage, and cancels it', () => {
    const onCancel = vi.fn();
    const progress = new Map<number, ProgressEvent>([[1, { stage: 'translate', done: 1, total: 4, message: '' }]]);
    render(<QueueStrip submissions={[sub({ state: 'running' }), sub({ id: 2 }), sub({ id: 3 })]} progress={progress} onCancel={onCancel} onResume={() => {}} />);
    expect(screen.getByText('Translating')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('2 waiting')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledWith(1);
  });

  it('offers Resume for failed, interrupted and cancelled submissions and shows the error', () => {
    const onResume = vi.fn();
    render(
      <QueueStrip
        submissions={[sub({ id: 4, state: 'failed', error: 'DownloadFailed: nope' }), sub({ id: 5, state: 'interrupted' })]}
        progress={new Map()}
        onCancel={() => {}}
        onResume={onResume}
      />,
    );
    expect(screen.getByText('DownloadFailed: nope')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Resume')[0]);
    expect(onResume).toHaveBeenCalled();
    expect(screen.getAllByText('Resume')).toHaveLength(2);
  });

  it('offers "Update yt-dlp" only for download failures', () => {
    const onUpdate = vi.fn();
    render(
      <QueueStrip
        submissions={[sub({ id: 4, state: 'failed', error: 'DownloadFailed: yt-dlp failed after 3 attempts' }), sub({ id: 5, state: 'failed', error: 'TranscribeFailed: nope' })]}
        progress={new Map()}
        onCancel={() => {}}
        onResume={() => {}}
        onUpdateYtDlp={onUpdate}
      />,
    );
    const buttons = screen.getAllByText('Update yt-dlp');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onUpdate).toHaveBeenCalled();
  });

  it('does not show finished submissions', () => {
    const { container } = render(<QueueStrip submissions={[sub({ state: 'done' })]} progress={new Map()} onCancel={() => {}} onResume={() => {}} />);
    expect(container.textContent).toBe('');
  });
});
