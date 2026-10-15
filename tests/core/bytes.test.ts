import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../src/core/bytes';

describe('formatBytes', () => {
  it('uses decimal units like the download pages do', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(500_000)).toBe('<1 MB');
    expect(formatBytes(547_000_000)).toBe('547 MB');
    expect(formatBytes(4_680_000_000)).toBe('4.7 GB');
    expect(formatBytes(999_400_000)).toBe('999 MB');
  });
});
