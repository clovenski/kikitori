import { useEffect, useRef } from 'react';
import type { TimeSource } from '../lib/timesource';
import { loadYouTubeApi } from '../lib/youtube-api';

interface Props {
  videoId: string;
  startSeconds: number;
  onReady(source: TimeSource): void;
  onFail(message: string): void;
}

const ERRORS: Record<number, string> = {
  2: 'YouTube rejected this video link.',
  5: 'The YouTube player hit an error playing this video.',
  100: 'This video was removed or is private.',
  101: 'The owner of this video does not allow it to be embedded.',
  150: 'The owner of this video does not allow it to be embedded.',
  153: 'YouTube refused to play the video inside the app (embed configuration error).',
};

export function YouTubePlayer({ videoId, startSeconds, onReady, onFail }: Props) {
  const host = useRef<HTMLDivElement>(null);
  // Keep the latest callbacks without recreating the player.
  const callbacks = useRef({ onReady, onFail });
  callbacks.current = { onReady, onFail };

  useEffect(() => {
    let destroyed = false;
    let player: { destroy(): void } | null = null;
    const mount = document.createElement('div');
    host.current?.appendChild(mount);

    loadYouTubeApi()
      .then((YT) => {
        if (destroyed) return;
        const created = new YT.Player(mount, {
          videoId,
          host: 'https://www.youtube.com',
          playerVars: {
            enablejsapi: 1,
            fs: 0,
            rel: 0,
            playsinline: 1,
            start: Math.max(0, Math.floor(startSeconds)),
            origin: 'https://bgt.local',
          },
          events: {
            onReady: () =>
              callbacks.current.onReady({
                getTimeMs: () => created.getCurrentTime() * 1000,
                seek: (ms) => created.seekTo(ms / 1000, true),
              }),
            onError: (e) => callbacks.current.onFail(ERRORS[e.data] ?? `The YouTube player reported error ${e.data}.`),
          },
        });
        player = created;
      })
      .catch((err: Error) => {
        if (!destroyed) callbacks.current.onFail(err.message);
      });

    return () => {
      destroyed = true;
      player?.destroy();
      mount.remove();
    };
  }, [videoId, startSeconds]);

  return <div ref={host} style={{ width: '100%', height: '100%' }} />;
}
