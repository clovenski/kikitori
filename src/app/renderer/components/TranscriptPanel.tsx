import { useEffect, useRef } from 'react';
import type { TranscriptLine } from '../../shared/ipc';
import { formatClock } from '../lib/format';
import { subtitleText, type SubtitleMode } from '../lib/subtitles';

interface Props {
  lines: TranscriptLine[];
  activeIndex: number;
  mode: SubtitleMode;
  onSeek(ms: number): void;
}

export function TranscriptPanel({ lines, activeIndex, mode, onSeek }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  if (lines.length === 0) return <div className="panel">No speech was transcribed for this job.</div>;
  return (
    <div className="panel">
      {lines.map((line, i) => {
        const [primary, secondary] = subtitleText(line, mode);
        return (
          <button
            key={line.id}
            ref={i === activeIndex ? activeRef : undefined}
            className={`line${i === activeIndex ? ' active' : ''}`}
            onClick={() => onSeek(line.startMs)}
          >
            <span className="time">{formatClock(line.startMs)}</span>
            <span>
              <span>{primary}</span>
              {secondary && <div className="ja">{secondary}</div>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
