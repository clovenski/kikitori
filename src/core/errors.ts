export type ErrorCode =
  | 'ToolMissing'
  | 'DownloadFailed'
  | 'TranscribeFailed'
  | 'OverCap'
  | 'InvalidInput'
  | 'LlmServerFailed'
  | 'LlmFailed'
  | 'SetupRequired';

export class BgtError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = code;
  }
}
