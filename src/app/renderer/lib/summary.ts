export type SummaryPart = { text: string } | { ts: string; ms: number };

const TS = /\[(\d+:\d{2}:\d{2}|\d{1,3}:\d{2})\]/g;

function toMs(ts: string): number {
  const parts = ts.split(':').map(Number);
  const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
  return seconds * 1000;
}

/** Splits summary text around `[h:mm:ss]` / `[m:ss]` timestamps so they can be rendered as links. */
export function splitTimestamps(text: string): SummaryPart[] {
  const out: SummaryPart[] = [];
  let last = 0;
  for (const m of text.matchAll(TS)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ text: text.slice(last, index) });
    out.push({ ts: m[1], ms: toMs(m[1]) });
    last = index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
