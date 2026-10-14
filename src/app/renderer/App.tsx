import { useState } from 'react';
import { JobScreen } from './components/JobScreen';
import { LibraryScreen } from './components/LibraryScreen';
import { NewJobDialog } from './components/NewJobDialog';
import { QueueStrip } from './components/QueueStrip';
import { useApi, useLibrary, useProgress, useQueue } from './lib/api';

type Route = { name: 'library' } | { name: 'job'; jobId: number };

export function App() {
  const api = useApi();
  const submissions = useQueue();
  const progress = useProgress();
  const items = useLibrary(submissions);
  const [route, setRoute] = useState<Route>({ name: 'library' });
  const [newJobOpen, setNewJobOpen] = useState(false);

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
