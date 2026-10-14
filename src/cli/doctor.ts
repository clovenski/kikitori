import { existsSync } from 'node:fs';
import { BgtError } from '../core/errors';
import { findVadModel, modelPath, resolveTool, type ToolName } from '../core/tools/paths';
import { runProcess } from '../core/tools/process';

export async function doctorCommand(): Promise<void> {
  let problems = 0;
  const line = (label: string, value: string, ok: boolean) => {
    if (!ok) problems++;
    console.log(`${ok ? 'OK     ' : 'MISSING'}  ${label.padEnd(16)} ${value}`);
  };

  const resolved: Partial<Record<ToolName, string>> = {};
  for (const name of ['yt-dlp', 'ffmpeg', 'whisper-cli'] as const) {
    try {
      resolved[name] = resolveTool(name);
      line(name, resolved[name] as string, true);
    } catch (err) {
      line(name, err instanceof BgtError ? err.message : String(err), false);
    }
  }

  try {
    line('model large-v3', modelPath('ggml-large-v3.bin'), true);
  } catch (err) {
    line('model large-v3', err instanceof Error ? err.message : String(err), false);
  }
  const vad = findVadModel();
  line('VAD model', vad ?? 'not found (run "pnpm setup:tools")', vad !== null && existsSync(vad));

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
