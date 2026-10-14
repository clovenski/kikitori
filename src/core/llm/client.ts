import { setTimeout as sleep } from 'node:timers/promises';
import { BgtError } from '../errors';
import { stripThinking } from './parse';
import type { ChatMessage } from './prompts';

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmChat {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

export interface LlmClientConfig {
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

export class LlmClient implements LlmChat {
  constructor(private readonly cfg: LlmClientConfig) {}

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const retries = this.cfg.retries ?? 2;
    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      opts.signal?.throwIfAborted();
      try {
        const signals = [AbortSignal.timeout(this.cfg.timeoutMs ?? 300_000)];
        if (opts.signal) signals.push(opts.signal);
        const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.cfg.model ?? 'local',
            messages,
            temperature: opts.temperature ?? 0.2,
            max_tokens: opts.maxTokens ?? 2048,
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.any(signals),
        });
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          const body = (await res.text()).slice(0, 300);
          throw new BgtError('LlmFailed', `The LLM server rejected the request (HTTP ${res.status}): ${body}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('the response had no message content');
        return stripThinking(content);
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (err instanceof BgtError) throw err;
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < retries) await sleep((this.cfg.backoffMs ?? 500) * (attempt + 1));
      }
    }
    throw new BgtError('LlmFailed', `The LLM request failed after ${retries + 1} attempts: ${lastError}`);
  }
}
