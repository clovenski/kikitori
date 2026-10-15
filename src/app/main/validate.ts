import type { SubmissionOptions } from '../../core/db/submission-repo';
import { BgtError } from '../../core/errors';
import { cleanSource } from '../../core/source-text';
import type { SetupSelection, SubmitRequest } from '../shared/ipc';

const invalid = (message: string) => new BgtError('InvalidInput', message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function parseSource(raw: unknown): string {
  const source = typeof raw === 'string' ? cleanSource(raw) : '';
  if (source === '') throw invalid('Enter a YouTube URL or choose a file (source is empty).');
  return source;
}

export function parseId(raw: unknown, what: string): number {
  if (!isInt(raw) || raw < 1) throw invalid(`Invalid ${what}.`);
  return raw;
}

export function parseEstimateArgs(raw: unknown): { durationMs: number; startMs: number; endMs: number | null } {
  if (!isObject(raw)) throw invalid('Invalid estimate request.');
  const { durationMs, startMs, endMs } = raw;
  if (!isInt(durationMs) || durationMs < 1) throw invalid('Invalid duration.');
  if (!isInt(startMs) || startMs < 0) throw invalid('Invalid start time.');
  if (endMs !== null && !isInt(endMs)) throw invalid('Invalid end time.');
  return { durationMs, startMs, endMs: endMs as number | null };
}

export function parseSubmissionOptions(raw: unknown): SubmissionOptions {
  if (!isObject(raw)) throw invalid('Missing options.');
  const o = raw;
  const translate = o.translate === true;
  const summarize = o.summarize === true;
  const skim = o.skim === true;
  if (skim && translate) throw invalid('Skim skips full translation, so it cannot be combined with Translate.');
  const maxMinutes = o.maxMinutes === undefined ? 30 : o.maxMinutes;
  if (typeof maxMinutes !== 'number' || !Number.isFinite(maxMinutes) || maxMinutes < 1 || maxMinutes > 600) {
    throw invalid('maxMinutes must be between 1 and 600.');
  }
  const model = o.model === undefined ? 'large-v3' : o.model;
  if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(model)) throw invalid('Invalid model name.');
  const options: SubmissionOptions = { translate, summarize, skim, maxMinutes, model };
  if (typeof o.glossaryPath === 'string' && o.glossaryPath.trim() !== '') options.glossaryPath = o.glossaryPath.trim();
  return options;
}

export function parseSubmitRequest(raw: unknown): SubmitRequest {
  if (!isObject(raw)) throw invalid('Invalid request.');
  const source = parseSource(raw.source);
  const { startMs, endMs } = raw;
  if (!isInt(startMs) || startMs < 0) throw invalid('Start time must be a non-negative whole number of milliseconds.');
  if (endMs !== null && endMs !== undefined && (!isInt(endMs) || endMs <= startMs)) {
    throw invalid('End time must be after the start time.');
  }
  const options = parseSubmissionOptions(raw.options);
  return { source, startMs, endMs: endMs === undefined ? null : (endMs as number | null), options };
}

export function parseSetupSelection(raw: unknown): SetupSelection {
  if (!isObject(raw)) throw invalid('Invalid setup request.');
  const { tier, features } = raw;
  if (tier !== 'gpu' && tier !== 'cpu') throw invalid('Invalid hardware tier.');
  if (!isObject(features) || typeof features.translation !== 'boolean' || typeof features.summaries !== 'boolean') {
    throw invalid('Invalid feature selection.');
  }
  return { tier, features: { translation: features.translation, summaries: features.summaries } };
}
