// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handlers = { onReady?: () => void; onError?: (e: { data: number }) => void; onStateChange?: (e: { data: number }) => void };
let handlers: Handlers = {};
const player = { getCurrentTime: vi.fn(() => 0), seekTo: vi.fn(), destroy: vi.fn(), unloadModule: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  handlers = {};
  (window as unknown as { YT: unknown }).YT = {
    Player: function (_el: unknown, opts: { events: Handlers }) {
      handlers = opts.events;
      return player;
    },
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

describe('YouTubePlayer never becoming ready', () => {
  it('gives up after 15 seconds and reports it, so the page can fall back to reader mode', async () => {
    const { YouTubePlayer } = await import('../../src/app/renderer/components/YouTubePlayer');
    const onFail = vi.fn();
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={onFail} />);
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(14_000);
    });
    expect(onFail).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0]).toMatch(/did not start/i);
  });

  it('does not report anything when the player becomes ready in time', async () => {
    const { YouTubePlayer } = await import('../../src/app/renderer/components/YouTubePlayer');
    const onFail = vi.fn();
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={onFail} />);
    await act(async () => {});
    act(() => handlers.onReady?.());
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onFail).not.toHaveBeenCalled();
  });

  it('does not report a second failure after a player error already did', async () => {
    const { YouTubePlayer } = await import('../../src/app/renderer/components/YouTubePlayer');
    const onFail = vi.fn();
    render(<YouTubePlayer videoId="7SHNxjFuw10" startSeconds={0} onReady={() => {}} onFail={onFail} />);
    await act(async () => {});
    act(() => handlers.onError?.({ data: 153 }));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});

describe('loadYouTubeApi', () => {
  it('rejects when the script loads but the ready callback never fires', async () => {
    delete (window as unknown as { YT?: unknown }).YT;
    const { loadYouTubeApi } = await import('../../src/app/renderer/lib/youtube-api');
    const append = vi.spyOn(document.head, 'appendChild').mockImplementation((n) => n); // loads, never calls back
    const pending = loadYouTubeApi();
    const caught = pending.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(((await caught) as Error).message).toMatch(/did not load in time/i);
    append.mockRestore();
  });

  it('lets a later call try again after a timeout', async () => {
    delete (window as unknown as { YT?: unknown }).YT;
    const { loadYouTubeApi } = await import('../../src/app/renderer/lib/youtube-api');
    const append = vi.spyOn(document.head, 'appendChild').mockImplementation((n) => n);
    const first = loadYouTubeApi().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10_500);
    await first;
    const second = loadYouTubeApi();
    (window as unknown as { YT: unknown }).YT = { Player: function () {} };
    window.onYouTubeIframeAPIReady?.();
    await expect(second).resolves.toBeDefined();
    append.mockRestore();
  });
});
