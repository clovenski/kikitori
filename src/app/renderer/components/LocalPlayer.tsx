import { useEffect, useRef } from 'react';
import type { TimeSource } from '../lib/timesource';

interface Props {
  jobId: number;
  startSeconds: number;
  onReady(source: TimeSource): void;
}

export function LocalPlayer({ jobId, startSeconds, onReady }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const ready = () => {
      if (startSeconds > 0) video.currentTime = startSeconds;
      onReady({ getTimeMs: () => video.currentTime * 1000, seek: (ms) => (video.currentTime = ms / 1000) });
    };
    video.addEventListener('loadedmetadata', ready, { once: true });
    return () => video.removeEventListener('loadedmetadata', ready);
  }, [jobId, startSeconds, onReady]);
  return <video ref={ref} src={`bgt-media://job/${jobId}`} controls style={{ width: '100%', height: '100%' }} />;
}
