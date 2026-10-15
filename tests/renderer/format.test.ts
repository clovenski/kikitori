import { describe, expect, it } from 'vitest';
import { formatClock, formatEta, formatRemaining, jobStatusLabel, progressPercent, stageLabel, stateLabel, timeAgo } from '../../src/app/renderer/lib/format';

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

  it('labels job statuses for people', () => {
    expect(jobStatusLabel('pending')).toBe('Not finished');
    expect(jobStatusLabel('running')).toBe('Running');
    expect(jobStatusLabel('failed')).toBe('Failed');
  });

  it('computes a bounded percentage', () => {
    expect(progressPercent({ stage: 'transcribe', done: 1, total: 4, message: '' })).toBe(25);
    expect(progressPercent({ stage: 'transcribe', done: 0, total: 0, message: '' })).toBe(0);
    expect(progressPercent({ stage: 'transcribe', done: 9, total: 4, message: '' })).toBe(100);
  });
});

describe('formatRemaining', () => {
  it('says so when the speed is not known yet', () => {
    expect(formatRemaining(null)).toBe('estimating');
    expect(formatRemaining(20)).toBe('under a minute');
    expect(formatRemaining(100)).toBe('about 2 min');
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  it('says how long ago in the largest sensible unit', () => {
    expect(timeAgo('2026-01-01T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-01-01T11:55:00Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-01-01T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2025-12-29T12:00:00Z', now)).toBe('3 d ago');
    expect(timeAgo('not a date', now)).toBe('a while ago');
  });
});
