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

  it('rejects immediately if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess(node, ['-e', ''], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
