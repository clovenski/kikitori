import { BgtError } from './errors';

export function parseTimestamp(input: string): number {
  const text = input.trim();
  const bad = () =>
    new BgtError(
      'InvalidInput',
      `Invalid time "${input}". Use seconds, M:SS or H:MM:SS (optionally with .mmm).`,
    );

  const dotParts = text.split('.');
  if (dotParts.length > 2) throw bad();
  const [main, frac = ''] = dotParts;
  if (!/^\d+(:\d+){0,2}$/.test(main) || !/^\d{0,3}$/.test(frac)) throw bad();
  if (dotParts.length === 2 && frac === '') throw bad();

  const parts = main.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) throw bad();
  const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
  return seconds * 1000 + Number(frac.padEnd(3, '0'));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function split(ms: number) {
  const total = Math.max(0, Math.round(ms));
  return {
    h: Math.floor(total / 3_600_000),
    m: Math.floor((total % 3_600_000) / 60_000),
    s: Math.floor((total % 60_000) / 1000),
    milli: total % 1000,
  };
}

export function formatClock(ms: number): string {
  const { h, m, s } = split(ms);
  return `${h}:${pad2(m)}:${pad2(s)}`;
}

export function formatClockMs(ms: number): string {
  const { milli } = split(ms);
  return `${formatClock(ms)}.${String(milli).padStart(3, '0')}`;
}

export interface RangeInput {
  startMs: number;
  endMs: number | null;
  durationMs: number;
  maxMinutes: number;
}

export function resolveRange(input: RangeInput): { startMs: number; endMs: number } {
  const { startMs, durationMs, maxMinutes } = input;
  if (startMs >= durationMs) {
    throw new BgtError(
      'InvalidInput',
      `Start (${formatClock(startMs)}) is at or beyond the end of the video (${formatClock(durationMs)}).`,
    );
  }
  const endMs = Math.min(input.endMs ?? durationMs, durationMs);
  if (endMs <= startMs) {
    throw new BgtError(
      'InvalidInput',
      `End (${formatClock(endMs)}) must be after start (${formatClock(startMs)}).`,
    );
  }
  if (endMs - startMs > maxMinutes * 60_000) {
    throw new BgtError(
      'OverCap',
      `Requested ${Math.round((endMs - startMs) / 60_000)} min exceeds the ${maxMinutes} min limit. ` +
        `Pick a smaller range with --start/--end, or raise the limit with --max-minutes.`,
    );
  }
  return { startMs, endMs };
}
