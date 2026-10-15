import path from 'node:path';
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
}): ModelPool {
  let current: { role: ModelRole; server: LlamaServer; client: LlmClient } | null = null;

  const stopAll = async () => {
    const running = current;
    current = null;
    if (running) await running.server.stop();
  };

  return {
    async use(role, signal) {
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
      current = { role, server, client: new LlmClient({ baseUrl: server.baseUrl }) };
      return current.client;
    },
    stopAll,
  };
}
