import type { ReactNode } from 'react';
import type { SummaryRow } from '../../shared/ipc';
import { formatClock } from '../lib/format';
import { splitTimestamps } from '../lib/summary';

interface Props {
  summaries: SummaryRow[];
  onSeek(ms: number): void;
}

function Linked({ text, onSeek }: { text: string; onSeek(ms: number): void }): ReactNode {
  return splitTimestamps(text).map((part, i) =>
    'ts' in part ? (
      <button key={i} className="ts" onClick={() => onSeek(part.ms)}>
        {part.ts}
      </button>
    ) : (
      <span key={i}>{part.text}</span>
    ),
  );
}

function Block({ row, onSeek }: { row: SummaryRow; onSeek(ms: number): void }) {
  return (
    <section>
      <h3>{`${formatClock(row.startMs)} to ${formatClock(row.endMs)}`}</h3>
      {row.text.split('\n').map((line, i) => (
        <p key={i}>
          <Linked text={line} onSeek={onSeek} />
        </p>
      ))}
    </section>
  );
}

export function SummaryPanel({ summaries, onSeek }: Props) {
  if (summaries.length === 0) return <div className="panel">No summary for this job. Run it with Summarize or Skim.</div>;
  const of = (level: SummaryRow['level']) => summaries.filter((s) => s.level === level);
  const overview = of('overview')[0];
  return (
    <div className="panel summary">
      {overview && (
        <section>
          <h3>Overview</h3>
          <p>{overview.text}</p>
        </section>
      )}
      {of('section').length > 0 && <h3>Sections</h3>}
      {of('section').map((row) => (
        <Block key={`s${row.idx}`} row={row} onSeek={onSeek} />
      ))}
      {of('window').length > 0 && <h3>Timeline</h3>}
      {of('window').map((row) => (
        <Block key={`w${row.idx}`} row={row} onSeek={onSeek} />
      ))}
    </div>
  );
}
