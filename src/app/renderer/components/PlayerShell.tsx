import { useEffect, useState } from 'react';
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
  // The Fullscreen API is not used: Electron asks the permission handler for it and we deny every permission.
  // Filling the app window keeps the overlay visible and leaves true fullscreen to the window's own maximize.
  const [expanded, setExpanded] = useState(false);
  const active = findActiveIndex(lines, timeMs);
  const text = active >= 0 ? subtitleText(lines[active], mode) : [];

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <div>
      <div className={expanded ? 'player expanded' : 'player'} data-testid="player-container" style={{ ['--sub-size' as string]: SIZES[size] }}>
        {children}
        {expanded && (
          <button className="exit-expanded" onClick={() => setExpanded(false)}>
            Exit (Esc)
          </button>
        )}
        <div className="overlay" aria-live="off">
          {text.map((t, i) => (
            <div key={i}>
              <span>{t}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="toolbar">
        <button onClick={() => setExpanded(true)}>Fill window</button>
      </div>
    </div>
  );
}
