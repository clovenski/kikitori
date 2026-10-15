import { useState } from 'react';
import { useApi, useUpdateState } from '../lib/api';

/** Announces a new version and walks through download and restart; every step waits for the user. */
export function UpdateBanner() {
  const api = useApi();
  const state = useUpdateState();
  // "Later" hides what is showing now; a different message (a newer version, the finished download) shows again.
  const [hidden, setHidden] = useState<string | null>(null);
  if (state.phase === 'idle') return null;
  const key = state.phase === 'failed' ? `failed:${state.version}:${state.message}` : `${state.phase}:${state.version}`;
  if (state.phase !== 'downloading' && hidden === key) return null;
  const later = <button onClick={() => setHidden(key)}>Later</button>;

  return (
    <div className="notice update" role="status">
      {state.phase === 'available' && (
        <>
          <span>{`Kikitori ${state.version} is available.`}</span>
          <span className="inline">
            <button className="primary" onClick={() => void api.updates.download()}>
              Download
            </button>
            {later}
          </span>
        </>
      )}
      {state.phase === 'downloading' && <span>{`Downloading Kikitori ${state.version}... ${state.percent}%`}</span>}
      {state.phase === 'ready' && (
        <>
          <span>{`Kikitori ${state.version} is ready to install. The app restarts to finish.`}</span>
          <span className="inline">
            <button className="primary" onClick={() => void api.updates.install()}>
              Restart and update
            </button>
            {later}
          </span>
        </>
      )}
      {state.phase === 'failed' && (
        <>
          <span>{`Could not download Kikitori ${state.version}: ${state.message}`}</span>
          <span className="inline">
            <button className="primary" onClick={() => void api.updates.download()}>
              Try again
            </button>
            {later}
          </span>
        </>
      )}
    </div>
  );
}
