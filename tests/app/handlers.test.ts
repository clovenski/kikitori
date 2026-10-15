import { describe, expect, it, vi } from 'vitest';
import { createHandlers, type HandlerDeps } from '../../src/app/main/handlers';
import { JobQueue } from '../../src/app/main/queue';
import { ChannelStore } from '../../src/core/db/channel-repo';
import { SubmissionStore } from '../../src/core/db/submission-repo';
import { BgtError } from '../../src/core/errors';
import { Database } from '../../src/core/db/sqlite';
import { migrate } from '../../src/core/db/schema';
import { memoryRepos, seedJob } from '../helpers/fakes';

function setup(
  over: {
    speed?: number | null;
    probe?: () => Promise<{ title: string | null; durationMs: number }>;
    fileExists?: (p: string) => boolean;
    ensureReady?: (o: unknown) => void;
    model?: string;
    deleteFiles?: (jobId: number, outDir: string) => void;
  } = {},
) {
  const { repo, stages } = memoryRepos();
  const db = new Database(':memory:');
  migrate(db);
  const store = new SubmissionStore(db);
  const channelStore = new ChannelStore(db);
  const addChannel = vi.fn(async (input: string) =>
    channelStore.addChannel({ youtubeChannelId: `UC${input}`, handle: null, title: input, url: `https://www.youtube.com/channel/UC${input}` }),
  );
  const refreshChannels = vi.fn<(id?: number) => Promise<void>>(async () => {});
  const queue = new JobQueue({ store, run: async () => {}, emitChanged: () => {}, emitProgress: () => {} });
  const opened: string[] = [];
  const deleteFiles = vi.fn(over.deleteFiles ?? (() => {}));
  const service = {
    state: vi.fn(() => ({ needsWizard: false })),
    detect: vi.fn(async () => ({ recommendedTier: 'cpu' })),
    plan: vi.fn(() => ({ missingBytes: 0 })),
    missingFor: vi.fn(() => ({ missingBytes: 5 })),
    start: vi.fn(),
    cancel: vi.fn(async () => {}),
    repair: vi.fn(),
    updateYtDlp: vi.fn(async () => 'updated'),
  };
  const outputInfo = { dir: 'C:/out', isDefault: true, locked: false };
  const output = {
    info: vi.fn(() => outputInfo),
    choose: vi.fn(async () => ({ ...outputInfo, dir: 'D:/subs', isDefault: false }) as typeof outputInfo | null),
    reset: vi.fn(() => outputInfo),
  };
  const updates = {
    state: vi.fn(() => ({ phase: 'idle' })),
    check: vi.fn(async () => ({ phase: 'available', version: '0.3.0' })),
    download: vi.fn(async () => {}),
    install: vi.fn(() => true),
  };
  const handlers = createHandlers({
    repo,
    stages,
    queue,
    probe: over.probe ?? (async () => ({ title: 'T', durationMs: 600_000 })),
    speedFactor: () => (over.speed === undefined ? 10 : over.speed),
    pickFile: async (kind) => (kind === 'media' ? 'C:/a.wav' : null),
    openFolder: async (dir) => {
      opened.push(dir);
    },
    defaultOutDir: 'C:/out',
    output: output as unknown as HandlerDeps['output'],
    deleteJobFiles: deleteFiles,
    fileExists: over.fileExists ?? (() => true),
    setup: service as unknown as HandlerDeps['setup'],
    openNotices: async () => {},
    ensureReady: over.ensureReady ?? (() => {}),
    transcribeModel: () => over.model ?? 'large-v3',
    channels: { store: channelStore, add: addChannel, refresh: refreshChannels },
    updates: updates as unknown as HandlerDeps['updates'],
  });
  return { output, deleteFiles, updates, handlers, repo, stages, queue, opened, service, channelStore, addChannel, refreshChannels };
}

const options = { translate: false, summarize: false, skim: false, maxMinutes: 30, model: 'large-v3' };

