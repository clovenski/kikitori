import { describe, expect, it } from 'vitest';
import {
  glossaryMessages,
  relevantGlossary,
  rollupMessages,
  translationMessages,
  windowSummaryMessages,
} from '../../src/core/llm/prompts';
import type { GlossaryEntry } from '../../src/core/db/stage-repo';

const glossary: GlossaryEntry[] = [
  { ja: 'ゆりまる', en: 'Yurimaru', source: 'auto' },
  { ja: '運動会', en: 'sports day', source: 'user' },
];

describe('relevantGlossary', () => {
  it('keeps only entries that occur in the given lines', () => {
    expect(relevantGlossary(glossary, ['来週の運動会', 'はい'])).toEqual([glossary[1]]);
    expect(relevantGlossary(glossary, ['はい'])).toEqual([]);
  });
});

describe('translationMessages', () => {
  it('numbers the lines, lists only relevant terms, and includes context', () => {
    const [msg] = translationMessages({
      lines: ['ゆりまるです', '運動会があります'],
      glossary,
      context: ['Previous line.'],
    });
    expect(msg.role).toBe('user');
    expect(msg.content).toContain('ゆりまる translates to Yurimaru');
    expect(msg.content).toContain('運動会 translates to sports day');
    expect(msg.content).toContain('Previous line.');
    expect(msg.content).toContain('[1] ゆりまるです\n[2] 運動会があります');
    expect(msg.content).toMatch(/ONLY output the translated result/);
  });

  it('omits the terminology and context blocks when empty', () => {
    const [msg] = translationMessages({ lines: ['はい'], glossary, context: [] });
    expect(msg.content).not.toContain('translates to');
    expect(msg.content).not.toContain('For context');
  });
});

describe('other prompts', () => {
  it('glossary prompt asks for a JSON array and embeds the text', () => {
    const [msg] = glossaryMessages('こんにちは');
    expect(msg.content).toContain('JSON array');
    expect(msg.content).toContain('こんにちは');
  });

  it('window summary prompt states the source language and timestamp format', () => {
    const [en] = windowSummaryMessages({ text: '[0:00:01] hi', language: 'en', glossary: [] });
    expect(en.content).toContain('translated into English');
    expect(en.content).toContain('- [h:mm:ss]');
    const [ja] = windowSummaryMessages({ text: '[0:00:01] ゆりまるです', language: 'ja', glossary: glossary });
    expect(ja.content).toContain('in Japanese');
    expect(ja.content).toContain('ゆりまる = Yurimaru');
  });

  it('rollup prompts differ by kind', () => {
    expect(rollupMessages({ kind: 'section', items: 'x' })[0].content).toContain('Merge');
    expect(rollupMessages({ kind: 'overview', items: 'x' })[0].content).toContain('overview');
  });
});
