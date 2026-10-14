/** A timed piece of text. All times are integer milliseconds. */
export interface Segment {
  startMs: number;
  endMs: number;
  text: string;
  lang: string;
  /** Mean token log-probability reported by the recognizer, when available. */
  avgLogprob?: number | null;
}
