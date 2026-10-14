import { describe, expect, it } from 'vitest';
import { parseGlossaryJson, parseNumberedLines, parseSingleReply, stripThinking } from '../../src/core/llm/parse';

describe('stripThinking', () => {
  it('removes think blocks and an orphan closing tag', () => {
    expect(stripThinking('<think>hmm\nmore</think>\nAnswer')).toBe('Answer');
    expect(stripThinking('reasoning here</think>Answer')).toBe('Answer');
    expect(stripThinking('  plain  ')).toBe('plain');
  });
});

describe('parseNumberedLines', () => {
  it('parses one line per number', () => {
    expect(parseNumberedLines('[1] Hello\n[2] World', 2)).toEqual(['Hello', 'World']);
  });

  it('ignores think blocks and code fences', () => {
    const reply = '<think>x</think>\n```\n[1] A\n[2] B\n```';
    expect(parseNumberedLines(reply, 2)).toEqual(['A', 'B']);
  });

  it('joins continuation lines to the previous entry', () => {
    expect(parseNumberedLines('[1] First part\nsecond part\n[2] Next', 2)).toEqual([
      'First part second part',
      'Next',
    ]);
  });

  it('allows an empty translation for a number', () => {
    expect(parseNumberedLines('[1] \n[2] B', 2)).toEqual(['', 'B']);
  });

  it.each([
    ['missing a line', '[1] A', 2],
    ['an extra line', '[1] A\n[2] B\n[3] C', 2],
    ['a gap in numbering', '[1] A\n[3] C', 2],
    ['a duplicated number', '[1] A\n[1] B', 2],
    ['no markers at all', 'Just a sentence.', 1],
  ])('returns null for %s', (_name, reply, expected) => {
    expect(parseNumberedLines(reply, expected)).toBeNull();
  });
});

describe('parseGlossaryJson', () => {
  it('reads an array of pairs, even inside fences and prose', () => {
    const reply = 'Here you go:\n```json\n[{"ja":"ゆりまる","en":"Yurimaru"},{"ja":"道の駅","en":"roadside station"}]\n```';
    expect(parseGlossaryJson(reply)).toEqual([
      { ja: 'ゆりまる', en: 'Yurimaru' },
      { ja: '道の駅', en: 'roadside station' },
    ]);
  });

  it('reads an object map', () => {
    expect(parseGlossaryJson('{"運動会":"sports day"}')).toEqual([{ ja: '運動会', en: 'sports day' }]);
  });

  it('drops invalid entries and duplicates', () => {
    const reply = JSON.stringify([
      { ja: 'A', en: '' },
      { ja: '', en: 'x' },
      { ja: 'same', en: 'same' },
      { ja: 'x'.repeat(31), en: 'long' },
      { ja: 'ok', en: 'fine' },
      { ja: 'ok', en: 'again' },
      { ja: 5, en: 'num' },
    ]);
    expect(parseGlossaryJson(reply)).toEqual([{ ja: 'ok', en: 'fine' }]);
  });

  it('returns an empty list for unparseable replies', () => {
    expect(parseGlossaryJson('no json here')).toEqual([]);
    expect(parseGlossaryJson('[{"ja": "broken"')).toEqual([]);
    expect(parseGlossaryJson('<think>[1]</think>nothing')).toEqual([]);
  });
});

describe('parseSingleReply', () => {
  it('accepts a plain one-line reply or one with a leading marker', () => {
    expect(parseSingleReply('Thank you, Hige-me-chan.')).toBe('Thank you, Hige-me-chan.');
    expect(parseSingleReply('[1] Hello there')).toBe('Hello there');
    expect(parseSingleReply('<think>x</think>\n  Hi  ')).toBe('Hi');
    expect(parseSingleReply('```\n[1] In a fence\n```')).toBe('In a fence');
  });

  it('rejects empty replies and replies with several lines', () => {
    expect(parseSingleReply('')).toBeNull();
    expect(parseSingleReply('   ')).toBeNull();
    expect(parseSingleReply('[1] One\n[2] Two')).toBeNull();
    expect(parseSingleReply('First sentence.\nSecond sentence.')).toBeNull();
  });
});

describe('parseGlossaryJson types', () => {
  it('returns the type label when the model provides one', () => {
    const reply = '[{"ja":"ゆりまる","en":"Yurimaru","type":"person"},{"ja":"東京","en":"Tokyo"}]';
    expect(parseGlossaryJson(reply)).toEqual([
      { ja: 'ゆりまる', en: 'Yurimaru', type: 'person' },
      { ja: '東京', en: 'Tokyo' },
    ]);
  });
});
