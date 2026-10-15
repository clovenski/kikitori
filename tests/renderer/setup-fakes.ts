import { vi } from 'vitest';
import type {
  BgtApi,
  HardwareReport,
  SetupComponentInfo,
  SetupPlanView,
  SetupProgress,
  SetupSelection,
  SetupState,
} from '../../src/app/shared/ipc';

const SIZES: Record<string, number> = {
  'yt-dlp': 20e6,
  ffmpeg: 115e6,
  vad: 1e6,
  'whisper-gpu': 685e6,
  'model-transcribe-gpu': 2.95e9,
  'llama-gpu': 650e6,
  'model-translate-gpu': 4.68e9,
  'model-general-gpu': 5.03e9,
  'whisper-cpu': 9e6,
  'model-transcribe-cpu': 547e6,
  'llama-cpu': 20e6,
  'model-translate-cpu': 1.08e9,
  'model-general-cpu': 2.38e9,
};

const info = (id: string, installed: boolean): SetupComponentInfo => ({
  id,
  title: `Title ${id}`,
  tier: id.endsWith('-gpu') ? 'gpu' : id.endsWith('-cpu') ? 'cpu' : 'all',
  sizeBytes: SIZES[id],
  installed,
});

export function idsFor(s: SetupSelection): string[] {
  const ids = ['yt-dlp', 'ffmpeg', 'vad', `whisper-${s.tier}`, `model-transcribe-${s.tier}`];
  if (s.features.translation || s.features.summaries) ids.push(`llama-${s.tier}`);
  if (s.features.translation) ids.push(`model-translate-${s.tier}`);
  if (s.features.summaries) ids.push(`model-general-${s.tier}`);
  return ids;
}

export function viewFor(s: SetupSelection, installed: string[] = [], freeDiskBytes = 200e9): SetupPlanView {
  const components = idsFor(s).map((id) => info(id, installed.includes(id)));
  return {
    selection: s,
    components,
    missingBytes: components.filter((c) => !c.installed).reduce((n, c) => n + c.sizeBytes, 0),
    freeDiskBytes,
  };
}

export const GPU_BOX: HardwareReport = {
  gpuName: 'NVIDIA GeForce RTX 3080',
  vramMb: 12288,
  recommendedTier: 'gpu',
  reason: 'NVIDIA GeForce RTX 3080 (12 GB) can run the fast GPU programs.',
  ramMb: 32_000,
  cores: 24,
  freeDiskBytes: 200e9,
};
export const CPU_BOX: HardwareReport = {
  gpuName: null,
  vramMb: null,
  recommendedTier: 'cpu',
  reason: 'No NVIDIA graphics card was found.',
  ramMb: 16_000,
  cores: 8,
  freeDiskBytes: 200e9,
};

export function stateFor(over: Partial<SetupState> = {}, installed: string[] = []): SetupState {
  return {
    needsWizard: false,
    completed: true,
    installing: false,
    tier: 'gpu',
    features: { translation: true, summaries: true },
    components: Object.keys(SIZES).map((id) => info(id, installed.includes(id))),
    resourcesDir: 'C:/Users/me/AppData/Roaming/BG Auto Translator/resources',
    ...over,
  };
}

export function fakeSetupApi(
  over: { hardware?: HardwareReport; state?: SetupState; installed?: string[]; startError?: string } = {},
) {
  const listeners = new Set<(p: SetupProgress) => void>();
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const setup = {
    state: vi.fn(async () => ok(over.state ?? stateFor())),
    detect: vi.fn(async () => ok(over.hardware ?? GPU_BOX)),
    plan: vi.fn(async (s: SetupSelection) => ok(viewFor(s, over.installed, over.hardware?.freeDiskBytes))),
    missingFor: vi.fn(async () => ok(viewFor({ tier: 'gpu', features: { translation: true, summaries: true } }))),
    start: vi.fn(async () =>
      over.startError ? { ok: false as const, error: { code: 'InvalidInput', message: over.startError } } : ok(null),
    ),
    cancel: vi.fn(async () => ok(null)),
    repair: vi.fn(async () => ok(null)),
    updateYtDlp: vi.fn(async () => ok('yt-dlp is up to date')),
    openNotices: vi.fn(async () => ok(null)),
    onProgress: (cb: (p: SetupProgress) => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  return {
    setup,
    api: { setup } as unknown as BgtApi,
    emit: (p: SetupProgress) => listeners.forEach((cb) => cb(p)),
  };
}
