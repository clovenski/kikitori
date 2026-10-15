import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../../core/errors';
import { defaultSettings, readSettings, writeSettings } from '../../core/setup/settings';
import type { OutputDirInfo } from '../shared/ipc';

export interface OutputDirDeps {
  dataDir: string;
  /** Where output goes until the user picks a folder (already resolved from the environment and the install type). */
  defaultDir: string;
  /** True when KTR_OUTPUT_DIR fixes the folder. */
  locked: boolean;
  /** Shows the folder picker starting at `current`; null when the user cancels. */
  pick(current: string): Promise<string | null>;
}

const LOCKED_MESSAGE = 'The output folder is fixed by the KTR_OUTPUT_DIR environment variable. Remove the variable to change it here.';

/** The folder new jobs write subtitles and summaries to: a saved choice, else the default. */
export class OutputDirService {
  constructor(private readonly d: OutputDirDeps) {}

  current(): string {
    if (this.d.locked) return this.d.defaultDir;
    return readSettings(this.d.dataDir)?.outputDir ?? this.d.defaultDir;
  }

  info(): OutputDirInfo {
    const dir = this.current();
    return { dir, isDefault: !this.d.locked && dir === this.d.defaultDir, locked: this.d.locked };
  }

  async choose(): Promise<OutputDirInfo | null> {
    if (this.d.locked) throw new BgtError('InvalidInput', LOCKED_MESSAGE);
    const picked = await this.d.pick(this.current());
    if (picked === null) return null;
    const dir = path.resolve(picked);
    ensureWritable(dir);
    this.save(dir);
    return this.info();
  }

  reset(): OutputDirInfo {
    if (this.d.locked) throw new BgtError('InvalidInput', LOCKED_MESSAGE);
    this.save(undefined);
    return this.info();
  }

  private save(dir: string | undefined): void {
    const settings = readSettings(this.d.dataDir) ?? defaultSettings();
    if (dir === undefined) delete settings.outputDir;
    else settings.outputDir = dir;
    writeSettings(this.d.dataDir, settings);
  }
}

/** Creates the folder if needed and proves a file can be written there, so a bad choice fails now and not at the end of a job. */
function ensureWritable(dir: string): void {
  const probe = path.join(dir, `.kikitori-write-test-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch (err) {
    throw new BgtError('InvalidInput', `Can't write to ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
