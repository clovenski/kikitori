import type { GlossaryEntry } from '../../db/stage-repo';
import type { Translator } from '../../interfaces';
import { BgtError } from '../../errors';
import type { LlmChat } from '../../llm/client';
import { parseNumberedLines, parseSingleReply } from '../../llm/parse';
import { translationMessages } from '../../llm/prompts';
import type { Segment } from '../../types';

export interface BatchTranslator {
  /** Always returns `lines.length` strings; '' for a line that could not be translated. */
  translateBatch(
    lines: string[],
    glossary: GlossaryEntry[],
    context: string[],
    signal?: AbortSignal,
  ): Promise<string[]>;
}

export class HyMtTranslator implements Translator, BatchTranslator {
  private readonly batchSize: number;
  private readonly maxRetries: number;

  constructor(
    private readonly llm: LlmChat,
    opts: { batchSize?: number; maxRetries?: number } = {},
  ) {
    this.batchSize = opts.batchSize ?? 25;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  async translateBatch(
    lines: string[],
    glossary: GlossaryEntry[],
    context: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const reply = await this.llm.chat(translationMessages({ lines, glossary, context }), { signal });
        const parsed = parseNumberedLines(reply, lines.length);
        if (parsed) return parsed;
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (!(err instanceof BgtError)) throw err;
      }
      if (signal?.aborted) throw signal.reason;
    }

    // The model keeps breaking the numbering: translate each line on its own so lines never shift.
    const out: string[] = [];
    for (const line of lines) {
      signal?.throwIfAborted();
      try {
        const reply = await this.llm.chat(translationMessages({ lines: [line], glossary, context }), { signal });
        out.push(parseNumberedLines(reply, 1)?.[0] ?? parseSingleReply(reply) ?? '');
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (!(err instanceof BgtError)) throw err;
        out.push('');
      }
    }
    return out;
  }

  async translate(segments: Segment[], glossary: Record<string, string>): Promise<Segment[]> {
    const entries: GlossaryEntry[] = Object.entries(glossary).map(([ja, en]) => ({ ja, en, source: 'user' }));
    const out: Segment[] = [];
    for (let i = 0; i < segments.length; i += this.batchSize) {
      const batch = segments.slice(i, i + this.batchSize);
      const context = out.slice(-3).map((s) => s.text).filter((t) => t !== '');
      const translated = await this.translateBatch(
        batch.map((s) => s.text),
        entries,
        context,
      );
      batch.forEach((s, k) => out.push({ ...s, text: translated[k] ?? '' }));
    }
    return out;
  }
}
