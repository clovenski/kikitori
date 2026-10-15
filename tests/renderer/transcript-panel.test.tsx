// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptPanel } from '../../src/app/renderer/components/TranscriptPanel';
import * as format from '../../src/app/renderer/lib/format';

vi.mock('../../src/app/renderer/lib/format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/renderer/lib/format')>();
  return { ...actual, formatClock: vi.fn(actual.formatClock) };
});

const lines = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1,
  startMs: i * 2000,
  endMs: i * 2000 + 1500,
  ja: 'ja' + i,
  en: 'en' + i,
}));

const scrollIntoView = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  scrollIntoView.mockClear();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
  vi.mocked(format.formatClock).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const panel = (active: number, onSeek = () => {}) => (
  <TranscriptPanel lines={lines} activeIndex={active} mode="en" onSeek={onSeek} />
);

describe('TranscriptPanel rendering cost', () => {
  it('re-renders only the rows whose active state changed, not every line', () => {
    const onSeek = () => {};
    const { rerender } = render(panel(0, onSeek));
    expect(vi.mocked(format.formatClock)).toHaveBeenCalledTimes(60);
    vi.mocked(format.formatClock).mockClear();
    rerender(panel(1, onSeek));
    expect(vi.mocked(format.formatClock).mock.calls.length).toBeLessThanOrEqual(2); // the old and the new active row
    vi.mocked(format.formatClock).mockClear();
    rerender(panel(1, onSeek)); // same props again
    expect(vi.mocked(format.formatClock)).not.toHaveBeenCalled();
  });
});

describe('TranscriptPanel following playback', () => {
  it('scrolls the active line into view as playback advances', () => {
    const { rerender } = render(panel(0));
    scrollIntoView.mockClear();
    rerender(panel(1));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('stops pulling the user back for 4 seconds after they scroll, then follows again', () => {
    const { rerender, container } = render(panel(0));
    const scroller = container.querySelector('.panel') as HTMLElement;
    fireEvent.wheel(scroller);
    scrollIntoView.mockClear();
    rerender(panel(1));
    rerender(panel(2));
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(4_100);
    });
    rerender(panel(3));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('also pauses following for touch and keyboard scrolling', () => {
    const { rerender, container } = render(panel(0));
    const scroller = container.querySelector('.panel') as HTMLElement;
    fireEvent.touchMove(scroller);
    scrollIntoView.mockClear();
    rerender(panel(1));
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(4_100);
    });
    fireEvent.keyDown(scroller, { key: 'PageDown' });
    rerender(panel(2));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('seeks when a line is clicked', () => {
    const onSeek = vi.fn();
    const { container } = render(panel(0, onSeek));
    fireEvent.click(container.querySelectorAll('.line')[5]);
    expect(onSeek).toHaveBeenCalledWith(10_000);
  });
});
