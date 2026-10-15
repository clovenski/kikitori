import { existsSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../core/errors';
import { transcribeModelName } from '../core/setup/components';
import { currentTier } from '../core/setup/settings';
import { componentModelPath, loadLock } from '../core/tools/lock';
import { dataDir, findVadModel, modelPath, projectRoot, resolveTool, resourcesDir, type ToolName } from '../core/tools/paths';
import { runProcess } from '../core/tools/process';

export async function doctorCommand(): Promise<void> {
  let problems = 0;
  const tier = currentTier(dataDir());
  console.log('INFO     tier             ' + tier);
  const line = (label: string, value: string, ok: boolean) => {
    if (!ok) problems++;
    console.log(`${ok ? 'OK     ' : 'MISSING'}  ${label.padEnd(16)} ${value}`);
  };

  const resolved: Partial<Record<ToolName, string>> = {};
  for (const name of ['yt-dlp', 'ffmpeg', 'whisper-cli', 'llama-server'] as const) {
    try {
      resolved[name] = resolveTool(name);
      line(name, resolved[name] as string, true);
    } catch (err) {
      line(name, err instanceof BgtError ? err.message : String(err), false);
    }
  }

  const model = transcribeModelName(tier);
  try {
    line('model ' + model, modelPath('ggml-' + model + '.bin'), true);
  } catch (err) {
    line('model ' + model, err instanceof Error ? err.message : String(err), false);
  }
  const vad = findVadModel();
  line('VAD model', vad ?? 'not found (run "pnpm setup:tools")', vad !== null && existsSync(vad));

  try {
    const lock = loadLock(path.join(projectRoot(), 'tools.lock.json'));
    for (const id of ['model-translate-' + tier, 'model-general-' + tier]) {
      try {
        line(id, componentModelPath(lock, id, resourcesDir()), true);
      } catch (err) {
        line(id, err instanceof Error ? err.message : String(err), false);
      }
    }
  } catch {
    line('tools.lock.json', 'cannot be read (run "pnpm pin:tools")', false);
  }

  if (resolved['whisper-cli']) {
    const help = await runProcess(resolved['whisper-cli'], ['--help']);
    const hasVad = `${help.stdout}${help.stderr}`.includes('--vad');
    line('whisper VAD flag', hasVad ? '--vad supported' : 'this whisper-cli build has no --vad', hasVad);
  }

  try {
    const gpu = await runProcess('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
    console.log(`INFO     GPU              ${gpu.stdout.trim() || 'none reported'}`);
  } catch {
    console.log('INFO     GPU              nvidia-smi not available (CPU-only or non-NVIDIA)');
  }

  if (problems > 0) process.exitCode = 1;
}
