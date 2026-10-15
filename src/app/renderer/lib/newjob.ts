import { cleanSource } from '../../../core/source-text';
import { parseTimestamp, resolveRange } from '../../../core/time';
import type { SubmitRequest } from '../../shared/ipc';

export interface NewJobForm {
  source: string;
  start: string;
  end: string;
  translate: boolean;
  summarize: boolean;
  skim: boolean;
  glossaryPath: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function buildSubmitRequest(
  form: NewJobForm,
  durationMs: number | null,
): { ok: true; request: SubmitRequest } | { ok: false; error: string } {
  const source = cleanSource(form.source);
  if (source === '') return { ok: false, error: 'Enter a YouTube URL or choose a file.' };
  if (form.skim && form.translate) {
    return { ok: false, error: 'Skim skips full translation, so it cannot be combined with Translate.' };
  }

  let startMs = 0;
  let endMs: number | null = null;
  try {
    if (form.start.trim() !== '') startMs = parseTimestamp(form.start);
    if (form.end.trim() !== '') endMs = parseTimestamp(form.end);
  } catch (e) {
    return { ok: false, error: message(e) };
  }

  const maxMinutes = 30;
  if (durationMs !== null) {
    try {
      resolveRange({ startMs, endMs, durationMs, maxMinutes });
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  } else if (endMs !== null && endMs <= startMs) {
    return { ok: false, error: 'End must be after start.' };
  }

  return {
    ok: true,
    request: {
      source,
      startMs,
      endMs,
      options: {
        translate: form.translate,
        summarize: form.summarize,
        skim: form.skim,
        glossaryPath: form.glossaryPath ?? undefined,
        maxMinutes,
        model: 'large-v3',
      },
    },
  };
}
