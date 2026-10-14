import type { SummaryRow } from '../db/stage-repo';
import { formatClock } from '../time';

const heading = (r: SummaryRow) => `### ${formatClock(r.startMs)} to ${formatClock(r.endMs)}`;

export function toSummaryMarkdown(rows: SummaryRow[]): string {
  if (rows.length === 0) return '';
  const of = (level: SummaryRow['level']) => rows.filter((r) => r.level === level).sort((a, b) => a.idx - b.idx);
  const parts = ['# Summary'];
  const overview = of('overview')[0];
  if (overview) parts.push(`## Overview\n\n${overview.text.trim()}`);
  const sections = of('section');
  if (sections.length > 0) {
    parts.push(`## Sections\n\n${sections.map((r) => `${heading(r)}\n\n${r.text.trim()}`).join('\n\n')}`);
  }
  const windows = of('window');
  if (windows.length > 0) {
    parts.push(`## Timeline\n\n${windows.map((r) => `${heading(r)}\n\n${r.text.trim()}`).join('\n\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}
