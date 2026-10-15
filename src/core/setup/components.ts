import type { Tier } from '../tools/lock';

/** Whisper model per tier: the file is `ggml-<name>.bin`. */
export const TRANSCRIBE_MODEL: Record<Tier, string> = { gpu: 'large-v3', cpu: 'large-v3-turbo-q5_0' };
export const transcribeModelName = (tier: Tier): string => TRANSCRIBE_MODEL[tier];

export interface Wants {
  translation: boolean;
  summaries: boolean;
}

/** Component ids a setup with these features needs, in install order. Transcription is always included. */
export function requiredComponentIds(tier: Tier, wants: Wants): string[] {
  const ids = ['yt-dlp', 'ffmpeg', 'vad', `whisper-${tier}`, `model-transcribe-${tier}`];
  if (wants.translation || wants.summaries) ids.push(`llama-${tier}`);
  if (wants.translation) ids.push(`model-translate-${tier}`);
  if (wants.summaries) ids.push(`model-general-${tier}`);
  return ids;
}

/** Skim and the automatic name list both run on the general model, so skim counts as summaries. */
export function wantsOfOptions(o: { translate: boolean; summarize: boolean; skim: boolean }): Wants {
  return { translation: o.translate, summaries: o.summarize || o.skim };
}
