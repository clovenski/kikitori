import { describe, expect, it } from 'vitest';
import { formatClock, formatEta, progressPercent, stageLabel, stateLabel } from '../../src/app/renderer/lib/format';

describe('format helpers', () => {
  it('formats clock times', () => {
    expect(formatClock(0)).toBe('0:00:00');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });

  it('describes an estimate', () => {
    expect(formatEta(null)).toBe('unknown until a first run');
    expect(formatEta(45)).toBe('under a minute');
    expect(formatEta(300)).toBe('about 5 min');
    expect(formatEta(5400)).toBe('about 1 h 30 min');
  });

  it('labels stages and states', () => {
    expect(stageLabel('translate')).toBe('Translating');
    expect(stateLabel('interrupted')).toBe('Interrupted');
  });

  it('computes a bounded percentage', () => {
    expect(progressPercent({ stage: 'transcribe', done: 1, total: 4, message: '' })).toBe(25);
    expect(progressPercent({ stage: 'transcribe', done: 0, total: 0, message: '' })).toBe(0);
    expect(progressPercent({ stage: 'transcribe', done: 9, total: 4, message: '' })).toBe(100);
  });
});
