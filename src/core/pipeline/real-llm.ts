import path from 'node:path';
import { BgtError } from '../errors';
import { LlmClient } from '../llm/client';
import { LlamaServer } from '../llm/llama-server';
import { componentModelPath, loadLock, type Tier } from '../tools/lock';
import { projectRoot, resolveTool, resourcesDir } from '../tools/paths';
import type { ModelPool, ModelRole } from './stages';

const COMPONENT: Record<ModelRole, string> = { general: 'model-general', translate: 'model-translate' };
const CONTEXT: Record<ModelRole, number> = { general: 8192, translate: 4096 };

export function createRealModelPool(a: {
  log: (message: string) => void;
  /** Read on every start, so a tier switch in the app takes effect without a restart. */
  tier: () => Tier;
  lockFile?: string;
}): ModelPool & { close(): Promise<void> } {
  let closed = false;
  let current: { role: ModelRole; server: LlamaServer; client: LlmClient } | null = null;

  const stopAll = async () => {
    const running = current;
    current = null;
    if (running) await running.server.stop();
  };

  return {
    async use(role, signal) {
      if (closed) throw new BgtError('LlmServerFailed', 'The app is shutting down.');
      if (current?.role === role) return current.client;
      await stopAll();
      const lock = loadLock(a.lockFile ?? path.join(projectRoot(), 'tools.lock.json'));
      a.log(`Starting the ${role === 'translate' ? 'translation' : 'general'} model...`);
      const server = await LlamaServer.start(
        {
          serverPath: resolveTool('llama-server'),
          modelPath: componentModelPath(lock, `${COMPONENT[role]}-${a.tier()}`, resourcesDir()),
          contextSize: CONTEXT[role],
        },
        signal,
      );
      if (closed) {
        // Shutdown ran while this server was starting; nobody else knows about it.
        await server.stop();
        throw new BgtError('LlmServerFailed', 'The app is shutting down.');
      }
      current = { role, server, client: new LlmClient({ baseUrl: server.baseUrl }) };
      return current.client;
    },
    stopAll,
    /** For shutdown: stops the running model and refuses to start another. */
    async close() {
      closed = true;
      await stopAll();
    },
  };
}
