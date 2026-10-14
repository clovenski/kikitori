import { describe, expect, it } from 'vitest';
import { BgtError } from '../../src/core/errors';

describe('BgtError', () => {
  it('carries a code, a message, and is an Error', () => {
    const err = new BgtError('OverCap', 'too long');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('OverCap');
    expect(err.name).toBe('OverCap');
    expect(err.message).toBe('too long');
  });

  it('preserves the cause', () => {
    const cause = new Error('root');
    expect(new BgtError('ToolMissing', 'x', { cause }).cause).toBe(cause);
  });

  it('supports the LLM error codes', () => {
    expect(new BgtError('LlmServerFailed', 'x').code).toBe('LlmServerFailed');
    expect(new BgtError('LlmFailed', 'x').name).toBe('LlmFailed');
  });
});
