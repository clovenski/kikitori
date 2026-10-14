import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobDetail } from '../../shared/ipc';
import { useApi } from '../lib/api';
import { findActiveIndex, type SubtitleMode } from '../lib/subtitles';
import { useCurrentTime, type TimeSource } from '../lib/timesource';
import { LocalPlayer } from './LocalPlayer';
import { PlayerShell, type SubtitleSize } from './PlayerShell';
import { SummaryPanel } from './SummaryPanel';
import { TranscriptPanel } from './TranscriptPanel';
import { YouTubePlayer } from './YouTubePlayer';

interface Props {
  jobId: number;
  onBack(): void;
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; detail: JobDetail };

export function JobScreen({ jobId, onBack }: Props) {
  const api = useApi();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [mode, setMode] = useState<SubtitleMode>('en');
  const [size, setSize] = useState<SubtitleSize>('medium');
  const [tab, setTab] = useState<'transcript' | 'summary'>('transcript');
  const [source, setSource] = useState<TimeSource | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoad({ kind: 'loading' });
    setFailure(null);
    setSource(null);
    void api.job.get(jobId).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setLoad({ kind: 'ok', detail: r.value });
        setMode(r.value.item.hasTranslation ? 'en' : 'ja');
      } else {
        setLoad({ kind: 'error', message: r.error.message });
      }
    });
    return () => {
      alive = false;
    };
  }, [api, jobId]);

  const timeMs = useCurrentTime(source);
  const lines = load.kind === 'ok' ? load.detail.lines : [];
  const activeIndex = useMemo(() => findActiveIndex(lines, timeMs), [lines, timeMs]);
  const seek = useCallback((ms: number) => source?.seek(ms), [source]);
  const onReady = useCallback((s: TimeSource) => setSource(s), []);
  const onFail = useCallback((message: string) => setFailure(message), []);

  if (load.kind === 'loading') return <div>Loading...</div>;
  if (load.kind === 'error') {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div className="notice">{load.message}</div>
      </div>
    );
  }

  const { item, summaries } = load.detail;
  const startSeconds = item.rangeStartMs / 1000;
  const youtubeUrl = item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}&t=${Math.floor(startSeconds)}s` : null;

  return (
    <div className="job">
      <div className="job-left">
        <div className="toolbar">
          <button onClick={onBack}>Back</button>
          <strong>{item.title ?? item.source}</strong>
        </div>
        {failure ? (
          <div className="notice">
            <div>{failure}</div>
            <div>The transcript and summary still work; click a line to see its time.</div>
            {youtubeUrl && (
              <button onClick={() => window.open(youtubeUrl)}>Open on YouTube</button>
            )}
          </div>
        ) : (
          <PlayerShell lines={lines} mode={mode} size={size} timeMs={timeMs}>
            {item.isLocalFile ? (
              <LocalPlayer jobId={item.jobId} startSeconds={startSeconds} onReady={onReady} />
            ) : item.videoId ? (
              <YouTubePlayer videoId={item.videoId} startSeconds={startSeconds} onReady={onReady} onFail={onFail} />
            ) : (
              <div className="notice">This job has no playable video.</div>
            )}
          </PlayerShell>
        )}
        <div className="toolbar">
          <label>
            Subtitles{' '}
            <select aria-label="Subtitles" value={mode} onChange={(e) => setMode(e.target.value as SubtitleMode)}>
              <option value="en">English</option>
              <option value="ja">Japanese</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label>
            Size{' '}
            <select aria-label="Size" value={size} onChange={(e) => setSize(e.target.value as SubtitleSize)}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
          <button onClick={() => void api.job.openOutputFolder(item.jobId)}>Open output folder</button>
          {youtubeUrl && !failure && <button onClick={() => window.open(youtubeUrl)}>Open on YouTube</button>}
        </div>
      </div>
      <div className="job-right">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'transcript'} onClick={() => setTab('transcript')}>
            Transcript
          </button>
          <button role="tab" aria-selected={tab === 'summary'} onClick={() => setTab('summary')}>
            Summary
          </button>
        </div>
        {tab === 'transcript' ? (
          <TranscriptPanel lines={lines} activeIndex={activeIndex} mode={mode} onSeek={seek} />
        ) : (
          <SummaryPanel summaries={summaries} onSeek={seek} />
        )}
      </div>
    </div>
  );
}
