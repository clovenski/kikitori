import { useState, type FormEvent } from 'react';
import type { ChannelInfo, FeedItem } from '../../shared/ipc';
import { useApi } from '../lib/api';
import { formatClock, jobStatusLabel, timeAgo } from '../lib/format';

interface Props {
  channels: ChannelInfo[];
  feed: FeedItem[];
  onReload(): void;
  onProcess(videoId: string): void;
  onOpenJob(jobId: number): void;
}

export function ChannelsScreen({ channels, feed, onReload, onProcess, onOpenJob }: Props) {
  const api = useApi();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

  const follow = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() === '') return;
    setAdding(true);
    setError(null);
    const r = await api.channels.add(text);
    setAdding(false);
    if (r.ok) {
      setText('');
      onReload();
    } else {
      setError(r.error.message);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await api.channels.refresh();
    setRefreshing(false);
    onReload();
  };

  const remove = async (id: number) => {
    setConfirmRemove(null);
    await api.channels.remove(id);
    onReload();
  };

  const dismiss = async (videoId: string) => {
    await api.channels.dismiss(videoId);
    onReload();
  };

  const dismissAll = async () => {
    await api.channels.dismissAll();
    onReload();
  };

  return (
    <div className="channels">
      <h2>Channels</h2>
      <form className="add" onSubmit={(e) => void follow(e)}>
        <input
          type="text"
          aria-label="Channel link or @handle"
          placeholder="@handle or https://www.youtube.com/@..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={adding}
        />
        <button className="primary" type="submit" disabled={adding}>
          {adding && <span className="spinner" aria-hidden="true" />}
          {adding ? 'Following...' : 'Follow'}
        </button>
      </form>
      {adding && (
        <p className="hint" role="status">
          Fetching the channel and its latest videos. This can take a few seconds.
        </p>
      )}
      {error && <div className="error">{error}</div>}

      {channels.length === 0 ? (
        <p className="hint">Follow a channel to see its new videos and finished streams here. Kikitori checks while it is open.</p>
      ) : (
        <ul className="channel-list">
          {channels.map((c) => (
            <li key={c.id} className="channel-row">
              <div>
                <div className="title">{c.title}</div>
                <div className="sub">
                  {c.handle ? `${c.handle} - ` : ''}
                  {c.lastCheckedAt ? `Checked ${timeAgo(c.lastCheckedAt)}` : 'Not checked yet'}
                </div>
                {c.lastError && <div className="error">{c.lastError}</div>}
              </div>
              {confirmRemove === c.id ? (
                <div className="inline">
                  <span>{`Remove ${c.title} and its videos from the feed?`}</span>
                  <button className="danger" onClick={() => void remove(c.id)}>
                    Yes, remove
                  </button>
                  <button onClick={() => setConfirmRemove(null)}>Cancel</button>
                </div>
              ) : (
                <button className="danger-outline" onClick={() => setConfirmRemove(c.id)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="toolbar">
        <h3>New videos</h3>
        <button disabled={refreshing || channels.length === 0} onClick={() => void refresh()}>
          {refreshing && <span className="spinner" aria-hidden="true" />}
          {refreshing ? 'Checking...' : 'Refresh'}
        </button>
        <button disabled={feed.length === 0} onClick={() => void dismissAll()}>
          Dismiss all
        </button>
      </div>
      <p className="hint">Need an older or one-off video? Paste its link into New job.</p>
      {channels.length > 0 && feed.length === 0 && <p className="hint">No new videos right now.</p>}
      <ul className="feed">
        {feed.map((f) => (
          <li key={f.videoId} className="feed-item">
            <img src={`https://i.ytimg.com/vi/${f.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
            <div>
              <div className="title">{f.title}</div>
              <div className="meta">
                <span>{f.channelTitle}</span>
                {f.durationMs !== null && <span>{formatClock(f.durationMs)}</span>}
                {f.tab === 'streams' && <span className="badge">Stream</span>}
                {f.job && <span className="badge">{jobStatusLabel(f.job.status)}</span>}
                {!f.job && f.queued && <span className="badge">Queued</span>}
              </div>
            </div>
            <div className="actions">
              {f.job ? (
                <button onClick={() => onOpenJob((f.job as NonNullable<FeedItem['job']>).jobId)}>Open in library</button>
              ) : (
                !f.queued && (
                  <button className="primary" onClick={() => onProcess(f.videoId)}>
                    Process
                  </button>
                )
              )}
              <button onClick={() => void dismiss(f.videoId)}>Dismiss</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
