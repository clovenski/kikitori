import type { GlossaryItem } from './parse';

/**
 * Only names the model labels as one of these are trusted. Brands and games are left out on purpose:
 * the model tends to label ordinary words (glitter, eyeliner) with those, and forcing a wrong rendering
 * on the translator is worse than leaving a brand name to the translator.
 */
const NAME_TYPES = new Set(['person', 'handle', 'place']);

const countOccurrences = (haystack: string, needle: string) =>
  needle === '' ? 0 : haystack.split(needle).length - 1;

/**
 * Keeps glossary proposals that are typed as names AND occur at least `minOccurrences` times in the
 * transcript. A glossary exists for consistency across lines, so a one-off mention needs no entry, and
 * a term that is not literally in the transcript was invented by the model. The first proposal for a
 * term wins.
 */
export function selectGlossaryItems(
  items: GlossaryItem[],
  transcript: string,
  opts: { minOccurrences?: number } = {},
): GlossaryItem[] {
  const min = opts.minOccurrences ?? 2;
  const seen = new Set<string>();
  const out: GlossaryItem[] = [];
  for (const item of items) {
    if (seen.has(item.ja)) continue;
    if (!item.type || !NAME_TYPES.has(item.type)) continue;
    if (countOccurrences(transcript, item.ja) < min) continue;
    seen.add(item.ja);
    out.push(item);
  }
  return out;
}
