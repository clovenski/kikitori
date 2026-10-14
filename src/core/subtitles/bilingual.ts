import { toSrt } from './srt';

export function toBilingualSrt(
  rows: { startMs: number; endMs: number; en: string; ja: string }[],
): string {
  return toSrt(
    rows.map((r) => ({
      startMs: r.startMs,
      endMs: r.endMs,
      text: r.en.trim() === '' ? r.ja : `${r.en.trim()}\n${r.ja}`,
    })),
  );
}
