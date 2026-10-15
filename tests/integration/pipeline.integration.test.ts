import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRealDeps } from '../../src/core/pipeline/real-deps';
import { runJob } from '../../src/core/pipeline/run';
import { resolveTool } from '../../src/core/tools/paths';

// Opt in with KTR_INTEGRATION=1. Requires `pnpm setup:tools` and ffmpeg.
describe.skipIf(!process.env.KTR_INTEGRATION)('real binaries', () => {
  let root: string;
  let source: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'bgt integration '));
    mkdirSync(path.join(root, 'in'), { recursive: true });
    source = path.join(root, 'in', 'テスト 音声.wav'); // space + Japanese characters
    execFileSync(resolveTool('ffmpeg'), [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6', '-ar', '44100', source,
    ]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('processes a local file with a non-ASCII name end to end', async () => {
    const { deps, workRoot, close } = createRealDeps({
      dataDir: path.join(root, 'data'),
      model: 'large-v3',
      log: () => {},
    });
    try {
      const result = await runJob(deps, {
        source,
        startMs: 1_000,
        endMs: 5_000,
        maxMinutes: 30,
        model: 'large-v3',
        language: 'ja',
        workRoot,
        outDir: path.join(root, 'out dir'),
        keepWork: false,
      });
      expect(result.status).toBe('done');
      expect(existsSync(result.srtPath)).toBe(true);
      expect(typeof readFileSync(result.srtPath, 'utf8')).toBe('string'); // a tone yields no speech
    } finally {
      close();
    }
  }, 300_000);
});
