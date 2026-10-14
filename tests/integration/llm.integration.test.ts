import { describe, expect, it } from 'vitest';
import { HyMtTranslator } from '../../src/core/backends/translate/hymt';
import { createRealModelPool } from '../../src/core/pipeline/real-llm';
import { parseGlossaryJson } from '../../src/core/llm/parse';
import { glossaryMessages } from '../../src/core/llm/prompts';

// Opt in with BGT_INTEGRATION=1. Requires `pnpm setup:tools` (about 10 GB of models).
describe.skipIf(!process.env.BGT_INTEGRATION)('real llama-server', () => {
  it('translates Japanese lines with Hy-MT2 and extracts glossary JSON with the general model', async () => {
    const pool = createRealModelPool({ log: () => {} });
    try {
      const translate = await pool.use('translate');
      const out = await new HyMtTranslator(translate).translateBatch(
        ['こんにちは、ゆりまるです', '今日は運動会の話をします', 'ありがとうございました'],
        [{ ja: 'ゆりまる', en: 'Yurimaru', source: 'user' }],
        [],
      );
      expect(out).toHaveLength(3);
      expect(out.every((line) => /[A-Za-z]/.test(line))).toBe(true);
      expect(out[0]).toContain('Yurimaru');

      const general = await pool.use('general');
      const reply = await general.chat(glossaryMessages('ゆりまるです。道の駅キラリアサヒでシャインマスカットを買いました。ゆりまるは運動会に出ます。'));
      expect(parseGlossaryJson(reply).length).toBeGreaterThan(0);
    } finally {
      await pool.stopAll();
    }
  }, 600_000);
});

