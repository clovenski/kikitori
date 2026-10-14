import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPerfStore, estimateSeconds, formatDuration } from '../../src/core/pipeline/estimate';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-perf-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('estimateSeconds', () => {
  it('divides audio length by the speed factor, rounding up', () => {
    expect(estimateSeconds(600_000, 10)).toBe(60);
    expect(estimateSeconds(601_000, 10)).toBe(61);
  });
  it('returns null without a usable speed factor', () => {
    expect(estimateSeconds(600_000, null)).toBeNull();
    expect(estimateSeconds(600_000, 0)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(3720)).toBe('1h 02m');
  });
});

describe('createPerfStore', () => {
  it('round-trips a speed factor and tolerates a missing or corrupt file', () => {
    const file = path.join(dir, 'sub', 'perf.json');
    const store = createPerfStore(file);
    expect(store.read()).toBeNull();
    store.write(12.5);
    expect(createPerfStore(file).read()).toBe(12.5);
    writeFileSync(file, '{not json');
    expect(store.read()).toBeNull();
  });
});
