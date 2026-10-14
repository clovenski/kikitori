import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { TranscriptLine } from '../../shared/ipc';
import { findActiveIndex, subtitleText, type SubtitleMode } from '../lib/subtitles';

export type SubtitleSize = 'small' | 'medium' | 'large';
const SIZES: Record<SubtitleSize, string> = { small: '16px', medium: '22px', large: '30px' };

interface Props {
  lines: TranscriptLine[];
  mode: SubtitleMode;
  size: SubtitleSize;
  timeMs: number;
  children: ReactNode;
}

export function PlayerShell({ lines, mode, size, timeMs, children }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const active = findActiveIndex(lines, timeMs);
  const text = active >= 0 ? subtitleText(lines[active], mode) : [];

  const toggleFullscreen = () => {
    const el = container.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  return (
    <div>
      <div ref={container} className="player" data-testid="player-container" style={{ ['--sub-size' as string]: SIZES[size] }}>
        {children}
        <div className="overlay" aria-live="off">
          {text.map((t, i) => (
            <div key={i}>
              <span>{t}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="toolbar">
        <button onClick={toggleFullscreen}>Fullscreen</button>
      </div>
    </div>
  );
}
