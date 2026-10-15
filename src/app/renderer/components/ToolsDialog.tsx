import { useEffect, useState } from 'react';
import { formatBytes } from '../../../core/bytes';
import type { OutputDirInfo, SetupState, Tier } from '../../shared/ipc';
import { useApi, useSetupProgress } from '../lib/api';
import { closeOnBackdrop, useEscapeToClose } from '../lib/dismiss';
import { InstallProgress } from './InstallProgress';

interface Props {
  state: SetupState;
  onClose(): void;
  /** Called after a download or repair finished, so the caller can reload the setup state. */
  onChanged(): void;
}

export function ToolsDialog({ state, onClose, onChanged }: Props) {
  const api = useApi();
  const progress = useSetupProgress();
  useEscapeToClose(onClose);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [output, setOutput] = useState<OutputDirInfo | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const busy = progress.phase === 'installing';
  const other: Tier = state.tier === 'gpu' ? 'cpu' : 'gpu';
  const visible = state.components.filter((c) => c.tier === 'all' || c.tier === state.tier);
  const bytesOf = (tier: Tier) => state.components.filter((c) => c.tier === tier).reduce((n, c) => n + c.sizeBytes, 0);
  const featuresMissing = !state.features.translation || !state.features.summaries;

  useEffect(() => {
    if (progress.phase === 'done') onChanged();
  }, [progress.phase, onChanged]);

  useEffect(() => {
    let current = true;
    void api.output.get().then((r) => {
      if (current && r.ok) setOutput(r.value);
    });
    return () => {
      current = false;
    };
  }, [api]);

  const changeOutput = async (call: () => Promise<{ ok: true; value: OutputDirInfo | null } | { ok: false; error: { message: string } }>) => {
    setOutputError(null);
    const r = await call();
    if (!r.ok) return setOutputError(r.error.message);
    if (r.value) setOutput(r.value); // null: the picker was cancelled
  };

  const run = async (call: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    setMessage(null);
    const r = await call();
    if (!r.ok) setMessage(r.error?.message ?? 'Something went wrong.');
  };

  const updateYtDlp = async () => {
    setMessage('Updating yt-dlp...');
    const r = await api.setup.updateYtDlp();
    setMessage(r.ok ? r.value : r.error.message);
  };

  const checkForUpdates = async () => {
    setMessage('Checking for updates...');
    const r = await api.updates.check();
    if (!r.ok) return setMessage(`Could not check for updates: ${r.error.message}`);
    const u = r.value;
    setMessage(
      u.phase === 'idle'
        ? 'Kikitori is up to date.'
        : u.phase === 'available'
          ? `Kikitori ${u.version} is available.`
          : u.phase === 'downloading'
            ? `Downloading Kikitori ${u.version}...`
            : u.phase === 'ready'
              ? `Kikitori ${u.version} is ready to install.`
              : `Could not download Kikitori ${u.version}.`,
    );
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={closeOnBackdrop(onClose)}>
      <div className="dialog" role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <div className="hint">{`${state.tier === 'gpu' ? 'NVIDIA GPU' : 'CPU only'} setup - installed in ${state.resourcesDir}`}</div>
        <ul className="tools-list">
          {visible.map((c) => (
            <li key={c.id}>
              <span>{c.title}</span>
              <span>{`${c.installed ? 'Installed' : 'Not installed'} (${formatBytes(c.sizeBytes)})`}</span>
            </li>
          ))}
        </ul>
        {progress.phase !== 'idle' && progress.phase !== 'done' && <InstallProgress progress={progress} />}
        {(progress.phase === 'failed' || progress.phase === 'cancelled') && (
          <div className={progress.phase === 'failed' ? 'error' : 'hint'}>{progress.message}</div>
        )}
        {message && <div className="hint">{message}</div>}
        {confirmSwitch ? (
          <div className="notice">
            <div>
              {`Switching removes the ${state.tier === 'gpu' ? 'GPU' : 'CPU'} programs and models (${formatBytes(bytesOf(state.tier))}) and downloads the ${other === 'gpu' ? 'GPU' : 'CPU'} ones (up to ${formatBytes(bytesOf(other))}). Your videos, transcripts and settings are kept.`}
            </div>
            <div className="actions">
              <button onClick={() => setConfirmSwitch(false)}>Keep current setup</button>
              <button
                className="primary"
                onClick={() => {
                  setConfirmSwitch(false);
                  void run(() => api.setup.start({ tier: other, features: state.features }));
                }}
              >
                Switch
              </button>
            </div>
          </div>
        ) : (
          <div className="inline">
            {featuresMissing && (
              <button disabled={busy} onClick={() => void run(() => api.setup.start({ tier: state.tier, features: { translation: true, summaries: true } }))}>
                Add translation and summaries
              </button>
            )}
            <button disabled={busy} onClick={() => void updateYtDlp()}>
              Update yt-dlp
            </button>
            <button disabled={busy} onClick={() => void run(() => api.setup.repair())}>
              Repair
            </button>
            <button disabled={busy} onClick={() => setConfirmSwitch(true)}>
              {`Switch to ${other === 'gpu' ? 'NVIDIA GPU' : 'CPU only'}`}
            </button>
            <button onClick={() => void checkForUpdates()}>Check for updates</button>
            <button onClick={() => void api.setup.openNotices()}>License notices</button>
          </div>
        )}
        {output && (
          <div className="output-dir">
            <div>Subtitles and summaries are saved in</div>
            <div className="path">{output.dir}</div>
            <div className="hint">
              {output.locked
                ? 'This folder is fixed by the KTR_OUTPUT_DIR environment variable.'
                : `${output.isDefault ? 'Default location' : 'Chosen folder'}. Applies to new jobs; files from earlier jobs stay where they were saved.`}
            </div>
            {outputError && <div className="error">{outputError}</div>}
            <div className="inline">
              <button disabled={output.locked} onClick={() => void changeOutput(() => api.output.choose())}>
                Change folder...
              </button>
              {!output.locked && !output.isDefault && <button onClick={() => void changeOutput(() => api.output.reset())}>Use default folder</button>}
            </div>
          </div>
        )}
        <div className="actions">
          {busy && <button onClick={() => void api.setup.cancel()}>Cancel download</button>}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
