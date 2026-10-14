import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServerArgs, LlamaServer, type LlamaServerConfig } from '../../src/core/llm/llama-server';

const fixture = path.resolve('tests/fixtures/fake-llama-server.mjs');
const cfg: LlamaServerConfig = {
  serverPath: process.execPath,
  argsPrefix: [fixture],
  modelPath: 'model.gguf',
  startupTimeoutMs: 15_000,
};

afterEach(() => {
  delete process.env.FAKE_LLAMA_MODE;
});

describe('buildServerArgs', () => {
  it('passes model, port, context and GPU layers', () => {
    const args = buildServerArgs({ ...cfg, argsPrefix: undefined, contextSize: 8192, gpuLayers: 40 }, 8123);
    expect(args).toEqual(['-m', 'model.gguf', '--host', '127.0.0.1', '--port', '8123', '-c', '8192', '-ngl', '40']);
  });
});

describe('LlamaServer', () => {
  it('waits until healthy, serves, and stops (port released)', async () => {
    const server = await LlamaServer.start(cfg);
    const ok = await fetch(`${server.baseUrl}/health`);
    expect(ok.status).toBe(200);
    await server.stop();
    await expect(fetch(`${server.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).rejects.toBeDefined();
  });

  it('reports the process output when the server dies during startup', async () => {
    process.env.FAKE_LLAMA_MODE = 'crash';
    await expect(LlamaServer.start(cfg)).rejects.toMatchObject({
      code: 'LlmServerFailed',
      message: expect.stringContaining('failed to load model'),
    });
  });

  it('times out when the server never becomes healthy', async () => {
    await expect(LlamaServer.start({ ...cfg, startupTimeoutMs: 100 })).rejects.toMatchObject({
      code: 'LlmServerFailed',
      message: expect.stringContaining('did not become ready'),
    });
  });

  it('kills the child and rejects when aborted during startup', async () => {
    const controller = new AbortController();
    const pending = LlamaServer.start(cfg, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
