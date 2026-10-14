import { describe, expect, it } from 'vitest';
import { parseEstimateArgs, parseId, parseSource, parseSubmitRequest } from '../../src/app/main/validate';

const good = {
  source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
  startMs: 0,
  endMs: 60_000,
  options: { translate: true, summarize: true, skim: false, maxMinutes: 30, model: 'large-v3' },
};

const bad = (raw: unknown, text: RegExp) =>
  expect(() => parseSubmitRequest(raw)).toThrow(expect.objectContaining({ code: 'InvalidInput', message: expect.stringMatching(text) }));

describe('parseSubmitRequest', () => {
  it('accepts a valid request and fills defaults', () => {
    expect(parseSubmitRequest(good)).toEqual(good);
    expect(parseSubmitRequest({ ...good, endMs: null, options: { translate: false, summarize: false, skim: false } })).toMatchObject({
      endMs: null,
      options: { maxMinutes: 30, model: 'large-v3' },
    });
  });

  it('trims the source and keeps a glossary path', () => {
    const r = parseSubmitRequest({ ...good, source: '  C:/a/b.wav ', options: { ...good.options, glossaryPath: 'C:/g.json' } });
    expect(r.source).toBe('C:/a/b.wav');
    expect(r.options.glossaryPath).toBe('C:/g.json');
  });

  it.each([
    ['not an object', 42, /request/i],
    ['empty source', { ...good, source: '   ' }, /source/i],
    ['non-string source', { ...good, source: 5 }, /source/i],
    ['negative start', { ...good, startMs: -1 }, /start/i],
    ['fractional start', { ...good, startMs: 1.5 }, /start/i],
    ['end before start', { ...good, startMs: 5000, endMs: 5000 }, /end/i],
    ['missing options', { ...good, options: undefined }, /options/i],
    ['skim with translate', { ...good, options: { ...good.options, skim: true, translate: true } }, /skim/i],
    ['bad model name', { ...good, options: { ...good.options, model: '../evil' } }, /model/i],
    ['absurd cap', { ...good, options: { ...good.options, maxMinutes: 100000 } }, /maxMinutes/i],
  ])('rejects %s', (_name, raw, text) => bad(raw, text));
});

describe('small parsers', () => {
  it('parseId accepts positive integers only', () => {
    expect(parseId(7, 'job id')).toBe(7);
    for (const v of [0, -1, 1.5, '3', null, NaN]) {
      expect(() => parseId(v, 'job id')).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    }
  });

  it('parseSource trims and rejects blanks', () => {
    expect(parseSource(' x ')).toBe('x');
    expect(() => parseSource('')).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
  });

  it('parseEstimateArgs validates the numbers', () => {
    expect(parseEstimateArgs({ durationMs: 600_000, startMs: 0, endMs: null })).toEqual({ durationMs: 600_000, startMs: 0, endMs: null });
    expect(() => parseEstimateArgs({ durationMs: 0, startMs: 0, endMs: null })).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    expect(() => parseEstimateArgs('x')).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
  });
});
