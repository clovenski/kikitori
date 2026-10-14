// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurrentTime, type TimeSource } from '../../src/app/renderer/lib/timesource';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Clock({ source }: { source: TimeSource | null }) {
  return <span data-testid="t">{useCurrentTime(source, 100)}</span>;
}

describe('useCurrentTime', () => {
  it('is 0 without a source', () => {
    render(<Clock source={null} />);
    expect(screen.getByTestId('t').textContent).toBe('0');
  });

  it('follows the source on every interval tick', () => {
    let now = 1000;
    const source: TimeSource = { getTimeMs: () => now, seek: () => {} };
    render(<Clock source={source} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId('t').textContent).toBe('1000');
    now = 2500;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId('t').textContent).toBe('2500');
  });

  it('stops polling when unmounted', () => {
    const getTimeMs = vi.fn(() => 5);
    const { unmount } = render(<Clock source={{ getTimeMs, seek: () => {} }} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const calls = getTimeMs.mock.calls.length;
    unmount();
    vi.advanceTimersByTime(1000);
    expect(getTimeMs.mock.calls.length).toBe(calls);
  });

  it('survives a source that throws (player not ready yet)', () => {
    const source: TimeSource = {
      getTimeMs: () => {
        throw new Error('not ready');
      },
      seek: () => {},
    };
    render(<Clock source={source} />);
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(300);
      }),
    ).not.toThrow();
    expect(screen.getByTestId('t').textContent).toBe('0');
  });
});
