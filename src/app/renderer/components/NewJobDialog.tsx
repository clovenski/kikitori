import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { ProbeResult } from '../../shared/ipc';
import { unwrap, useApi } from '../lib/api';
import { formatClock, formatEta } from '../lib/format';
import { buildSubmitRequest, type NewJobForm } from '../lib/newjob';

interface Props {
  onClose(): void;
  onSubmitted(): void;
}

type ProbeState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; info: ProbeResult } | { kind: 'error'; message: string };

export function NewJobDialog({ onClose, onSubmitted }: Props) {
  const api = useApi();
  const [form, setForm] = useState<NewJobForm>({
    source: '',
    start: '',
    end: '',
    translate: true,
    summarize: true,
    skim: false,
    glossaryPath: null,
  });
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const [eta, setEta] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const probed = useRef('');

  const set = <K extends keyof NewJobForm>(key: K, value: NewJobForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const runProbe = useCallback(
    async (source: string) => {
      const trimmed = source.trim();
      if (trimmed === '' || probed.current === trimmed) return;
      probed.current = trimmed;
      setProbe({ kind: 'loading' });
      const r = await api.source.probe(trimmed);
      if (probed.current !== trimmed) return;
      setProbe(r.ok ? { kind: 'ok', info: r.value } : { kind: 'error', message: r.error.message });
    },
    [api],
  );

  // Recompute the estimate when the probe or the range changes.
  useEffect(() => {
    if (probe.kind !== 'ok') {
      setEta(undefined);
      return;
    }
    let alive = true;
    const built = buildSubmitRequest(form, probe.info.durationMs);
    const startMs = built.ok ? built.request.startMs : 0;
    const endMs = built.ok ? built.request.endMs : null;
    void api.source.estimate({ durationMs: probe.info.durationMs, startMs, endMs }).then((r) => {
      if (alive && r.ok) setEta(r.value);
    });
    return () => {
      alive = false;
    };
  }, [api, probe, form]);

  const chooseFile = async () => {
    const path = unwrap(await api.dialog.pickMedia());
    if (path) {
      set('source', path);
      await runProbe(path);
    }
  };

  const chooseGlossary = async () => {
    const path = unwrap(await api.dialog.pickGlossary());
    if (path) set('glossaryPath', path);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const path = api.dialog.pathForFile(file);
    set('source', path);
    await runProbe(path);
  };

  const submit = async () => {
    const durationMs = probe.kind === 'ok' ? probe.info.durationMs : null;
    const built = buildSubmitRequest(form, durationMs);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await api.queue.submit(built.request);
    setBusy(false);
    if (r.ok) onSubmitted();
    else setError(r.error.message);
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-label="New job">
        <h2>New job</h2>
        <label>
          YouTube link or file path
          <input
            type="text"
            value={form.source}
            placeholder="https://www.youtube.com/watch?v=..."
            onChange={(e) => {
              set('source', e.target.value);
              setError(null);
            }}
            onBlur={(e) => void runProbe(e.target.value)}
          />
        </label>
        <div
          className={`dropzone${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => void onDrop(e)}
        >
          Drop a file here or <button onClick={() => void chooseFile()}>Choose file</button>
        </div>
        {probe.kind === 'loading' && <div className="hint">Reading the video...</div>}
        {probe.kind === 'error' && <div className="error">{probe.message}</div>}
        {probe.kind === 'ok' && (
          <div>
            <strong>{probe.info.title ?? 'Untitled'}</strong>
            <div className="hint">{`Length ${formatClock(probe.info.durationMs)}${eta !== undefined ? ` - estimated time: ${formatEta(eta)}` : ''}`}</div>
          </div>
        )}
        <div className="inline">
          <label>
            Start (optional)
            <input type="text" value={form.start} placeholder="1:20:00" onChange={(e) => set('start', e.target.value)} />
          </label>
          <label>
            End (optional)
            <input type="text" value={form.end} placeholder="1:50:00" onChange={(e) => set('end', e.target.value)} />
          </label>
        </div>
        <div className="inline">
          <label className="inline">
            <input type="checkbox" checked={form.translate} onChange={(e) => set('translate', e.target.checked)} /> Translate
          </label>
          <label className="inline">
            <input type="checkbox" checked={form.summarize} onChange={(e) => set('summarize', e.target.checked)} /> Summarize
          </label>
          <label className="inline">
            <input type="checkbox" checked={form.skim} onChange={(e) => set('skim', e.target.checked)} /> Skim (summary only)
          </label>
        </div>
        <div className="inline">
          <button onClick={() => void chooseGlossary()}>Glossary file...</button>
          <span className="hint">{form.glossaryPath ?? 'none'}</span>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            Add to queue
          </button>
        </div>
      </div>
    </div>
  );
}
