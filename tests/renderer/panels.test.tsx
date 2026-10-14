// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SummaryPanel } from '../../src/app/renderer/components/SummaryPanel';
import { TranscriptPanel } from '../../src/app/renderer/components/TranscriptPanel';

afterEach(cleanup);

const lines = [
  { id: 1, startMs: 1000, endMs: 2000, ja: 'こんにちは', en: 'Hello' },
  { id: 2, startMs: 3_723_000, endMs: 3_724_000, ja: 'えっと', en: null },
];

describe('TranscriptPanel', () => {
  it('shows timestamps and text per mode, highlights the active line and seeks on click', () => {
    const onSeek = vi.fn();
    render(<TranscriptPanel lines={lines} activeIndex={0} mode="both" onSeek={onSeek} />);
    expect(screen.getByText('0:00:01')).toBeTruthy();
    expect(screen.getByText('1:02:03')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('こんにちは')).toBeTruthy();
    expect(document.querySelectorAll('.line.active')).toHaveLength(1);
    fireEvent.click(screen.getByText('Hello'));
    expect(onSeek).toHaveBeenCalledWith(1000);
  });

  it('shows Japanese only in ja mode and falls back to Japanese when English is missing', () => {
    render(<TranscriptPanel lines={lines} activeIndex={-1} mode="en" onSeek={() => {}} />);
    expect(screen.getByText('えっと')).toBeTruthy();
    expect(document.querySelectorAll('.line.active')).toHaveLength(0);
  });

  it('shows an empty-state message for a job with no speech', () => {
    render(<TranscriptPanel lines={[]} activeIndex={-1} mode="en" onSeek={() => {}} />);
    expect(screen.getByText(/No speech/)).toBeTruthy();
  });
});

describe('SummaryPanel', () => {
  const summaries = [
    { level: 'overview' as const, idx: 0, startMs: 0, endMs: 600_000, text: 'A cozy stream.' },
    { level: 'window' as const, idx: 0, startMs: 0, endMs: 300_000, text: '- [0:00:10] Intro\n- [0:03:24] Reviews makeup' },
  ];

  it('renders the overview and timeline with clickable timestamps that seek', () => {
    const onSeek = vi.fn();
    render(<SummaryPanel summaries={summaries} onSeek={onSeek} />);
    expect(screen.getByText('A cozy stream.')).toBeTruthy();
    fireEvent.click(screen.getByText('0:03:24'));
    expect(onSeek).toHaveBeenCalledWith(204_000);
  });

  it('shows a message when there is no summary', () => {
    render(<SummaryPanel summaries={[]} onSeek={() => {}} />);
    expect(screen.getByText(/No summary/)).toBeTruthy();
  });
});
