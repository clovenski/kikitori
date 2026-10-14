export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}

function stripFences(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*```/.test(line))
    .join('\n');
}

export function parseNumberedLines(reply: string, expected: number): string[] | null {
  const text = stripFences(stripThinking(reply));
  const found = new Map<number, string>();
  let current: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*\[(\d+)\]\s*(.*)$/.exec(raw);
    if (m) {
      current = Number(m[1]);
      if (found.has(current)) return null;
      found.set(current, m[2].trim());
    } else if (current !== null && raw.trim() !== '') {
      found.set(current, `${found.get(current)} ${raw.trim()}`.trim());
    }
  }
  if (found.size !== expected) return null;
  const out: string[] = [];
  for (let i = 1; i <= expected; i++) {
    const value = found.get(i);
    if (value === undefined) return null;
    out.push(value);
  }
  return out;
}

export interface GlossaryItem {
  ja: string;
  en: string;
}

export function parseGlossaryJson(reply: string): GlossaryItem[] {
  const text = stripFences(stripThinking(reply));
  const start = text.search(/[[{]/);
  if (start < 0) return [];
  const close = text[start] === '[' ? ']' : '}';
  const end = text.lastIndexOf(close);
  if (end < start) return [];

  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  const pairs: [unknown, unknown][] = Array.isArray(data)
    ? data.map((item) => [(item as { ja?: unknown })?.ja, (item as { en?: unknown })?.en])
    : data && typeof data === 'object'
      ? Object.entries(data as Record<string, unknown>)
      : [];

  const seen = new Set<string>();
  const out: GlossaryItem[] = [];
  for (const [rawJa, rawEn] of pairs) {
    if (typeof rawJa !== 'string' || typeof rawEn !== 'string') continue;
    const ja = rawJa.trim();
    const en = rawEn.trim();
    if (ja.length < 1 || ja.length > 30 || en.length < 1 || en.length > 80 || ja === en) continue;
    if (seen.has(ja)) continue;
    seen.add(ja);
    out.push({ ja, en });
  }
  return out;
}

/** For a line translated on its own: the model sometimes drops the `[1]` marker. Accepts one non-empty line. */
export function parseSingleReply(reply: string): string | null {
  const lines = stripFences(stripThinking(reply))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length !== 1) return null;
  const text = lines[0].replace(/^\[\d+\]\s*/, '').trim();
  return text === '' ? null : text;
}
