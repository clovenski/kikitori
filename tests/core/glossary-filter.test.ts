import { describe, expect, it } from 'vitest';
import { selectGlossaryItems } from '../../src/core/llm/glossary-filter';

const text = 'ゆりまるです\nゆりまるは運動会に出る\nラメを塗る\nラメが好き\nディオールを買った\n東京に行く\n東京は広い';

const item = (ja: string, type: string | undefined, en = 'x') => ({ ja, en, type });

describe('selectGlossaryItems', () => {
  it('keeps people, handles and places that recur in the transcript', () => {
    const out = selectGlossaryItems(
      [item('ゆりまる', 'person', 'Yurimaru'), item('東京', 'place', 'Tokyo')],
      text,
    );
    expect(out.map((i) => i.ja)).toEqual(['ゆりまる', '東京']);
  });

  it('drops brands, games and any other type, even when they recur', () => {
    const out = selectGlossaryItems([item('ラメ', 'brand', 'Lame'), item('ラメ', 'game'), item('ラメ', 'other')], text);
    expect(out).toEqual([]);
  });

  it('drops items without a type', () => {
    expect(selectGlossaryItems([item('ゆりまる', undefined)], text)).toEqual([]);
  });

  it('drops terms that occur only once or not at all (including invented ones)', () => {
    const out = selectGlossaryItems(
      [item('ディオール', 'person'), item('存在しない人', 'person')],
      text,
    );
    expect(out).toEqual([]);
  });

  it('counts non-overlapping occurrences and keeps the first proposal for a repeated term', () => {
    const out = selectGlossaryItems(
      [item('ゆりまる', 'person', 'Yurimaru'), item('ゆりまる', 'person', 'Yuri-maru')],
      text,
    );
    expect(out).toEqual([item('ゆりまる', 'person', 'Yurimaru')]);
  });

  it('honours a custom minimum', () => {
    expect(selectGlossaryItems([item('ディオール', 'person')], text, { minOccurrences: 1 })).toHaveLength(1);
  });
});
