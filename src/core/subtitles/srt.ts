const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(total % 1000, 3)}`;
}

export function toSrt(segments: { startMs: number; endMs: number; text: string }[]): string {
  return segments
    .map((seg, i) => {
      const text = seg.text.trim().replace(/\n{2,}/g, '\n');
      return `${i + 1}\n${srtTime(seg.startMs)} --> ${srtTime(seg.endMs)}\n${text}\n`;
    })
    .join('\n');
}
