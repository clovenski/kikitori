export interface YTPlayer {
  getCurrentTime(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  destroy(): void;
  /** Not in every player build; used to switch the caption module off. */
  unloadModule?(name: string): void;
}

export interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      host?: string;
      playerVars: Record<string, unknown>;
      events: {
        onReady?: () => void;
        onError?: (e: { data: number }) => void;
        onStateChange?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!loading) {
    loading = new Promise<YTNamespace>((resolve, reject) => {
      // The script can load and still never call back (captive portal, blocked frame): give up.
      const timer = setTimeout(() => {
        loading = null;
        reject(new Error('The YouTube player did not load in time. Check your internet connection.'));
      }, 10_000);
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        previous?.();
        resolve(window.YT as YTNamespace);
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => {
        clearTimeout(timer);
        loading = null;
        reject(new Error('Could not load the YouTube player.'));
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}
