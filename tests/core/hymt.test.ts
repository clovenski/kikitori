import { describe, expect, it } from 'vitest';
import { HyMtTranslator } from '../../src/core/backends/translate/hymt';
import { BgtError } from '../../src/core/errors';
import { echoTranslate, scriptedChat } from '../helpers/llm-fakes';

const lines = ['一行目', '二行目', '三行目'];

describe('HyMtTranslator.translateBatch', () => {
  it('returns one translation per line from a well-formed reply', async () => {
    const llm = scriptedChat(echoTranslate());
    const out = await new HyMtTranslator(llm).translateBatch(lines, [], []);
    expect(out).toEqual(['EN:一行目', 'EN:二行目', 'EN:三行目']);
    expect(llm.calls).toHaveLength(1);
  });

  it('retries a batch whose reply has the wrong number of lines', async () => {
    const llm = scriptedChat((m, call) => (call === 1 ? '[1] only one' : echoTranslate()(m)));
    const out = await new HyMtTranslator(llm).translateBatch(lines, [], []);
    expect(out).toEqual(['EN:一行目', 'EN:二行目', 'EN:三行目']);
    expect(llm.calls).toHaveLength(2);
  });

  it('falls back to line-by-line after the retries and never misaligns lines', async () => {
    const llm = scriptedChat((m) => {
      const content = m[m.length - 1].content;
      const numbered = [...content.matchAll(/^\[(\d+)\] /gm)].length;
      return numbered > 1 ? '[1] merged everything into one line' : echoTranslate()(m);
    });
    const out = await new HyMtTranslator(llm).translateBatch(lines, [], []);
    expect(out).toEqual(['EN:一行目', 'EN:二行目', 'EN:三行目']);
    expect(llm.calls).toHaveLength(3 + 3); // 1 + 2 retries, then one call per line
  });

  it('leaves a line empty when even the single-line request fails', async () => {
    const llm = scriptedChat((m) => {
      const content = m[m.length - 1].content;
      if ([...content.matchAll(/^\[(\d+)\] /gm)].length > 1) return 'garbage';
      if (content.includes('二行目')) return new BgtError('LlmFailed', 'down');
      return echoTranslate()(m);
    });
    const out = await new HyMtTranslator(llm).translateBatch(lines, [], []);
    expect(out).toEqual(['EN:一行目', '', 'EN:三行目']);
  });

  it('accepts an unmarked one-line reply when translating a line on its own', async () => {
    const llm = scriptedChat((m) => {
      const content = m[m.length - 1].content;
      return [...content.matchAll(/^\[(\d+)\] /gm)].length > 1 ? 'garbage' : 'Plain reply without a marker.';
    });
    const out = await new HyMtTranslator(llm).translateBatch(lines, [], []);
    expect(out).toEqual(Array(3).fill('Plain reply without a marker.'));
  });

  it('puts only relevant glossary terms and the context into the prompt', async () => {
    const llm = scriptedChat(echoTranslate());
    await new HyMtTranslator(llm).translateBatch(
      ['ゆりまるです'],
      [
        { ja: 'ゆりまる', en: 'Yurimaru', source: 'auto' },
        { ja: '運動会', en: 'sports day', source: 'auto' },
      ],
      ['Earlier line.'],
    );
    const prompt = llm.calls[0][0].content;
    expect(prompt).toContain('ゆりまる translates to Yurimaru');
    expect(prompt).not.toContain('運動会');
    expect(prompt).toContain('Earlier line.');
  });

  it('stops immediately when aborted instead of falling back', async () => {
    const controller = new AbortController();
    const llm = scriptedChat(() => {
      controller.abort();
      return 'garbage';
    });
    await expect(
      new HyMtTranslator(llm).translateBatch(lines, [], [], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(llm.calls).toHaveLength(1);
  });
});

describe('HyMtTranslator.translate (Translator interface)', () => {
  it('translates segments in batches, keeping timing and passing earlier output as context', async () => {
    const llm = scriptedChat(echoTranslate());
    const translator = new HyMtTranslator(llm, { batchSize: 2 });
    const segments = ['あ', 'い', 'う'].map((text, i) => ({
      startMs: i * 1000,
      endMs: i * 1000 + 500,
      text,
      lang: 'ja',
    }));
    const out = await translator.translate(segments, { あ: 'A' });
    expect(out.map((s) => [s.startMs, s.endMs, s.text])).toEqual([
      [0, 500, 'EN:あ'],
      [1000, 1500, 'EN:い'],
      [2000, 2500, 'EN:う'],
    ]);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1][0].content).toContain('EN:い');
  });
});
