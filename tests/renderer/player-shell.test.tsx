// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerShell } from '../../src/app/renderer/components/PlayerShell';

afterEach(cleanup);

const lines = [
  { id: 1, startMs: 1000, endMs: 2000, ja: 'こんにちは', en: 'Hello' },
  { id: 2, startMs: 3000, endMs: 4000, ja: 'えっと', en: null },
];

describe('PlayerShell', () => {
  it('shows nothing when no line is active', () => {
    render(<PlayerShell lines={lines} mode="both" size="medium" timeMs={2500}><div>player</div></PlayerShell>);
    expect(screen.queryByText('Hello')).toBeNull();
    expect(screen.getByText('player')).toBeTruthy();
  });

  it('shows the active line in English, Japanese or both, with the English fallback', () => {
    const { rerender } = render(<PlayerShell lines={lines} mode="en" size="medium" timeMs={1500}><div /></PlayerShell>);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByText('こんにちは')).toBeNull();
    rerender(<PlayerShell lines={lines} mode="both" size="medium" timeMs={1500}><div /></PlayerShell>);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('こんにちは')).toBeTruthy();
    rerender(<PlayerShell lines={lines} mode="en" size="medium" timeMs={3500}><div /></PlayerShell>);
    expect(screen.getByText('えっと')).toBeTruthy(); // no translation: falls back to Japanese
  });

  it('fills the app window instead of using the Fullscreen API, which Electron denies', () => {
    const request = vi.fn();
    render(<PlayerShell lines={lines} mode="en" size="medium" timeMs={1500}><div /></PlayerShell>);
    const container = screen.getByTestId('player-container');
    container.requestFullscreen = request;
    expect(container.classList.contains('expanded')).toBe(false);
    fireEvent.click(screen.getByText('Fill window'));
    expect(container.classList.contains('expanded')).toBe(true);
    expect(screen.getByText('Hello')).toBeTruthy(); // the overlay is inside the expanded container
    expect(request).not.toHaveBeenCalled();
  });

  it('leaves the expanded view with the exit button or Escape', () => {
    render(<PlayerShell lines={lines} mode="en" size="medium" timeMs={0}><div /></PlayerShell>);
    const container = screen.getByTestId('player-container');
    fireEvent.click(screen.getByText('Fill window'));
    fireEvent.click(screen.getByText('Exit (Esc)'));
    expect(container.classList.contains('expanded')).toBe(false);
    fireEvent.click(screen.getByText('Fill window'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.classList.contains('expanded')).toBe(false);
  });

  it('applies the chosen subtitle size', () => {
    render(<PlayerShell lines={lines} mode="en" size="large" timeMs={1500}><div /></PlayerShell>);
    expect(screen.getByTestId('player-container').style.getPropertyValue('--sub-size')).toBe('30px');
  });
});
