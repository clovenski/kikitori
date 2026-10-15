import type { Channel, ChannelStore } from '../../core/db/channel-repo';

export const START_DELAY_MS = 15_000;
export const INTERVAL_MS = 30 * 60_000;
export const PAUSE_MS = 1_000;

export interface ChannelWatcherDeps {
  store: ChannelStore;
  /** Checks one channel; errors that belong to the channel are recorded by it, only aborts and bugs throw. */
  check(channel: Channel, signal: AbortSignal): Promise<{ added: number; error: string | null }>;
  /** False while the first-run wizard is open, a setup download runs or yt-dlp is missing. */
  canRun(): boolean;
  onChanged(): void;
  log?(message: string): void;
  startDelayMs?: number;
  intervalMs?: number;
  pauseMs?: number;
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Looks for new videos on the followed channels while the app is open: shortly after start, then on an interval. */
export class ChannelWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;

  constructor(private readonly d: ChannelWatcherDeps) {}

  start(): void {
    this.stopped = false;
    this.schedule(this.d.startDelayMs ?? START_DELAY_MS);
  }

  /** Aborts the check in progress (its yt-dlp is killed), waits for it and cancels the timer. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.running;
  }

  /** Checks one channel (or all of them) now. A request that arrives during a check shares that check. */
  refresh(channelId?: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.running ?? this.run(channelId);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().finally(() => this.schedule(this.d.intervalMs ?? INTERVAL_MS));
    }, ms);
  }

  private run(channelId?: number): Promise<void> {
    this.running = this.checkAll(channelId).finally(() => {
      this.running = null;
      this.controller = null;
    });
    return this.running;
  }

  private async checkAll(channelId?: number): Promise<void> {
    if (!this.d.canRun()) return;
    const controller = new AbortController();
    this.controller = controller;
    const channels = this.d.store.listChannels().filter((c) => channelId === undefined || c.id === channelId);
    let checkedAny = false;
    for (let i = 0; i < channels.length; i++) {
      if (controller.signal.aborted) break;
      try {
        await this.d.check(channels[i], controller.signal);
        checkedAny = true;
      } catch (err) {
        if (controller.signal.aborted) break;
        this.d.log?.(`Channels: unexpected error while checking "${channels[i].title}": ${err instanceof Error ? err.message : String(err)}`);
      }
      if (i < channels.length - 1) await delay(this.d.pauseMs ?? PAUSE_MS, controller.signal);
    }
    if (checkedAny) this.d.onChanged();
  }
}
