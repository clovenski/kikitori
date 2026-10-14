import { describe, expect, it } from 'vitest';
import { parseYoutubeId } from '../../src/core/youtube';

describe('parseYoutubeId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://www.youtube.com/watch?v=7SHNxjFuw10&list=PLxyz&index=4', '7SHNxjFuw10'],
    ['https://youtube.com/watch?feature=share&v=QGWaK-UF5QU', 'QGWaK-UF5QU'],
    ['https://m.youtube.com/watch?v=7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://music.youtube.com/watch?v=7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://youtu.be/7SHNxjFuw10?t=10', '7SHNxjFuw10'],
    ['https://www.youtube.com/shorts/7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://www.youtube.com/embed/7SHNxjFuw10', '7SHNxjFuw10'],
    ['https://www.youtube.com/live/7SHNxjFuw10?si=x', '7SHNxjFuw10'],
    ['https://www.youtube-nocookie.com/embed/7SHNxjFuw10', '7SHNxjFuw10'],
  ])('extracts the id from %s', (url, id) => {
    expect(parseYoutubeId(url)).toBe(id);
  });

  it.each([
    'https://example.com/watch?v=7SHNxjFuw10',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/playlist?list=PLxyz',
    'https://youtu.be/',
    'C:\\videos\\clip.mp4',
    'not a url',
    '',
  ])('returns null for %j', (input) => {
    expect(parseYoutubeId(input)).toBeNull();
  });
});
