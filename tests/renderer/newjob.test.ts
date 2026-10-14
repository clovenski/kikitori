import { describe, expect, it } from 'vitest';
import { buildSubmitRequest, type NewJobForm } from '../../src/app/renderer/lib/newjob';

const form = (over: Partial<NewJobForm> = {}): NewJobForm => ({
  source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
  start: '',
  end: '',
  translate: true,
  summarize: true,
  skim: false,
  glossaryPath: null,
  ...over,
});

const fail = (r: ReturnType<typeof buildSubmitRequest>) => (r.ok ? '' : r.error);

describe('buildSubmitRequest', () => {
  it('builds a request with defaults for blank start and end', () => {
    expect(buildSubmitRequest(form(), 600_000)).toEqual({
      ok: true,
      request: {
        source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
        startMs: 0,
        endMs: null,
        options: { translate: true, summarize: true, skim: false, glossaryPath: undefined, maxMinutes: 30, model: 'large-v3' },
      },
    });
  });

  it('parses times in the CLI formats and passes the glossary path', () => {
    const r = buildSubmitRequest(form({ start: '1:20:00', end: '1:50:00', glossaryPath: 'C:/g.json' }), 7_200_000);
    expect(r).toMatchObject({ ok: true, request: { startMs: 4_800_000, endMs: 6_600_000, options: { glossaryPath: 'C:/g.json' } } });
  });

  it('rejects an empty source', () => {
    expect(fail(buildSubmitRequest(form({ source: '  ' }), null))).toMatch(/URL or choose a file/i);
  });

  it('rejects skim together with translate', () => {
    expect(fail(buildSubmitRequest(form({ skim: true, translate: true }), 600_000))).toMatch(/skim/i);
    expect(buildSubmitRequest(form({ skim: true, translate: false }), 600_000).ok).toBe(true);
  });

  it('rejects malformed times with the CLI message', () => {
    expect(fail(buildSubmitRequest(form({ start: '90:xx' }), 600_000))).toMatch(/Invalid time/);
  });

  it('rejects a reversed range even when the duration is unknown', () => {
    expect(fail(buildSubmitRequest(form({ start: '5:00', end: '2:00' }), null))).toMatch(/end/i);
  });

  it('enforces the 30 minute cap and the video length once the duration is known', () => {
    expect(buildSubmitRequest(form(), 40 * 60_000)).toMatchObject({ ok: false });
    expect(fail(buildSubmitRequest(form(), 40 * 60_000))).toMatch(/30 min limit/);
    expect(fail(buildSubmitRequest(form({ start: '20:00' }), 600_000))).toMatch(/start/i);
    expect(buildSubmitRequest(form({ start: '10:00', end: '35:00' }), 40 * 60_000).ok).toBe(true);
  });
});
