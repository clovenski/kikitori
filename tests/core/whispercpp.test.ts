import { describe, expect, it } from 'vitest';
import { buildWhisperArgs, parseWhisperJson } from '../../src/core/backends/transcribe/whispercpp';

describe('buildWhisperArgs', () => {
  const base = {
    modelPath: 'C:/r/models/ggml-large-v3.bin',
    audioPath: 'C:/data/work/1/chunk-000.wav',
    outPrefix: 'C:/data/work/1/chunk-000.whisper',
    language: 'ja',
  };

  it('requests full JSON, the language, and VAD when a VAD model is given', () => {
    const args = buildWhisperArgs({ ...base, vadModelPath: 'C:/r/models/ggml-silero.bin' });
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', base.modelPath]);
    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2)).toEqual(['-f', base.audioPath]);
    expect(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2)).toEqual(['-l', 'ja']);
    expect(args).toContain('-ojf');
    expect(args.slice(args.indexOf('-of'), args.indexOf('-of') + 2)).toEqual(['-of', base.outPrefix]);
    expect(args).toContain('--vad');
    expect(args[args.indexOf('--vad-model') + 1]).toBe('C:/r/models/ggml-silero.bin');
  });

  it('omits VAD flags without a VAD model and adds threads when given', () => {
    const args = buildWhisperArgs({ ...base, vadModelPath: null, threads: 8 });
    expect(args).not.toContain('--vad');
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '8']);
  });
});

describe('parseWhisperJson', () => {
  const sample = JSON.stringify({
    result: { language: 'ja' },
    transcription: [
      {
        offsets: { from: 1000, to: 3500 },
        text: ' こんにちは',
        tokens: [
          { text: '[_BEG_]', p: 0.9 },
          { text: 'こんにちは', p: 0.5 },
          { text: '。', p: 0.25 },
        ],
      },
      { offsets: { from: 4000, to: 5000 }, text: ' 次です' },
      { offsets: { from: 6000, to: 6500 }, text: '   ', tokens: [] },
    ],
  });

  it('maps offsets, trims text, and averages token log-probabilities (skipping special tokens)', () => {
    const segs = parseWhisperJson(sample, 'ja');
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ startMs: 1000, endMs: 3500, text: 'こんにちは', lang: 'ja' });
    expect(segs[0].avgLogprob).toBeCloseTo((Math.log(0.5) + Math.log(0.25)) / 2, 5);
  });

  it('uses null confidence when tokens are absent or empty', () => {
    const segs = parseWhisperJson(sample, 'ja');
    expect(segs[1].avgLogprob).toBeNull();
    expect(segs[2].avgLogprob).toBeNull();
  });

  it('falls back to the requested language and tolerates an empty transcription', () => {
    expect(parseWhisperJson(JSON.stringify({ transcription: [] }), 'ja')).toEqual([]);
    const segs = parseWhisperJson(
      JSON.stringify({ transcription: [{ offsets: { from: 0, to: 10 }, text: 'x' }] }),
      'ja',
    );
    expect(segs[0].lang).toBe('ja');
  });

  it('throws TranscribeFailed on invalid JSON', () => {
    expect(() => parseWhisperJson('not json', 'ja')).toThrow(
      expect.objectContaining({ code: 'TranscribeFailed' }),
    );
  });
});
