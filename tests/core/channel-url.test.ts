import { describe, expect, it } from 'vitest';
import { normalizeChannelInput } from '../../src/core/channels/channel-url';

const UC = 'UCabcdefghijklmnopqrstuv';

describe('normalizeChannelInput', () => {
  it('accepts every way of naming a channel', () => {
    expect(normalizeChannelInput('@NintendoJP')).toBe('https://www.youtube.com/@NintendoJP');
    expect(normalizeChannelInput('  https://www.youtube.com/@NintendoJP  ')).toBe('https://www.youtube.com/@NintendoJP');
    expect(normalizeChannelInput('youtube.com/@NintendoJP/videos')).toBe('https://www.youtube.com/@NintendoJP');
    expect(normalizeChannelInput('https://m.youtube.com/@NintendoJP/featured?si=x')).toBe('https://www.youtube.com/@NintendoJP');
    expect(normalizeChannelInput(UC)).toBe(`https://www.youtube.com/channel/${UC}`);
    expect(normalizeChannelInput(`https://www.youtube.com/channel/${UC}/streams`)).toBe(`https://www.youtube.com/channel/${UC}`);
    expect(normalizeChannelInput('https://www.youtube.com/c/SomeName')).toBe('https://www.youtube.com/c/SomeName');
    expect(normalizeChannelInput('https://www.youtube.com/user/some.name')).toBe('https://www.youtube.com/user/some.name');
  });

  it('keeps unicode handles, also when the URL percent-encodes them', () => {
    expect(normalizeChannelInput('@ゆりまる')).toBe('https://www.youtube.com/@ゆりまる');
    expect(normalizeChannelInput(`https://www.youtube.com/${encodeURIComponent('@ゆりまる')}/videos`)).toBe('https://www.youtube.com/@ゆりまる');
  });

  it('rejects anything that is not a channel', () => {
    for (const bad of [
      '',
      'hello',
      '@a',
      'UCshort',
      'https://www.youtube.com/watch?v=7SHNxjFuw10',
      'https://youtu.be/7SHNxjFuw10',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/shorts/7SHNxjFuw10',
      'https://www.youtube.com/results?search_query=x',
      'https://example.com/@someone',
      'C:\\videos\\clip.mp4',
    ]) {
      expect(() => normalizeChannelInput(bad), bad).toThrow(expect.objectContaining({ code: 'InvalidInput' }));
    }
  });
});
