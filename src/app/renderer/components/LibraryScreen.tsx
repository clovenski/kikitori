import type { LibraryItem, Submission } from '../../shared/ipc';
import { formatClock, jobStatusLabel, stateLabel } from '../lib/format';

interface Props {
  items: LibraryItem[];
  submissions: Submission[];
  onOpen(jobId: number): void;
  onNew(): void;
}

export function LibraryScreen({ items, submissions, onOpen, onNew }: Props) {
  const pending = submissions.filter((s) => s.jobId === null && (s.state === 'queued' || s.state === 'running'));
  if (items.length === 0 && pending.length === 0) {
    return (
      <div className="empty">
        <h2>No jobs yet</h2>
        <p>Paste a YouTube link or choose a recording to get English subtitles and a summary.</p>
        <button className="primary" onClick={onNew}>
          New job
        </button>
      </div>
    );
  }
  return (
    <ul className="library">
      {pending.map((s) => (
        <li key={`s${s.id}`} className="row pending">
          <div className="title">{s.source}</div>
          <div className="meta">
            <span className={`badge state-${s.state}`}>{stateLabel(s.state)}</span>
          </div>
        </li>
      ))}
      {items.map((item) => (
        <li key={item.jobId}>
          <button className="row" onClick={() => onOpen(item.jobId)}>
            <span className="title">{item.title ?? item.source}</span>
            <span className="meta">
              <span>{`${formatClock(item.rangeStartMs)} to ${formatClock(item.rangeEndMs)}`}</span>
              <span>{new Date(item.createdAt).toLocaleDateString()}</span>
              {item.status !== 'done' && <span className={`badge state-${item.status}`}>{jobStatusLabel(item.status)}</span>}
              {item.hasTranslation && <span className="badge">EN</span>}
              {item.hasSummary && <span className="badge">Summary</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
