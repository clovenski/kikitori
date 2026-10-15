import { describe, expect, it } from 'vitest';
import { requiredComponentIds, transcribeModelName, wantsOfOptions } from '../../src/core/setup/components';

describe('requiredComponentIds', () => {
  it('transcription only needs the core tools and the speech model', () => {
    expect(requiredComponentIds('gpu', { translation: false, summaries: false })).toEqual([
      'yt-dlp', 'ffmpeg', 'vad', 'whisper-gpu', 'model-transcribe-gpu',
    ]);
  });

  it('translation adds the runtime and the translation model; summaries the general model', () => {
    expect(requiredComponentIds('cpu', { translation: true, summaries: false })).toEqual([
      'yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu', 'llama-cpu', 'model-translate-cpu',
    ]);
    expect(requiredComponentIds('cpu', { translation: true, summaries: true })).toEqual([
      'yt-dlp', 'ffmpeg', 'vad', 'whisper-cpu', 'model-transcribe-cpu', 'llama-cpu', 'model-translate-cpu', 'model-general-cpu',
    ]);
  });
});

describe('wantsOfOptions', () => {
  it('maps job options to wanted features; skim needs the summary model', () => {
    expect(wantsOfOptions({ translate: true, summarize: false, skim: false })).toEqual({ translation: true, summaries: false });
    expect(wantsOfOptions({ translate: false, summarize: false, skim: true })).toEqual({ translation: false, summaries: true });
  });
});

describe('transcribeModelName', () => {
  it('differs per tier', () => {
    expect(transcribeModelName('gpu')).toBe('large-v3');
    expect(transcribeModelName('cpu')).toBe('large-v3-turbo-q5_0');
  });
});
