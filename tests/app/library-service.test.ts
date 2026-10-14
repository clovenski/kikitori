import { describe, expect, it } from 'vitest';
import { getJobDetail, listLibrary } from '../../src/app/main/library-service';
import { memoryRepos, seedJob } from '../helpers/fakes';

describe('listLibrary', () => {
  it('lists jobs newest first with translation and summary flags', () => {
    const { repo, stages } = memoryRepos();
    const a = seedJob(repo, ['あ']);
    const b = seedJob(repo, ['い']);
    const [seg] = repo.listSegmentsWithId(b.id);
    stages.saveTranslations(b.id, 0, [{ segmentId: seg.id, text: 'I' }]);
    stages.saveSummary(b.id, { level: 'overview', idx: 0, startMs: 0, endMs: 1, text: 'O' });
    const items = listLibrary(repo, stages);
    expect(items.map((i) => i.jobId)).toEqual([b.id, a.id]);
    expect(items[0]).toMatchObject({ hasTranslation: true, hasSummary: true, isLocalFile: true });
    expect(items[1]).toMatchObject({ hasTranslation: false, hasSummary: false });
  });

  it('marks URL sources as not local', () => {
    const { repo, stages } = memoryRepos();
    const job = repo.createJob({
      source: 'https://www.youtube.com/watch?v=7SHNxjFuw10',
      rangeStartMs: 0,
      rangeEndMs: 1000,
      settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 },
      title: 'Hi',
      videoId: '7SHNxjFuw10',
    });
    expect(listLibrary(repo, stages)[0]).toMatchObject({ jobId: job.id, isLocalFile: false, videoId: '7SHNxjFuw10', title: 'Hi' });
  });
});

describe('legacy jobs', () => {
  it('derives the video id from the URL for jobs created before video ids were stored', () => {
    const { repo, stages } = memoryRepos();
    const job = repo.createJob({
      source: 'https://www.youtube.com/watch?v=7SHNxjFuw10&list=PLx',
      rangeStartMs: 0,
      rangeEndMs: 1000,
      settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 },
    });
    expect(job.videoId).toBeNull();
    expect(listLibrary(repo, stages)[0].videoId).toBe('7SHNxjFuw10');
    expect(getJobDetail(repo, stages, job.id)?.item.videoId).toBe('7SHNxjFuw10');
  });
});

describe('getJobDetail', () => {
  it('returns lines with absolute video times, English when present, and summaries', () => {
    const { repo, stages } = memoryRepos();
    const job = seedJob(repo, ['あ', 'い'], { rangeStartMs: 60_000, stepMs: 2000 });
    const [a, b] = repo.listSegmentsWithId(job.id);
    stages.saveTranslations(job.id, 0, [{ segmentId: a.id, text: 'A' }, { segmentId: b.id, text: '' }]);
    stages.saveSummary(job.id, { level: 'overview', idx: 0, startMs: 60_000, endMs: 64_000, text: 'Overview' });
    const detail = getJobDetail(repo, stages, job.id);
    expect(detail?.lines).toEqual([
      { id: a.id, startMs: 60_000, endMs: 61_500, ja: 'あ', en: 'A' },
      { id: b.id, startMs: 62_000, endMs: 63_500, ja: 'い', en: null },
    ]);
    expect(detail?.summaries).toHaveLength(1);
    expect(detail?.item.jobId).toBe(job.id);
  });

  it('returns null for an unknown job', () => {
    const { repo, stages } = memoryRepos();
    expect(getJobDetail(repo, stages, 99)).toBeNull();
  });
});
