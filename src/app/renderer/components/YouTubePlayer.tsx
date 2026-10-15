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
    let settled = false; // ready or failed; the start-up timer must then stay quiet
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
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
            cc_load_policy: 0,
            playsinline: 1,
            start: Math.max(0, Math.floor(startSeconds)),
          },
          events: {
            onReady: () => {
              settled = true;
              clearTimeout(readyTimer);
              // Our overlay is the only subtitle track; YouTube's own captions would overlap it.
              created.unloadModule?.('captions');
              created.unloadModule?.('cc');
              callbacks.current.onReady({
                getTimeMs: () => created.getCurrentTime() * 1000,
                seek: (ms) => created.seekTo(ms / 1000, true),
              });
            },
            // The caption module loads lazily when playback starts, so switch it off again then.
            onStateChange: (e) => {
              if (e.data === 1) created.unloadModule?.('captions');
            },
            onError: (e) => {
              settled = true;
              clearTimeout(readyTimer);
              callbacks.current.onFail(ERRORS[e.data] ?? `The YouTube player reported error ${e.data}.`);
            },
          },
        });
        player = created;
        // The player can load and then never report ready; without this the page would stay blank.
        readyTimer = setTimeout(() => {
          if (settled || destroyed) return;
          settled = true;
          callbacks.current.onFail('The YouTube player did not start in time. Check your internet connection, or open the video on YouTube.');
        }, 15_000);
      })
      .catch((err: Error) => {
        if (!destroyed) callbacks.current.onFail(err.message);
      });

    return () => {
      destroyed = true;
      clearTimeout(readyTimer);
      player?.destroy();
      mount.remove();
    };
  }, [videoId, startSeconds]);

  return <div ref={host} style={{ width: '100%', height: '100%' }} />;
}