describe('handlers', () => {
  it('library:list and job:get wrap the library service', async () => {
    const t = setup();
    const job = seedJob(t.repo, ['あ']);
    const list = await t.handlers['library:list']();
    expect(list).toMatchObject({ ok: true, value: [{ jobId: job.id }] });
    const detail = await t.handlers['job:get'](job.id);
    expect(detail).toMatchObject({ ok: true, value: { item: { jobId: job.id } } });
    expect(await t.handlers['job:get'](999)).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['job:get']('x')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
  });

  it('update channels delegate to the service, and a failed check comes back as an error result', async () => {
    const t = setup();
    expect(await t.handlers['updates:state']()).toEqual({ ok: true, value: { phase: 'idle' } });
    expect(await t.handlers['updates:check']()).toEqual({ ok: true, value: { phase: 'available', version: '0.3.0' } });
    expect(await t.handlers['updates:download']()).toEqual({ ok: true, value: null });
    expect(t.updates.download).toHaveBeenCalledTimes(1);
    expect(await t.handlers['updates:install']()).toEqual({ ok: true, value: null });
    expect(t.updates.install).toHaveBeenCalledTimes(1);
    t.updates.check.mockRejectedValueOnce(new Error('offline'));
    expect(await t.handlers['updates:check']()).toMatchObject({ ok: false, error: { message: 'offline' } });
  });

  it('queue:submit validates, queues and returns the submission', async () => {
    const t = setup();
    const ok = await t.handlers['queue:submit']({ source: 'C:/a.wav', startMs: 0, endMs: null, options });
    expect(ok).toMatchObject({ ok: true, value: { id: 1, source: 'C:/a.wav' } });
    const bad = await t.handlers['queue:submit']({ source: '', startMs: 0, endMs: null, options });
    expect(bad).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(t.queue.list()).toHaveLength(1);
  });

  it('queue:submit checks that the needed components are installed and queues nothing when they are not', async () => {
    const t = setup({
      ensureReady: () => {
        throw new BgtError('SetupRequired', 'Download the translation model first.');
      },
    });
    const r = await t.handlers['queue:submit']({ source: 'C:/a.wav', startMs: 0, endMs: null, options: { ...options, translate: true } });
    expect(r).toMatchObject({ ok: false, error: { code: 'SetupRequired' } });
    expect(t.queue.list()).toHaveLength(0);
  });

  it('queue:submit stores the whisper model of the installed tier, not the one the renderer sent', async () => {
    const t = setup({ model: 'large-v3-turbo-q5_0' });
    await t.handlers['queue:submit']({ source: 'C:/a.wav', startMs: 0, endMs: null, options });
    expect(t.queue.list()[0].options.model).toBe('large-v3-turbo-q5_0');
  });

  it('setup channels validate their arguments and delegate to the service', async () => {
    const t = setup();
    expect(await t.handlers['setup:start']({ tier: 'tpu' })).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(t.service.start).not.toHaveBeenCalled();
    const selection = { tier: 'cpu', features: { translation: true, summaries: false } };
    expect(await t.handlers['setup:start'](selection)).toEqual({ ok: true, value: null });
    expect(t.service.start).toHaveBeenCalledWith(selection);
    expect(await t.handlers['setup:state']()).toEqual({ ok: true, value: { needsWizard: false } });
    expect(await t.handlers['setup:missingFor']({ translate: true })).toEqual({ ok: true, value: { missingBytes: 5 } });
    expect(await t.handlers['setup:updateYtDlp']()).toEqual({ ok: true, value: 'updated' });
    expect(await t.handlers['setup:cancel']()).toEqual({ ok: true, value: null });
    expect(await t.handlers['setup:repair']()).toEqual({ ok: true, value: null });
  });

  it('a setup that is already running comes back as an error result, not a thrown exception', async () => {
    const t = setup();
    t.service.start.mockImplementation(() => {
      throw new BgtError('InvalidInput', 'A download is already running.');
    });
    const r = await t.handlers['setup:start']({ tier: 'cpu', features: { translation: true, summaries: true } });
    expect(r).toMatchObject({ ok: false, error: { message: 'A download is already running.' } });
  });

  it('queue:submit refuses a local file that does not exist, and never queues it', async () => {
    const t = setup({ fileExists: () => false });
    const r = await t.handlers['queue:submit']({ source: 'C:/gone/clip.wav', startMs: 0, endMs: null, options });
    expect(r).toMatchObject({ ok: false, error: { code: 'InvalidInput', message: expect.stringContaining('File not found') } });
    expect(t.queue.list()).toHaveLength(0);
  });

  it('queue:submit does not require URLs to exist on disk', async () => {
    const t = setup({ fileExists: () => false });
    const r = await t.handlers['queue:submit']({ source: 'https://www.youtube.com/watch?v=7SHNxjFuw10', startMs: 0, endMs: null, options });
    expect(r.ok).toBe(true);
  });

  it('queue:submit loads the glossary file up front and refuses a bad one before queueing', async () => {
    const t = setup();
    const r = await t.handlers['queue:submit']({
      source: 'C:/a.wav',
      startMs: 0,
      endMs: null,
      options: { ...options, glossaryPath: 'C:/definitely/not/here/glossary.json' },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'InvalidInput', message: expect.stringContaining('glossary.json') } });
    expect(t.queue.list()).toHaveLength(0);
  });

  it('queue:cancel and queue:resume validate ids', async () => {
    const t = setup();
    expect(await t.handlers['queue:cancel'](0)).toMatchObject({ ok: false });
    expect(await t.handlers['queue:resume'](1)).toEqual({ ok: true, value: null });
  });

  it('source:probe returns the probe result or a typed error', async () => {
    const good = setup();
    expect(await good.handlers['source:probe']('https://x')).toEqual({ ok: true, value: { title: 'T', durationMs: 600_000 } });
    const failing = setup({
      probe: async () => {
        throw new BgtError('DownloadFailed', 'blocked');
      },
    });
    expect(await failing.handlers['source:probe']('https://x')).toEqual({
      ok: false,
      error: { code: 'DownloadFailed', message: 'blocked' },
    });
    expect(await good.handlers['source:probe']('  ')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
  });

  it('source:estimate divides the range by the measured speed, or answers null', async () => {
    const t = setup({ speed: 10 });
    expect(await t.handlers['source:estimate']({ durationMs: 600_000, startMs: 0, endMs: null })).toEqual({ ok: true, value: 60 });
    expect(await t.handlers['source:estimate']({ durationMs: 600_000, startMs: 300_000, endMs: 600_000 })).toEqual({ ok: true, value: 30 });
    const unknown = setup({ speed: null });
    expect(await unknown.handlers['source:estimate']({ durationMs: 600_000, startMs: 0, endMs: null })).toEqual({ ok: true, value: null });
  });

  it('dialogs and open-folder delegate to the injected functions', async () => {
    const t = setup();
    expect(await t.handlers['dialog:pickMedia']()).toEqual({ ok: true, value: 'C:/a.wav' });
    expect(await t.handlers['dialog:pickGlossary']()).toEqual({ ok: true, value: null });
    seedJob(t.repo, ['あ']);
    expect(await t.handlers['job:openOutputFolder'](1)).toEqual({ ok: true, value: null });
    expect(t.opened).toEqual(['C:/out']); // a job with no recorded folder is in the default one
  });

  it('job:openOutputFolder opens the folder the job was written to, not the current setting', async () => {
    const t = setup();
    const job = seedJob(t.repo, ['あ']);
    t.repo.setJobOutDir(job.id, 'D:/old subs');
    expect(await t.handlers['job:openOutputFolder'](job.id)).toEqual({ ok: true, value: null });
    expect(t.opened).toEqual(['D:/old subs']);
  });

  it('output:get, output:choose and output:reset delegate to the output folder service', async () => {
    const t = setup();
    expect(await t.handlers['output:get']()).toEqual({ ok: true, value: { dir: 'C:/out', isDefault: true, locked: false } });
    expect(await t.handlers['output:choose']()).toEqual({ ok: true, value: { dir: 'D:/subs', isDefault: false, locked: false } });
    t.output.choose.mockResolvedValueOnce(null);
    expect(await t.handlers['output:choose']()).toEqual({ ok: true, value: null });
    expect(await t.handlers['output:reset']()).toEqual({ ok: true, value: { dir: 'C:/out', isDefault: true, locked: false } });
  });

  it('output:choose passes a folder that cannot be written to back as an error result', async () => {
    const t = setup();
    t.output.choose.mockRejectedValueOnce(new BgtError('InvalidInput', "Can't write to Z:/nope"));
    expect(await t.handlers['output:choose']()).toMatchObject({ ok: false, error: { code: 'InvalidInput', message: "Can't write to Z:/nope" } });
  });

  it('channels:add trims the text, follows the channel and returns it; empty text is refused', async () => {
    const t = setup();
    expect(await t.handlers['channels:add']('  @abc  ')).toMatchObject({ ok: true, value: { title: '@abc', lastError: null } });
    expect(t.addChannel).toHaveBeenCalledWith('@abc');
    expect(await t.handlers['channels:add']('  ')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['channels:list']()).toMatchObject({ ok: true, value: [{ title: '@abc' }] });
  });

  it('channels:add passes a failure back as an error result', async () => {
    const t = setup();
    t.addChannel.mockRejectedValueOnce(new BgtError('InvalidInput', 'You already follow this channel.'));
    expect(await t.handlers['channels:add']('@abc')).toMatchObject({ ok: false, error: { message: 'You already follow this channel.' } });
  });

  it('channels:remove and channels:refresh validate their ids', async () => {
    const t = setup();
    const c = t.channelStore.addChannel({ youtubeChannelId: 'UCx', handle: null, title: 'x', url: 'u' });
    expect(await t.handlers['channels:refresh']()).toEqual({ ok: true, value: null });
    expect(t.refreshChannels).toHaveBeenLastCalledWith(undefined);
    expect(await t.handlers['channels:refresh'](c.id)).toEqual({ ok: true, value: null });
    expect(t.refreshChannels).toHaveBeenLastCalledWith(c.id);
    expect(await t.handlers['channels:refresh']('1')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['channels:remove']('x')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['channels:remove'](c.id)).toEqual({ ok: true, value: null });
    expect(t.channelStore.listChannels()).toEqual([]);
  });

  it('feed:list links videos that already have a job; feed:dismiss and feed:dismissAll validate and persist', async () => {
    const t = setup();
    const c = t.channelStore.addChannel({ youtubeChannelId: 'UCx', handle: null, title: 'x', url: 'u' });
    t.channelStore.addItems(c.id, [
      { videoId: 'aaaaaaaaaaa', title: 'A', durationMs: 1000, tab: 'videos' },
      { videoId: 'bbbbbbbbbbb', title: 'B', durationMs: 1000, tab: 'streams' },
    ]);
    const job = t.repo.createJob({ source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', rangeStartMs: 0, rangeEndMs: 1, settings: { model: 'large-v3', language: 'ja', maxMinutes: 30 }, videoId: 'aaaaaaaaaaa' });
    const feed = await t.handlers['feed:list']();
    expect(feed).toMatchObject({ ok: true, value: [{ videoId: 'aaaaaaaaaaa', job: { jobId: job.id } }, { videoId: 'bbbbbbbbbbb', job: null }] });
    expect(await t.handlers['feed:dismiss']('nope')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['feed:dismiss']('bbbbbbbbbbb')).toEqual({ ok: true, value: null });
    expect(t.channelStore.listFeed().map((f) => f.videoId)).toEqual(['aaaaaaaaaaa']);
    expect(await t.handlers['feed:dismissAll']()).toEqual({ ok: true, value: null });
    expect(t.channelStore.listFeed()).toEqual([]);
  });

  it('job:delete removes the job, its submissions and its files', async () => {
    const t = setup();
    const job = seedJob(t.repo, ['あ']);
    const kept = seedJob(t.repo, ['い']);
    expect(await t.handlers['job:delete'](job.id)).toEqual({ ok: true, value: null });
    expect(t.repo.getJob(job.id)).toBeUndefined();
    expect(t.repo.getJob(kept.id)).toBeDefined();
    expect(t.deleteFiles).toHaveBeenCalledWith(job.id, 'C:/out');
  });

  it("job:delete removes the files from the folder the job was written to", async () => {
    const t = setup();
    const job = seedJob(t.repo, ['あ']);
    t.repo.setJobOutDir(job.id, 'D:/old subs');
    await t.handlers['job:delete'](job.id);
    expect(t.deleteFiles).toHaveBeenCalledWith(job.id, 'D:/old subs');
  });

  it('job:delete rejects bad ids and unknown jobs without touching any files', async () => {
    const t = setup();
    expect(await t.handlers['job:delete']('x')).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(await t.handlers['job:delete'](999)).toMatchObject({ ok: false, error: { code: 'InvalidInput' } });
    expect(t.deleteFiles).not.toHaveBeenCalled();
  });

  it('job:delete refuses a job that is still being processed and keeps everything', async () => {
    const t = setup();
    const job = seedJob(t.repo, ['あ']);
    t.queue.removeJob = () => {
      throw new BgtError('InvalidInput', 'Cancel it first.');
    };
    expect(await t.handlers['job:delete'](job.id)).toMatchObject({ ok: false, error: { message: 'Cancel it first.' } });
    expect(t.repo.getJob(job.id)).toBeDefined();
    expect(t.deleteFiles).not.toHaveBeenCalled();
  });
});
