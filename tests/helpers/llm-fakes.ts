import type { ChatOptions, LlmChat } from '../../src/core/llm/client';
import type { ChatMessage } from '../../src/core/llm/prompts';

export type ScriptedChat = LlmChat & { calls: ChatMessage[][] };

export function scriptedChat(handler: (messages: ChatMessage[], call: number) => string | Error): ScriptedChat {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async chat(messages: ChatMessage[], opts?: ChatOptions) {
      opts?.signal?.throwIfAborted();
      calls.push(messages);
      const result = handler(messages, calls.length);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** Answers `[n] <prefix><text>` for each `[n] text` line in the last message. */
export function echoTranslate(prefix = 'EN:'): (messages: ChatMessage[]) => string {
  return (messages) => {
    const content = messages[messages.length - 1].content;
    const lines = [...content.matchAll(/^\[(\d+)\] (.*)$/gm)];
    return lines.map((m) => `[${m[1]}] ${prefix}${m[2]}`).join('\n');
  };
}
