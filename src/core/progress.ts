export type ProgressStage = 'fetch' | 'transcribe' | 'glossary' | 'translate' | 'summarize';

export interface ProgressEvent {
  stage: ProgressStage;
  done: number;
  total: number;
  message: string;
}
