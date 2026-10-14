import type { GlossaryEntry } from '../db/stage-repo';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function relevantGlossary(glossary: GlossaryEntry[], lines: string[]): GlossaryEntry[] {
  const haystack = lines.join('\n');
  return glossary.filter((g) => haystack.includes(g.ja));
}

export function translationMessages(a: {
  lines: string[];
  glossary: GlossaryEntry[];
  context: string[];
}): ChatMessage[] {
  const parts: string[] = [];
  const terms = relevantGlossary(a.glossary, a.lines);
  if (terms.length > 0) {
    parts.push(
      `Reference the following translations:\n${terms.map((t) => `${t.ja} translates to ${t.en}`).join('\n')}`,
    );
  }
  if (a.context.length > 0) {
    parts.push(
      `For context, the preceding subtitle lines were translated as follows (do not repeat them):\n${a.context.join('\n')}`,
    );
  }
  parts.push(
    'Translate the following Japanese subtitle lines into English. Note that you must ONLY output the translated result without any additional explanation. ' +
      'Output exactly one line per input line and keep each [n] marker unchanged at the start of its line:\n\n' +
      a.lines.map((line, i) => `[${i + 1}] ${line}`).join('\n'),
  );
  return [{ role: 'user', content: parts.join('\n\n') }];
}

export function glossaryMessages(text: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content:
        'Below is a transcript of a Japanese YouTube video or livestream. Build a glossary of NAMES for a subtitle translator.\n' +
        'List only: people and nicknames (type "person"), channel/account/group names (type "handle"), brand and product names (type "brand"), ' +
        'game or show titles (type "game"), and place names (type "place").\n' +
        'Do NOT list ordinary words, even if written in katakana (eyeshadow, glitter, spot, foundation, palette, subscribe, soy sauce), ' +
        'numbers, shade or product numbers, or catchphrases. If a term is an ordinary word, leave it out.\n' +
        'Each "ja" must appear exactly as written in the transcript. For "en" use the official English spelling only if you are sure; ' +
        'otherwise use Hepburn romanization.\n' +
        'Reply with ONLY a JSON array like [{"ja": "ゆりまる", "en": "Yurimaru", "type": "person"}], at most 15 items, no commentary.\n\nTranscript:\n' +
        text,
    },
  ];
}

export function windowSummaryMessages(a: {
  text: string;
  language: 'en' | 'ja';
  glossary: GlossaryEntry[];
}): ChatMessage[] {
  const source = a.language === 'en' ? 'translated into English' : 'in Japanese';
  const names = relevantGlossary(a.glossary, [a.text]);
  const nameBlock =
    names.length > 0 ? `\nUse these English names: ${names.map((g) => `${g.ja} = ${g.en}`).join('; ')}.` : '';
  return [
    {
      role: 'user',
      content:
        `Below is a stretch of a Japanese YouTube video or livestream, ${source}, one line per spoken segment with its timestamp. ` +
        `Write 2 to 4 bullet points in English summarizing what happens, so a viewer can decide whether to watch it. ` +
        `Start each bullet with "- [h:mm:ss] " using the timestamp of the moment it describes. Be concrete, no preamble.${nameBlock}\n\n${a.text}`,
    },
  ];
}

export function rollupMessages(a: { kind: 'section' | 'overview'; items: string }): ChatMessage[] {
  const instruction =
    a.kind === 'section'
      ? 'Merge the following bullet summaries into 3 to 5 bullets in the same format ("- [h:mm:ss] text"), keeping the timestamps. No preamble.'
      : 'Write a 2 to 4 sentence overview in English of the whole video from the following summaries. Output only the overview.';
  return [{ role: 'user', content: `${instruction}\n\n${a.items}` }];
}
