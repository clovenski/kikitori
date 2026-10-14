import { describe, expect, it } from 'vitest';
import { isUrl } from '../../src/core/pipeline/real-deps';

describe('isUrl', () => {
  it('detects http(s) URLs and treats everything else as a local path', () => {
    expect(isUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isUrl('http://youtu.be/abc')).toBe(true);
    expect(isUrl('C:\\videos\\テスト 音声.wav')).toBe(false);
    expect(isUrl('./clip.mp4')).toBe(false);
  });
});
