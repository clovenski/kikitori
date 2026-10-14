import { readFileSync } from 'node:fs';
import { BgtError } from '../errors';

export function loadGlossaryFile(file: string): Record<string, string> {
  const bad = (why: string) => new BgtError('InvalidInput', `Glossary file "${file}": ${why}`);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw bad('cannot be read.');
  }
  let data: unknown;
  try {
    // Notepad and PowerShell 5.1 save UTF-8 files with a byte-order mark; JSON.parse rejects it.
    data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    throw bad('is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw bad('must be a JSON object mapping Japanese terms to English.');
  }
  const out: Record<string, string> = {};
  for (const [ja, en] of Object.entries(data)) {
    if (typeof en !== 'string') throw bad(`the value for "${ja}" must be a string.`);
    out[ja] = en;
  }
  return out;
}
