import { formatClock } from '../time';

export interface TextSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SummaryWindow {
  idx: number;
  startMs: number;
  endMs: number;
  segments: TextSegment[];
}

export function splitWindows(segments: TextSegment[], windowMs = 300_000): SummaryWindow[] {
  const groups = new Map<number, TextSegment[]>();
  for (const seg of segments) {
    const key = Math.floor(seg.startMs / windowMs);
    const group = groups.get(key);
    if (group) group.push(seg);
    else groups.set(key, [seg]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, segs], idx) => ({
      idx,
      startMs: segs[0].startMs,
      endMs: segs.reduce((max, s) => Math.max(max, s.endMs), 0),
      segments: segs,
    }));
}

export function renderWindow(w: SummaryWindow, offsetMs: number): string {
  return w.segments.map((s) => `[${formatClock(s.startMs + offsetMs)}] ${s.text}`).join('\n');
}
