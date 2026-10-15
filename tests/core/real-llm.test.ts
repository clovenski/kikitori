import { beforeEach, describe, expect, it, vi } from 'vitest';

const started: { stop: ReturnType<typeof vi.fn> }[] = [];
let gate: Promise<void> = Promise.resolve();

vi.mock('../../src/core/llm/llama-server', () => ({
  LlamaServer: {
    async start() {
      await gate;
      const server = { baseUrl: 'http://127.0.0.1:1', stop: vi.fn(async () => {}) };
      started.push(server);
      return server;
    },
  },
}));
vi.mock('../../src/core/tools/lock', () => ({
  loadLock: () => ({}),
  componentModelPath: () => 'model.gguf',
}));
vi.mock('../../src/core/tools/paths', () => ({
  projectRoot: () => '.',
  resolveTool: () => 'llama-server',
  resourcesDir: () => '.',
}));

import { createRealModelPool } from '../../src/core/pipeline/real-llm';

const pool = () => createRealModelPool({ log: () => {}, tier: () => 'cpu' });

beforeEach(() => {
  started.length = 0;
  gate = Promise.resolve();
});

describe('createRealModelPool', () => {
  it('stopAll stops the running model but the pool can start another afterwards', async () => {
    const p = pool();
    await p.use('general');
    await p.stopAll();
    expect(started[0].stop).toHaveBeenCalledOnce();
    await p.use('general');
    expect(started).toHaveLength(2);
  });

  it('refuses to start a model once closed', async () => {
    const p = pool();
    await p.use('general');
    await p.close();
    expect(started[0].stop).toHaveBeenCalledOnce();
    await expect(p.use('translate')).rejects.toThrow(/shutting down/);
    expect(started).toHaveLength(1);
  });

  it('stops a model that finished starting after close', async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const p = pool();
    const pending = p.use('general');
    await p.close();
    release();
    await expect(pending).rejects.toThrow(/shutting down/);
    expect(started[0].stop).toHaveBeenCalledOnce();
  });
});
