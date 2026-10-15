import { useEffect, useState } from 'react';
import { ChannelsScreen } from './components/ChannelsScreen';
import { JobScreen } from './components/JobScreen';
import { LibraryScreen } from './components/LibraryScreen';
import { NewJobDialog } from './components/NewJobDialog';
import { QueueStrip } from './components/QueueStrip';
import { UpdateBanner } from './components/UpdateBanner';
import { ToolsDialog } from './components/ToolsDialog';
import { Wizard } from './components/Wizard';
import { useApi, useChannels, useLibrary, useProgress, useQueue, useSetupState } from './lib/api';

type Route = { name: 'library' } | { name: 'job'; jobId: number } | { name: 'channels' };

export function App() {
  const api = useApi();
  const submissions = useQueue();
  const progress = useProgress();
  const items = useLibrary(submissions);
  const { channels, feed, reload } = useChannels(submissions);
  const { state, refresh } = useSetupState();
  const [route, setRoute] = useState<Route>({ name: 'library' });
  const [newJobOpen, setNewJobOpen] = useState(false);
  const [newJobSource, setNewJobSource] = useState<string | undefined>(undefined);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const openNewJob = (source?: string) => {
    setNewJobSource(source);
    setNewJobOpen(true);
  };
  const updateYtDlp = async () => {
    setNote('Updating yt-dlp...');
    const r = await api.setup.updateYtDlp();
    setNote(r.ok ? r.value : r.error.message);
  };
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
          openNewJob();
        }}
      />
    );
  }

  const newVideos = feed.filter((f) => f.job === null && !f.queued).length;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setRoute({ name: 'library' })}>
          Kikitori
        </button>
        <div className="inline">
          <button onClick={() => setRoute({ name: 'channels' })}>
            Channels
            {newVideos > 0 && <span className="count">{newVideos}</span>}
          </button>
          <button onClick={() => setToolsOpen(true)}>Tools</button>
          <button className="primary" onClick={() => openNewJob()}>
            New job
          </button>
        </div>
      </header>
      <main className="content">
        <UpdateBanner />
        {note && (
          <div className="notice" role="status">
            {note} <button onClick={() => setNote(null)}>Dismiss</button>
          </div>
        )}
        {route.name === 'library' && (
          <LibraryScreen items={items} submissions={submissions} onOpen={(jobId) => setRoute({ name: 'job', jobId })} onNew={() => openNewJob()} />
        )}
        {route.name === 'job' && <JobScreen jobId={route.jobId} onBack={() => setRoute({ name: 'library' })} />}
        {route.name === 'channels' && (
          <ChannelsScreen
            channels={channels}
            feed={feed}
            onReload={reload}
            onProcess={(videoId) => openNewJob(`https://www.youtube.com/watch?v=${videoId}`)}
            onOpenJob={(jobId) => setRoute({ name: 'job', jobId })}
          />
        )}
      </main>
      <QueueStrip
        submissions={submissions}
        progress={progress}
        onCancel={(id) => void api.queue.cancel(id)}
        onResume={(id) => void api.queue.resume(id)}
        onUpdateYtDlp={() => void updateYtDlp()}
      />
      {newJobOpen && (
        <NewJobDialog
          key={newJobSource ?? 'blank'}
          initialSource={newJobSource}
          onClose={() => setNewJobOpen(false)}
          onSubmitted={() => {
            setNewJobOpen(false);
            setRoute({ name: 'library' });
          }}
        />
      )}
      {toolsOpen && state && <ToolsDialog state={state} onClose={() => setToolsOpen(false)} onChanged={refresh} />}
    </div>
  );
}
