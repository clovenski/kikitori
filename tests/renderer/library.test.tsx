// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryScreen } from '../../src/app/renderer/components/LibraryScreen';
import type { LibraryItem, Submission } from '../../src/app/shared/ipc';

afterEach(cleanup);

const item = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  jobId: 1,
  title: 'GRWM',
  source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
  videoId: '7SHNxjFuw10',
  status: 'done',
  rangeStartMs: 0,
  rangeEndMs: 557_000,
  createdAt: '2026-10-14T12:00:00.000Z',
  hasTranslation: true,
  hasSummary: true,
  isLocalFile: false,
  ...over,
});

const sub = (over: Partial<Submission> = {}): Submission => ({
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

describe('LibraryScreen', () => {
  it('shows an empty state with a New job button', () => {
    const onNew = vi.fn();
    render(<LibraryScreen items={[]} submissions={[]} onOpen={() => {}} onNew={onNew} />);
    fireEvent.click(screen.getByText('New job'));
    expect(onNew).toHaveBeenCalled();
  });

  it('lists jobs with title, range, and badges, and opens one on click', () => {
    const onOpen = vi.fn();
    render(<LibraryScreen items={[item(), item({ jobId: 2, title: null, source: 'C:/clips/a.wav', isLocalFile: true, hasTranslation: false, hasSummary: false })]} submissions={[]} onOpen={onOpen} onNew={() => {}} />);
    expect(screen.getByText('GRWM')).toBeTruthy();
    expect(screen.getAllByText('0:00:00 to 0:09:17')).toHaveLength(2);
    expect(screen.getAllByText('EN')).toHaveLength(1);
    expect(screen.getAllByText('Summary')).toHaveLength(1);
    expect(screen.getByText('C:/clips/a.wav')).toBeTruthy(); // falls back to the source when there is no title
    fireEvent.click(screen.getByText('GRWM'));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('shows queued and running submissions that have no job yet', () => {
    render(
      <LibraryScreen
        items={[]}
        submissions={[sub(), sub({ id: 2, state: 'running' }), sub({ id: 3, state: 'done', jobId: 9 })]}
        onOpen={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getAllByText('https://www.youtube.com/watch?v=QGWaK-UF5QU')).toHaveLength(2);
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
  });
});
