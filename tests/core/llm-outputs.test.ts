import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLlmOutputs } from '../../src/core/pipeline/llm-outputs';
import { toBilingualSrt } from '../../src/core/subtitles/bilingual';
import { toSummaryMarkdown } from '../../src/core/subtitles/summary-md';
import { memoryRepos, seedJob } from '../helpers/fakes';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bgt-llmout-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('toBilingualSrt', () => {
  it('puts English first, Japanese second, and falls back to Japanese alone', () => {
    const out = toBilingualSrt([
      { startMs: 0, endMs: 1000, en: 'Hello', ja: 'こんにちは' },
      { startMs: 1000, endMs: 2000, en: '', ja: 'えっと' },
    ]);
    expect(out).toBe(
      '1\n00:00:00,000 --> 00:00:01,000\nHello\nこんにちは\n\n2\n00:00:01,000 --> 00:00:02,000\nえっと\n',
    );
  });
});

describe('toSummaryMarkdown', () => {
  it('renders overview, optional sections, then the timeline', () => {
    const md = toSummaryMarkdown([
      { level: 'window', idx: 0, startMs: 3_600_000, endMs: 3_900_000, text: '- [1:00:05] Intro' },
      { level: 'overview', idx: 0, startMs: 3_600_000, endMs: 3_900_000, text: 'A short stream.' },
    ]);
    expect(md).toContain('# Summary');
    expect(md).toContain('## Overview\n\nA short stream.');
    expect(md).not.toContain('## Sections');
    expect(md).toContain('## Timeline\n\n### 1:00:00 to 1:05:00\n\n- [1:00:05] Intro');
    expect(toSummaryMarkdown([])).toBe('');
  });
});

describe('writeLlmOutputs', () => {
  it('writes nothing when there are no translations or summaries', () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ']);
    expect(writeLlmOutputs(repo, stages, job, dir)).toEqual([]);
  });

  it('writes en/bi SRTs with the range offset and the summary file', () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い'], { rangeStartMs: 60_000 });
    const [a, b] = repo.listSegmentsWithId(job.id);
    stages.saveTranslations(job.id, 0, [{ segmentId: a.id, text: 'A' }, { segmentId: b.id, text: '' }]);
    stages.saveSummary(job.id, { level: 'overview', idx: 0, startMs: 60_000, endMs: 64_000, text: 'Overview' });

    const written = writeLlmOutputs(repo, stages, job, dir);
    expect(written.map((p) => path.basename(p)).sort()).toEqual([
      `job-${job.id}.bi.srt`,
      `job-${job.id}.en.srt`,
      `job-${job.id}.summary.md`,
    ]);
    const en = readFileSync(path.join(dir, `job-${job.id}.en.srt`), 'utf8');
    expect(en).toBe('1\n00:01:00,000 --> 00:01:01,500\nA\n'); // the empty translation is skipped
    const bi = readFileSync(path.join(dir, `job-${job.id}.bi.srt`), 'utf8');
    expect(bi).toContain('00:01:00,000 --> 00:01:01,500\nA\nあ');
    expect(bi).toContain('00:01:02,000 --> 00:01:03,500\nい');
    expect(existsSync(path.join(dir, `job-${job.id}.summary.md`))).toBe(true);
  });
});
