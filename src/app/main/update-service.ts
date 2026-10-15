import type { UpdateState } from '../shared/ipc';

export const START_DELAY_MS = 20_000;
export const INTERVAL_MS = 6 * 60 * 60_000;

/** What the service needs from an updater; the real one wraps electron-updater (see updater.ts). */
export interface UpdaterPort {
  /** The newer version that is published, or null when this one is the latest. */
  check(): Promise<{ version: string } | null>;
  /** Downloads the version `check` found, reporting 0-100 as it goes. */
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Starts the installer and quits the app. */
  install(): void;
}

export interface UpdateServiceDeps {
  updater: UpdaterPort;
  /** False for a development run, where there is no installed app to replace. */
  enabled: boolean;
  /** Asks the user to confirm quitting when a job is running; false means they chose to keep it going. */
  canQuit(): boolean;
  emit(state: UpdateState): void;
  log(message: string): void;
  startDelayMs?: number;
  intervalMs?: number;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Looks for a newer release while the app is open and announces it. It never downloads on its own:
 * the user has to ask (`download`), and again to restart into it (`install`).
 */
export class UpdateService {
  private current: UpdateState = { phase: 'idle' };
  private checking: Promise<UpdateState> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly d: UpdateServiceDeps) {}

  state(): UpdateState {
    return this.current;
  }

  start(): void {
    if (!this.d.enabled) return;
    this.stopped = false;
    this.schedule(this.d.startDelayMs ?? START_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Looks for a newer version. Throws when the check fails; the scheduled check only logs that. */
  check(): Promise<UpdateState> {
    if (!this.d.enabled) return Promise.reject(new Error('Updates are only available in the installed app.'));
    // Once a download has started, the version in hand is the one to finish with.
    if (this.current.phase === 'downloading' || this.current.phase === 'ready') return Promise.resolve(this.current);
    this.checking ??= this.look().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** Downloads the announced version (or retries a failed download). Progress and the outcome arrive through `emit`. */
  async download(): Promise<void> {
    const from = this.current;
    if (from.phase !== 'available' && from.phase !== 'failed') return;
    const { version } = from;
    let percent = 0;
    this.set({ phase: 'downloading', version, percent });
    try {
      await this.d.updater.download((p) => {
        const whole = Math.max(0, Math.min(100, Math.floor(p)));
        if (whole === percent) return;
        percent = whole;
        this.set({ phase: 'downloading', version, percent });
      });
      this.set({ phase: 'ready', version });
    } catch (err) {
      this.d.log(`Updates: downloading ${version} failed: ${messageOf(err)}`);
      this.set({ phase: 'failed', version, message: messageOf(err) });
    }
  }

  /** Quits and installs the downloaded update. False when none is ready or the user chose to keep a job running. */
  install(): boolean {
    if (this.current.phase !== 'ready' || !this.d.canQuit()) return false;
    this.d.updater.install();
    return true;
  }

  private async look(): Promise<UpdateState> {
    const found = await this.d.updater.check();
    // A download may have started while the check ran; it wins.
    if (this.current.phase === 'downloading' || this.current.phase === 'ready') return this.current;
    this.set(found ? { phase: 'available', version: found.version } : { phase: 'idle' });
    return this.current;
  }

  private set(state: UpdateState): void {
    const same = JSON.stringify(state) === JSON.stringify(this.current);
    this.current = state;
    if (!same) this.d.emit(state);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check()
        .catch((err) => this.d.log(`Updates: check failed: ${messageOf(err)}`))
        .finally(() => this.schedule(this.d.intervalMs ?? INTERVAL_MS));
    }, ms);
  }
}
