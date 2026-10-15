import { formatBytes } from '../../../core/bytes';
import type { SetupComponentInfo, SetupProgress } from '../../shared/ipc';
import { formatRemaining } from '../lib/format';

interface Props {
  /** The components being installed; installed ones are not listed. Omit to show only the overall progress. */
  components?: SetupComponentInfo[];
  progress: SetupProgress;
}

export function InstallProgress({ components, progress }: Props) {
  const p = progress.progress;
  const pending = (components ?? []).filter((c) => !c.installed);
  const current = p ? pending.findIndex((c) => c.id === p.componentId) : -1;
  return (
    <div className="install">
      {p ? (
        <>
          <progress aria-label="Overall progress" max={p.overallTotal} value={p.overallReceived} />
          <div>{`${formatBytes(p.overallReceived)} of ${formatBytes(p.overallTotal)} - ${formatBytes(p.bytesPerSecond)}/s - time remaining: ${formatRemaining(p.etaSeconds)}`}</div>
          {components === undefined && <div className="hint">{`Downloading ${p.componentTitle}`}</div>}
        </>
      ) : (
        (progress.phase === 'installing' || progress.phase === 'idle') && <div>{progress.message ?? 'Starting...'}</div>
      )}
      {pending.length > 0 && (
        <ul className="install-list">
          {pending.map((c, i) => {
            const state = i < current ? 'Done' : i === current ? 'Downloading' : 'Waiting';
            return (
              <li key={c.id}>
                <span>{c.title}</span>
                <span className={state === 'Done' ? 'state-done' : undefined}>{`${state} (${formatBytes(c.sizeBytes)})`}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
