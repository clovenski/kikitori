import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/core/tools/process';

const node = process.execPath;

describe('runProcess', () => {
  it('captures stdout, stderr and exit code', async () => {
    const r = await runProcess(node, ['-e', 'console.log("out"); console.error("err"); process.exit(3)']);
    expect(r.code).toBe(3);
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
  });

  it('passes arguments with spaces and non-ASCII characters intact (no shell)', async () => {
    const arg = 'my test dir/テスト 音声.wav';
    const r = await runProcess(node, ['-e', 'console.log(process.argv[1])', arg]);
    expect(r.stdout.trim()).toBe(arg);
  });

  it('maps a missing executable to ToolMissing', async () => {
    await expect(runProcess('definitely-not-a-real-binary-xyz', [])).rejects.toMatchObject({
      code: 'ToolMissing',
    });
  });

  it('kills the child and rejects when aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runProcess(node, ['-e', 'setTimeout(() => {}, 60000)'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('kills grandchildren too, and has finished doing so by the time the abort rejects', async () => {
    // yt-dlp is a launcher exe whose worker (and ffmpeg) are grandchildren; quitting right after the
    // abort used to leave them running because taskkill had not finished yet.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-tree-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    const script =
      "const { spawn } = require('child_process');" +
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });" +
      "require('fs').writeFileSync(process.argv[1], String(c.pid));" +
      'setTimeout(() => {}, 60000);';
    const controller = new AbortController();
    const pending = runProcess(node, ['-e', script, pidFile], { signal: controller.signal });
    let grandchild = 0;
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
      grandchild = Number(readFileSync(pidFile, 'utf8'));
      expect(grandchild).toBeGreaterThan(0);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(() => process.kill(grandchild, 0)).toThrow(); // already gone, no waiting needed
    } finally {
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {
        /* already dead */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects immediately if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess(node, ['-e', ''], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
