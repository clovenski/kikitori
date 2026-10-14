import type { Segment } from './types';

export interface TranscribeOptions {
  language: string;
  signal?: AbortSignal;
}

export interface Transcriber {
  transcribe(audioPath: string, opts: TranscribeOptions): Promise<Segment[]>;
}

/** Milestone 2. */
export interface Translator {
  translate(segments: Segment[], glossary: Record<string, string>): Promise<Segment[]>;
}

export interface Summary {
  overview: string;
  sections: { startMs: number; endMs: number; text: string }[];
}

/** Milestone 2. */
export interface Summarizer {
  summarize(segments: Segment[]): Promise<Summary>;
}
