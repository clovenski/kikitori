import { useState } from 'react';
import type { LibraryItem, Submission } from '../../shared/ipc';
import { formatClock, jobStatusLabel, stateLabel } from '../lib/format';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';

interface Props {
  items: LibraryItem[];
  submissions: Submission[];
  onOpen(jobId: number): void;
  onNew(): void;
  onDelete(jobId: number): void;
}

export function LibraryScreen({ items, submissions, onOpen, onNew, onDelete }: Props) {
  const [confirming, setConfirming] = useState<LibraryItem | null>(null);
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
        <li key={item.jobId} className="library-item">
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
          <button
            className="icon-danger"
            aria-label={`Delete ${item.title ?? item.source}`}
            title="Delete"
            onClick={() => setConfirming(item)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9.5h6.8L12 4M6.5 6.5v5M9.5 6.5v5" />
            </svg>
          </button>
        </li>
      ))}
      {confirming && (
        <ConfirmDeleteDialog
          title={confirming.title ?? confirming.source}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            onDelete(confirming.jobId);
            setConfirming(null);
          }}
        />
      )}
    </ul>
  );
}
