import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { BgtError } from '../errors';
import { killTree } from '../tools/process';

export interface LlamaServerConfig {
  serverPath: string;
  modelPath: string;
  contextSize?: number;
  gpuLayers?: number;
  startupTimeoutMs?: number;
  /** Arguments placed before the server flags (tests run a node script as the "server"). */
  argsPrefix?: string[];
}

export function buildServerArgs(cfg: LlamaServerConfig, port: number): string[] {
  return [
    ...(cfg.argsPrefix ?? []),
    '-m',
    cfg.modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-c',
    String(cfg.contextSize ?? 4096),
    '-ngl',
    String(cfg.gpuLayers ?? 99),
  ];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const tailLines = (text: string, n = 12) => text.trim().split(/\r?\n/).slice(-n).join('\n');

export class LlamaServer {
  private constructor(
    readonly baseUrl: string,
    private readonly child: ChildProcess,
  ) {}

  static async start(cfg: LlamaServerConfig, signal?: AbortSignal): Promise<LlamaServer> {
    const port = await freePort();
    const child = spawn(cfg.serverPath, buildServerArgs(cfg, port), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (d: string) => {
      output = (output + d).slice(-8000);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let exited = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    child.on('exit', () => (exited = true));
    child.on('error', (err: NodeJS.ErrnoException) => (spawnError = err));

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (cfg.startupTimeoutMs ?? 120_000);
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (spawnError) {
          throw new BgtError(
            spawnError.code === 'ENOENT' ? 'ToolMissing' : 'LlmServerFailed',
            `Cannot start llama-server at "${cfg.serverPath}": ${spawnError.message}`,
          );
        }
        if (exited) {
          throw new BgtError('LlmServerFailed', `llama-server exited during startup:\n${tailLines(output)}`);
        }
        if (Date.now() > deadline) {
          throw new BgtError(
            'LlmServerFailed',
            `llama-server did not become ready within ${(cfg.startupTimeoutMs ?? 120_000) / 1000}s:\n${tailLines(output)}`,
          );
        }
        try {
          const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
          if (res.ok) break;
        } catch {
          /* not listening yet */
        }
        await sleep(150);
      }
    } catch (err) {
      await killTree(child);
      throw err;
    }
    return new LlamaServer(baseUrl, child);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => this.child.once('close', () => resolve()));
    await killTree(this.child);
    await Promise.race([closed, sleep(5000)]);
  }
}
