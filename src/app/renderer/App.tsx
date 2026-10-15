import { useEffect, useState } from 'react';
import { JobScreen } from './components/JobScreen';
import { LibraryScreen } from './components/LibraryScreen';
import { NewJobDialog } from './components/NewJobDialog';
import { QueueStrip } from './components/QueueStrip';
import { Wizard } from './components/Wizard';
import { useApi, useLibrary, useProgress, useQueue, useSetupState } from './lib/api';

type Route = { name: 'library' } | { name: 'job'; jobId: number };

export function App() {
  const api = useApi();
  const submissions = useQueue();
  const progress = useProgress();
  const items = useLibrary(submissions);
  const { state, refresh } = useSetupState();
  const [route, setRoute] = useState<Route>({ name: 'library' });
  const [newJobOpen, setNewJobOpen] = useState(false);
  // Decided once, when the setup state first arrives: finishing the wizard must not pull it away before the user clicks on.
  const [wizard, setWizard] = useState<boolean | null>(null);
  useEffect(() => {
    if (state && wizard === null) setWizard(state.needsWizard);
  }, [state, wizard]);

  if (wizard === null) return <div className="app" />;
  if (wizard) {
    return (
      <Wizard
        onFinished={() => {
          setWizard(false);
          refresh();
          setNewJobOpen(true);
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setRoute({ name: 'library' })}>
          BG Auto Translator
        </button>
        <button className="primary" onClick={() => setNewJobOpen(true)}>
          New job
        </button>
      </header>
      <main className="content">
        {route.name === 'library' ? (
          <LibraryScreen items={items} submissions={submissions} onOpen={(jobId) => setRoute({ name: 'job', jobId })} onNew={() => setNewJobOpen(true)} />
        ) : (
          <JobScreen jobId={route.jobId} onBack={() => setRoute({ name: 'library' })} />
        )}
      </main>
      <QueueStrip
        submissions={submissions}
        progress={progress}
        onCancel={(id) => void api.queue.cancel(id)}
        onResume={(id) => void api.queue.resume(id)}
      />
      {newJobOpen && (
        <NewJobDialog
          onClose={() => setNewJobOpen(false)}
          onSubmitted={() => {
            setNewJobOpen(false);
            setRoute({ name: 'library' });
          }}
        />
      )}
    </div>
  );
}
