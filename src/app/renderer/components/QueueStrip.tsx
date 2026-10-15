import type { ProgressEvent, Submission } from '../../shared/ipc';
import { progressPercent, stageLabel, stateLabel } from '../lib/format';

interface Props {
  submissions: Submission[];
  progress: Map<number, ProgressEvent>;
  onCancel(id: number): void;
  onResume(id: number): void;
  onUpdateYtDlp?(): void;
}

const RESUMABLE = new Set(['failed', 'interrupted', 'cancelled']);

export function QueueStrip({ submissions, progress, onCancel, onResume, onUpdateYtDlp }: Props) {
  const running = submissions.find((s) => s.state === 'running');
  const waiting = submissions.filter((s) => s.state === 'queued').length;
  const stopped = submissions.filter((s) => RESUMABLE.has(s.state)).slice(-3);
  if (!running && waiting === 0 && stopped.length === 0) return null;

  const event = running ? progress.get(running.id) : undefined;
  return (
    <footer className="queue">
      {running && (
        <div className="queue-running">
          <span className="queue-source">{running.source}</span>
          <span className="queue-stage">{event ? stageLabel(event.stage) : 'Starting'}</span>
          <progress max={100} value={event ? progressPercent(event) : undefined} />
          {event && <span className="queue-percent">{`${progressPercent(event)}%`}</span>}
          <button onClick={() => onCancel(running.id)}>Cancel</button>
        </div>
      )}
      {waiting > 0 && <div className="queue-waiting">{`${waiting} waiting`}</div>}
      {stopped.map((s) => (
        <div key={s.id} className="queue-stopped">
          <span className="queue-source">{s.source}</span>
          <span className={`badge state-${s.state}`}>{stateLabel(s.state)}</span>
          {s.error && <span className="queue-error">{s.error}</span>}
          {s.error?.startsWith('DownloadFailed') && onUpdateYtDlp && <button onClick={onUpdateYtDlp}>Update yt-dlp</button>}
          <button onClick={() => onResume(s.id)}>Resume</button>
        </div>
      ))}
    </footer>
  );
}
