import { useEffect, useState } from 'react';
import { formatBytes } from '../../../core/bytes';
import type { SetupPlanView } from '../../shared/ipc';
import { useApi, useSetupProgress } from '../lib/api';
import { InstallProgress } from './InstallProgress';

interface Props {
  plan: SetupPlanView;
  onDone(): void;
  onCancel(): void;
}

/** Asks before downloading the parts a job needs that were skipped at setup, then shows the download. */
export function SetupDownloadDialog({ plan, onDone, onCancel }: Props) {
  const api = useApi();
  const progress = useSetupProgress();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = plan.components.filter((c) => !c.installed);
  const running = started && progress.phase === 'installing';
  const failed = started && progress.phase === 'failed';

  useEffect(() => {
    if (started && progress.phase === 'done') onDone();
  }, [started, progress.phase, onDone]);

  const start = async () => {
    setError(null);
    setStarted(true);
    const r = await api.setup.start(plan.selection);
    if (!r.ok) {
      setError(r.error.message);
      setStarted(false);
    }
  };

  const close = async () => {
    if (running) await api.setup.cancel();
    onCancel();
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-label="Download needed">
        <h2>Download needed</h2>
        <div>This needs parts that are not installed yet:</div>
        <ul className="install-list">
          {missing.map((c) => (
            <li key={c.id}>
              <span>{c.title}</span>
              <span>{formatBytes(c.sizeBytes)}</span>
            </li>
          ))}
        </ul>
        <div className="hint">{`Total: ${formatBytes(plan.missingBytes)} - free disk space: ${formatBytes(plan.freeDiskBytes)}`}</div>
        {started && <InstallProgress components={missing} progress={progress} />}
        {failed && <div className="error">{progress.message}</div>}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button onClick={() => void close()}>Not now</button>
          <button className="primary" disabled={running} onClick={() => void start()}>
            {failed ? 'Try again' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  );
}
