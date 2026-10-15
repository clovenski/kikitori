import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Lock, Tier } from '../tools/lock';
import { transcribeModelName } from './components';
import { buildPlan } from './plan';

export interface Settings {
  version: 1;
  tier: Tier;
  features: { translation: boolean; summaries: boolean };
  setupCompleted: boolean;
  /** Where subtitles and summaries are written; absent means the default folder. */
  outputDir?: string;
}

export const defaultSettings = (tier: Tier = 'gpu'): Settings => ({
  version: 1,
  tier,
  features: { translation: true, summaries: true },
  setupCompleted: false,
});

const file = (dataDir: string) => path.join(dataDir, 'settings.json');

export function readSettings(dataDir: string): Settings | null {
  try {
    const raw = JSON.parse(readFileSync(file(dataDir), 'utf8')) as Partial<Settings>;
    const f = raw.features;
    if (raw.version !== 1 || (raw.tier !== 'gpu' && raw.tier !== 'cpu') || typeof raw.setupCompleted !== 'boolean') return null;
    if (!f || typeof f.translation !== 'boolean' || typeof f.summaries !== 'boolean') return null;
    const settings: Settings = {
      version: 1,
      tier: raw.tier,
      features: { translation: f.translation, summaries: f.summaries },
      setupCompleted: raw.setupCompleted,
    };
    if (typeof raw.outputDir === 'string' && raw.outputDir !== '') settings.outputDir = raw.outputDir;
    return settings;
  } catch {
    return null;
  }
}

/** Writes through a temporary file so a crash never leaves half a settings file. */
export function writeSettings(dataDir: string, settings: Settings): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file(dataDir)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file(dataDir));
}

/** The tier the installed components belong to; checkouts from before Milestone 4 are gpu. */
export const currentTier = (dataDir: string): Tier => readSettings(dataDir)?.tier ?? 'gpu';
export const defaultTranscribeModel = (dataDir: string): string => transcribeModelName(currentTier(dataDir));

/**
 * Saved settings if there are any. Otherwise, if a whole tier is already installed (a development checkout), record
 * that as a finished setup so no wizard appears; otherwise return defaults and write nothing.
 */
export function ensureSettings(a: { dataDir: string; lock: Lock; resources: string }): Settings {
  const existing = readSettings(a.dataDir);
  if (existing) return existing;
  const complete = (tier: Tier, translation: boolean, summaries: boolean) =>
    buildPlan(a.lock, tier, { translation, summaries }, a.resources).missing.length === 0;
  for (const tier of ['gpu', 'cpu'] as const) {
    if (!complete(tier, false, false)) continue;
    const settings: Settings = {
      version: 1,
      tier,
      features: { translation: complete(tier, true, false), summaries: complete(tier, false, true) },
      setupCompleted: true,
    };
    writeSettings(a.dataDir, settings);
    return settings;
  }
  return defaultSettings();
}
