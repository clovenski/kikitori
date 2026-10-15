import { useEffect, useState } from 'react';
import { formatBytes } from '../../../core/bytes';
import type { HardwareReport, SetupPlanView, SetupState, Tier } from '../../shared/ipc';
import { useApi, useSetupProgress } from '../lib/api';
import { InstallProgress } from './InstallProgress';

type Step = 'welcome' | 'choose' | 'installing' | 'done';

interface Props {
  onFinished(): void;
}

export function Wizard({ onFinished }: Props) {
  const api = useApi();
  const progress = useSetupProgress();
  const [step, setStep] = useState<Step>('welcome');
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  // The saved setup, when there is one: a wizard shown again must not silently change it.
  const [saved, setSaved] = useState<SetupState | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [tier, setTier] = useState<Tier>('gpu');
  const [translation, setTranslation] = useState(true);
  const [summaries, setSummaries] = useState(true);
  const [plan, setPlan] = useState<SetupPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== 'choose' || hardware) return;
    let alive = true;
    void Promise.all([api.setup.detect(), api.setup.state()]).then(([hw, st]) => {
      if (!alive) return;
      const keep = st.ok && st.value.completed ? st.value : null;
      if (hw.ok) {
        setHardware(hw.value);
        setTier(keep ? keep.tier : hw.value.recommendedTier);
      } else {
        setError(hw.error.message);
      }
      if (st.ok) setSaved(st.value);
      if (keep) {
        setTranslation(keep.features.translation);
        setSummaries(keep.features.summaries);
      }
    });
    return () => {
      alive = false;
    };
  }, [api, step, hardware]);

  useEffect(() => {
    if (step !== 'choose' || !hardware) return;
    let alive = true;
    void api.setup.plan({ tier, features: { translation, summaries } }).then((r) => {
      if (!alive) return;
      if (r.ok) setPlan(r.value);
      else setError(r.error.message);
    });
    return () => {
      alive = false;
    };
  }, [api, step, hardware, tier, translation, summaries]);

  useEffect(() => {
    if (step === 'installing' && progress.phase === 'done') setStep('done');
  }, [step, progress.phase]);

  const size = (id: string) => formatBytes(saved?.components.find((c) => c.id === id)?.sizeBytes ?? 0);
  const switching = saved?.completed === true && saved.tier !== tier;
  const selection = { tier, features: { translation, summaries } };

  const start = async () => {
    setError(null);
    setStep('installing');
    const r = await api.setup.start(selection);
    if (!r.ok) {
      setError(r.error.message);
      setStep('choose');
    }
  };

  if (step === 'welcome') {
    return (
      <div className="wizard">
        <h1>Welcome to BG Auto Translator</h1>
        <div className="card">
          <p>It turns Japanese videos into English subtitles and summaries, entirely on this computer. Nothing you process is sent anywhere.</p>
          <p>
            To do that it downloads open-source tools and AI models from their publishers. They are not part of this app and keep their own licences.
            This app is for your personal use; respect YouTube's terms and the rights of the people who made the videos.
          </p>
          <button onClick={() => void api.setup.openNotices()}>Licence notices</button>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => setStep('choose')}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (step === 'choose' && confirmSwitch && saved) {
    const from = saved.tier === 'gpu' ? 'GPU' : 'CPU';
    return (
      <div className="wizard">
        <h1>Switch hardware path?</h1>
        <div className="card">
          {`Switching removes the ${from} programs and models and downloads the ${tier === 'gpu' ? 'GPU' : 'CPU'} ones instead. Your videos, transcripts and settings are kept.`}
        </div>
        <div className="actions">
          <button
            onClick={() => {
              setConfirmSwitch(false);
              setTier(saved.tier);
            }}
          >
            Keep current setup
          </button>
          <button
            className="primary"
            onClick={() => {
              setConfirmSwitch(false);
              void start();
            }}
          >
            Switch
          </button>
        </div>
      </div>
    );
  }

  if (step === 'choose') {
    const tooSmall = plan !== null && plan.freeDiskBytes < plan.requiredFreeBytes;
    return (
      <div className="wizard">
        <h1>Choose what to install</h1>
        {!hardware && !error && <div className="hint">Looking at your computer...</div>}
        {hardware && (
          <div className="card">
            <strong>Your computer</strong>
            <div>{hardware.reason}</div>
            <label className="choice">
              <input type="radio" name="tier" checked={tier === 'gpu'} onChange={() => setTier('gpu')} />
              NVIDIA GPU (fast)
            </label>
            <label className="choice">
              <input type="radio" name="tier" checked={tier === 'cpu'} onChange={() => setTier('cpu')} />
              CPU only (slower)
            </label>
            {tier === 'cpu' && (
              <div className="warn">
                On the CPU path, transcription is slower than real time, so long videos take a while. Translation and summaries are slower too.
              </div>
            )}
          </div>
        )}
        {hardware && (
          <div className="card">
            <strong>Features</strong>
            <label className="choice">
              <input type="checkbox" checked={translation} onChange={(e) => setTranslation(e.target.checked)} />
              {`Translation (${size(`model-translate-${tier}`)} model)`}
            </label>
            <label className="choice">
              <input type="checkbox" checked={summaries} onChange={(e) => setSummaries(e.target.checked)} />
              {`Summaries (${size(`model-general-${tier}`)} model)`}
            </label>
            <div className="hint">Speech recognition is always installed. Anything you skip is downloaded when you first need it.</div>
          </div>
        )}
        {plan && (
          <div className="card">
            <div>{`Download size: ${formatBytes(plan.missingBytes)}`}</div>
            <div>{`Free disk space: ${formatBytes(plan.freeDiskBytes)}`}</div>
            {tooSmall && <div className="error">Not enough free disk space for this selection.</div>}
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button onClick={() => setStep('welcome')}>Back</button>
          <button className="primary" disabled={!plan || tooSmall} onClick={() => (switching ? setConfirmSwitch(true) : void start())}>
            {plan && plan.missingBytes === 0 ? 'Finish setup' : 'Download and install'}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'installing') {
    return (
      <div className="wizard">
        <h1>Installing</h1>
        <div className="card">
          <InstallProgress components={plan?.components} progress={progress} />
          {progress.phase === 'failed' && <div className="error">{progress.message}</div>}
          {progress.phase === 'cancelled' && <div className="hint">{progress.message}</div>}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="actions">
          {progress.phase === 'failed' && (
            <>
              <button onClick={() => setStep('choose')}>Back</button>
              <button className="primary" onClick={() => void start()}>
                Try again
              </button>
            </>
          )}
          {progress.phase === 'cancelled' && (
            <button className="primary" onClick={() => void start()}>
              Continue download
            </button>
          )}
          {progress.phase !== 'failed' && progress.phase !== 'cancelled' && (
            <button onClick={() => void api.setup.cancel()}>Cancel</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="wizard">
      <h1>All set</h1>
      <div className="card">Everything is installed. Paste a YouTube link or choose a file to get your first transcript.</div>
      <div className="actions">
        <button className="primary" onClick={onFinished}>
          Add your first video
        </button>
      </div>
    </div>
  );
}
