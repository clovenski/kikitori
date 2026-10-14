import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BgtError } from '../../errors';
import type { Transcriber, TranscribeOptions } from '../../interfaces';
import { runProcess } from '../../tools/process';
import type { Segment } from '../../types';

export function buildWhisperArgs(a: {
  modelPath: string;
  audioPath: string;
  outPrefix: string;
  language: string;
  vadModelPath: string | null;
  threads?: number;
}): string[] {
  const args = ['-m', a.modelPath, '-f', a.audioPath, '-l', a.language, '-ojf', '-of', a.outPrefix];
  if (a.vadModelPath) args.push('--vad', '--vad-model', a.vadModelPath);
  if (a.threads) args.push('-t', String(a.threads));
  return args;
}

interface WhisperToken {
  text: string;
  p?: number;
}
interface WhisperEntry {
  offsets: { from: number; to: number };
  text: string;
  tokens?: WhisperToken[];
}
interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperEntry[];
}

const SPECIAL_TOKEN = /^\[_.*_\]$/;

function avgLogprob(tokens: WhisperToken[] | undefined): number | null {
  const probs = (tokens ?? [])
    .filter((t) => !SPECIAL_TOKEN.test(t.text) && typeof t.p === 'number')
    .map((t) => Math.log(Math.max(t.p as number, 1e-9)));
  if (probs.length === 0) return null;
  return probs.reduce((sum, v) => sum + v, 0) / probs.length;
}

export function parseWhisperJson(raw: string, fallbackLang: string): Segment[] {
  let data: WhisperJson;
  try {
    data = JSON.parse(raw) as WhisperJson;
  } catch (cause) {
    throw new BgtError('TranscribeFailed', 'whisper-cli produced invalid JSON output.', { cause });
  }
  const lang = data.result?.language ?? fallbackLang;
  return (data.transcription ?? []).map((entry) => ({
    startMs: entry.offsets.from,
    endMs: entry.offsets.to,
    text: entry.text.trim(),
    lang,
    avgLogprob: avgLogprob(entry.tokens),
  }));
}

export interface WhisperCppConfig {
  whisperPath: string;
  modelPath: string;
  vadModelPath: string | null;
  threads?: number;
}

const tail = (text: string, lines = 8) => text.trim().split(/\r?\n/).slice(-lines).join('\n');

export class WhisperCppTranscriber implements Transcriber {
  constructor(private readonly cfg: WhisperCppConfig) {}

  async transcribe(audioPath: string, opts: TranscribeOptions): Promise<Segment[]> {
    const base = path.basename(audioPath, path.extname(audioPath));
    const outPrefix = path.join(path.dirname(audioPath), `${base}.whisper`);
    const jsonPath = `${outPrefix}.json`;
    rmSync(jsonPath, { force: true });

    const result = await runProcess(
      this.cfg.whisperPath,
      buildWhisperArgs({
        modelPath: this.cfg.modelPath,
        audioPath,
        outPrefix,
        language: opts.language,
        vadModelPath: this.cfg.vadModelPath,
        threads: this.cfg.threads,
      }),
      { signal: opts.signal },
    );
    if (result.code !== 0) {
      throw new BgtError(
        'TranscribeFailed',
        `whisper-cli exited with code ${result.code}:\n${tail(result.stderr)}`,
      );
    }
    if (!existsSync(jsonPath)) {
      throw new BgtError('TranscribeFailed', `whisper-cli produced no output file at ${jsonPath}.`);
    }
    return parseWhisperJson(readFileSync(jsonPath, 'utf8'), opts.language);
  }
}
