// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YouTubePlayer } from '../../src/app/renderer/components/YouTubePlayer';

type Handlers = { onReady?: () => void; onError?: (e: { data: number }) => void; onStateChange?: (e: { data: number }) => void };

let handlers: Handlers = {};
let created: { videoId: string; playerVars: Record<string, unknown> } | null = null;
const player = { getCurrentTime: vi.fn(() => 12.5), seekTo: vi.fn(), destroy: vi.fn(), unloadModule: vi.fn() };

beforeEach(() => {
  handlers = {};
  created = null;
  (window as unknown as { YT: unknown }).YT = {
    Player: function (_el: unknown, opts: { videoId: string; playerVars: Record<string, unknown>; events: Handlers }) {
      created = { videoId: opts.videoId, playerVars: opts.playerVars };
      handlers = opts.events;
      return player;
    },
  };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { YT?: unknown }).YT;
  vi.clearAllMocks();
});

describe('YouTubePlayer', () => {
  it('creates the player with embed-friendly options and exposes a TimeSource when ready', async () => {
    const onReady = vi.fn();
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={60} onReady={onReady} onFail={() => {}} />);
    await act(async () => {});
    expect(created?.videoId).toBe('7SHNxjFuw10');
    expect(created?.playerVars).toMatchObject({ enablejsapi: 1, fs: 0, rel: 0, start: 60 });
    act(() => handlers.onReady?.());
    const source = onReady.mock.calls[0][0];
    expect(source.getTimeMs()).toBe(12_500);
    source.seek(30_000);
    expect(player.seekTo).toHaveBeenCalledWith(30, true);
  });

  it("switches YouTube's own captions off so only our subtitles show", async () => {
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={() => {}} />);
    await act(async () => {});
    expect(created?.playerVars).toMatchObject({ cc_load_policy: 0 });
    act(() => handlers.onReady?.());
    expect(player.unloadModule).toHaveBeenCalledWith('captions');
    expect(player.unloadModule).toHaveBeenCalledWith('cc');
  });

  it('switches the captions off again whenever playback starts, because the module loads lazily', async () => {
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={() => {}} />);
    await act(async () => {});
    player.unloadModule.mockClear();
    act(() => handlers.onStateChange?.({ data: 3 })); // buffering: ignored
    expect(player.unloadModule).not.toHaveBeenCalled();
    act(() => handlers.onStateChange?.({ data: 1 })); // playing
    expect(player.unloadModule).toHaveBeenCalledWith('captions');
  });

  it.each([2, 5, 100, 101, 150, 153])('reports player error %i through onFail', async (code) => {
    const onFail = vi.fn();
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={onFail} />);
    await act(async () => {});
    act(() => handlers.onError?.({ data: code }));
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0]).toMatch(/embed|play|YouTube|removed|private/i);
  });

  it('reports a failure to load the YouTube API', async () => {
    delete (window as unknown as { YT?: unknown }).YT;
    const onFail = vi.fn();
    const append = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      queueMicrotask(() => (node as HTMLScriptElement).onerror?.(new Event('error')));
      return node;
    });
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={onFail} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onFail).toHaveBeenCalledWith(expect.stringMatching(/load the YouTube player/i));
    append.mockRestore();
  });

  it('destroys the player on unmount', async () => {
    const { unmount } = render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={() => {}} />);
    await act(async () => {});
    unmount();
    expect(player.destroy).toHaveBeenCalled();
  });
});
