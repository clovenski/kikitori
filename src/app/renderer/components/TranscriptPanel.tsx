import { memo, useCallback, useEffect, useRef } from 'react';
import type { TranscriptLine } from '../../shared/ipc';
import { formatClock } from '../lib/format';
import { subtitleText, type SubtitleMode } from '../lib/subtitles';

/** After the user scrolls, auto-follow waits this long so it does not drag them back. */
const PAUSE_FOLLOW_MS = 4_000;

interface RowProps {
  line: TranscriptLine;
  active: boolean;
  mode: SubtitleMode;
  onSeek(ms: number): void;
  follow(): boolean;
}

// memo: the active line changes about once a second, and only the two rows involved should re-render.
const Row = memo(function Row({ line, active, mode, onSeek, follow }: RowProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active && follow()) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, follow]);
  const [primary, secondary] = subtitleText(line, mode);
  return (
    <button ref={ref} className={`line${active ? ' active' : ''}`} onClick={() => onSeek(line.startMs)}>
      <span className="time">{formatClock(line.startMs)}</span>
      <span>
        <span>{primary}</span>
        {secondary && <div className="ja">{secondary}</div>}
      </span>
    </button>
  );
});

interface Props {
  lines: TranscriptLine[];
  activeIndex: number;
  mode: SubtitleMode;
  onSeek(ms: number): void;
}

export function TranscriptPanel({ lines, activeIndex, mode, onSeek }: Props) {
  const pausedUntil = useRef(0);
  const follow = useCallback(() => Date.now() >= pausedUntil.current, []);
  const pause = useCallback(() => {
    pausedUntil.current = Date.now() + PAUSE_FOLLOW_MS;
  }, []);

  if (lines.length === 0) return <div className="panel">No speech was transcribed for this job.</div>;
  return (
    <div className="panel" onWheel={pause} onTouchMove={pause} onKeyDown={pause}>
      {lines.map((line, i) => (
        <Row key={line.id} line={line} active={i === activeIndex} mode={mode} onSeek={onSeek} follow={follow} />
      ))}
    </div>
  );
}
