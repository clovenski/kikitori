import { describe, expect, it } from 'vitest';
import { splitTimestamps } from '../../src/app/renderer/lib/summary';

describe('splitTimestamps', () => {
  it('splits text around [h:mm:ss] and [m:ss] timestamps with their millisecond values', () => {
    expect(splitTimestamps('- [0:01:05] Intro and [12:30] more [1:02:03] end')).toEqual([
      { text: '- ' },
      { ts: '0:01:05', ms: 65_000 },
      { text: ' Intro and ' },
      { ts: '12:30', ms: 750_000 },
      { text: ' more ' },
      { ts: '1:02:03', ms: 3_723_000 },
      { text: ' end' },
    ]);
  });

  it('returns the whole text when there is no timestamp, and ignores look-alikes', () => {
    expect(splitTimestamps('plain')).toEqual([{ text: 'plain' }]);
    expect(splitTimestamps('[abc] [1:2] [99]')).toEqual([{ text: '[abc] [1:2] [99]' }]);
    expect(splitTimestamps('')).toEqual([]);
  });
});
