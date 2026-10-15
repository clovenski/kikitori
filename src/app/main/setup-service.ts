import type { SubmissionOptions } from '../../core/db/submission-repo';
import { BgtError } from '../../core/errors';
import { wantsOfOptions } from '../../core/setup/components';
import type { HardwareInfo } from '../../core/setup/hardware';
import type { installComponents, removeDamaged, uninstallComponents } from '../../core/setup/installer';
import { buildPlan, componentInstalled, requiredFreeBytes } from '../../core/setup/plan';
import { defaultSettings, readSettings, writeSettings, type Settings } from '../../core/setup/settings';
import { componentBytes, findComponent, type Lock, type LockComponent } from '../../core/tools/lock';
import type {
  HardwareReport,
  SetupComponentInfo,
  SetupPlanView,
  SetupProgress,
  SetupSelection,
  SetupState,
} from '../shared/ipc';

export interface SetupServiceDeps {
  lock: Lock;
  resourcesDir: string;
  dataDir: string;
  hardware(): Promise<HardwareInfo>;
  install: typeof installComponents;
  uninstall: typeof uninstallComponents;
  removeDamaged: typeof removeDamaged;
  freeBytes(dir: string): number;
  updateYtDlp(): Promise<string>;
  /** True while a job runs: its programs and models are open, so they must not be removed. */
  jobRunning(): boolean;
  emit(p: SetupProgress): void;
  log(message: string): void;
}

const NO_FEATURES = { translation: false, summaries: false };

/** Runs first-run setup, on-demand downloads, tier switches and repair, one at a time, in the background. */
export class SetupService {
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly d: SetupServiceDeps) {}

  private info(c: LockComponent): SetupComponentInfo {
    return {
      id: c.id,
      title: c.title,
      tier: c.tier,
      sizeBytes: componentBytes(c),
      installed: componentInstalled(c, this.d.resourcesDir),
    };
  }

  private settings(): Settings {
    return readSettings(this.d.dataDir) ?? defaultSettings();
  }

  state(): SetupState {
    const s = this.settings();
    const core = buildPlan(this.d.lock, s.tier, NO_FEATURES, this.d.resourcesDir);
    return {
      needsWizard: !s.setupCompleted || core.missing.length > 0,
      completed: s.setupCompleted,
      installing: this.running !== null,
      tier: s.tier,
      features: s.features,
      components: this.d.lock.components.map((c) => this.info(c)),
      resourcesDir: this.d.resourcesDir,
    };
  }

  async detect(): Promise<HardwareReport> {
    const h = await this.d.hardware();
    return {
      gpuName: h.best?.name ?? null,
      vramMb: h.best?.vramMb ?? null,
      recommendedTier: h.tier,
      reason: h.reason,
      ramMb: h.ramMb,
      cores: h.cores,
      freeDiskBytes: this.d.freeBytes(this.d.resourcesDir),
    };
  }

  plan(sel: SetupSelection): SetupPlanView {
    const plan = buildPlan(this.d.lock, sel.tier, sel.features, this.d.resourcesDir);
    return {
      selection: sel,
      components: plan.required.map((c) => this.info(c)),
      missingBytes: plan.missingBytes,
      requiredFreeBytes: requiredFreeBytes(plan.missing, this.d.resourcesDir),
      freeDiskBytes: this.d.freeBytes(this.d.resourcesDir),
    };
  }

  /** What a job with these options still needs: the chosen features plus what the job asks for. */
  missingFor(options: SubmissionOptions): SetupPlanView {
    const s = this.settings();
    const w = wantsOfOptions(options);
    return this.plan({
      tier: s.tier,
      features: { translation: s.features.translation || w.translation, summaries: s.features.summaries || w.summaries },
    });
  }

  autoGlossaryAvailable(): boolean {
    return componentInstalled(findComponent(this.d.lock, `model-general-${this.settings().tier}`), this.d.resourcesDir);
  }

  start(sel: SetupSelection): void {
    const before = readSettings(this.d.dataDir);
    if (before?.setupCompleted && before.tier !== sel.tier && this.d.jobRunning()) {
      throw new BgtError('InvalidInput', 'A job is running. Switching removes the programs it is using; wait for it to finish or cancel it first.');
    }
    this.launch(async (signal) => {
      const before = readSettings(this.d.dataDir) ?? defaultSettings(sel.tier);
      const switching = before.setupCompleted && before.tier !== sel.tier;
      if (switching) {
        this.d.uninstall(this.d.lock.components.filter((c) => c.tier === before.tier), this.d.resourcesDir);
      }
      const saved: Settings = {
        version: 1,
        tier: sel.tier,
        features: sel.features,
        setupCompleted: before.setupCompleted && !switching,
      };
      writeSettings(this.d.dataDir, saved);
      await this.installMissing(sel.tier, sel.features, signal);
      writeSettings(this.d.dataDir, { ...saved, setupCompleted: true });
    });
  }

  repair(): void {
    if (this.d.jobRunning()) {
      throw new BgtError('InvalidInput', 'A job is running. Repair can delete files it is using; wait for it to finish or cancel it first.');
    }
    this.launch(async (signal) => {
      const s = readSettings(this.d.dataDir);
      if (!s) throw new BgtError('InvalidInput', 'Nothing is set up yet.');
      const plan = buildPlan(this.d.lock, s.tier, s.features, this.d.resourcesDir);
      const removed = await this.d.removeDamaged(plan.required, this.d.resourcesDir, signal, (f) =>
        this.d.emit({ phase: 'installing', progress: null, message: `Checking ${f.id}...` }),
      );
      if (removed.length > 0) {
        this.d.log(`Repair: ${removed.map((e) => e.id).join(', ')} did not match its checksum and will be downloaded again.`);
      }
      await this.installMissing(s.tier, s.features, signal);
    });
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    await this.running;
  }

  updateYtDlp(): Promise<string> {
    return this.d.updateYtDlp();
  }

  whenIdle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async installMissing(
    tier: SetupSelection['tier'],
    features: SetupSelection['features'],
    signal: AbortSignal,
  ): Promise<void> {
    const plan = buildPlan(this.d.lock, tier, features, this.d.resourcesDir);
    await this.d.install({
      components: plan.missing,
      resourcesDir: this.d.resourcesDir,
      signal,
      log: this.d.log,
      onProgress: (progress) => this.d.emit({ phase: 'installing', progress, message: null }),
    });
  }

  private launch(work: (signal: AbortSignal) => Promise<void>): void {
    if (this.running) throw new BgtError('InvalidInput', 'A download is already running.');
    const controller = new AbortController();
    this.controller = controller;
    this.d.emit({ phase: 'installing', progress: null, message: null });
    this.running = work(controller.signal)
      .then(
        () => this.d.emit({ phase: 'done', progress: null, message: null }),
        (err) => {
          if (controller.signal.aborted) {
            this.d.emit({ phase: 'cancelled', progress: null, message: 'The download is paused and continues where it stopped.' });
            return;
          }
          this.d.log(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
          this.d.emit({ phase: 'failed', progress: null, message: err instanceof Error ? err.message : String(err) });
        },
      )
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
  }
}
