import type { Channel, ChannelStore } from '../../core/db/channel-repo';
import type { Repo } from '../../core/db/repo';
import { parseYoutubeId } from '../../core/youtube';
import type { ChannelInfo, FeedItem, JobStatus } from '../shared/ipc';

export const toChannelInfo = (c: Channel): ChannelInfo => ({
  id: c.id,
  youtubeChannelId: c.youtubeChannelId,
  handle: c.handle,
  title: c.title,
  url: c.url,
  lastCheckedAt: c.lastCheckedAt,
  lastError: c.lastError,
});

/** The feed with the job (if any) that already exists for each video: matched by video id, or by the URL for older jobs. */
export function buildFeed(store: ChannelStore, repo: Repo): FeedItem[] {
  const jobs = new Map<string, { jobId: number; status: JobStatus }>();
  for (const job of repo.listJobs()) {
    // listJobs is newest first, so the first job seen for a video is its newest one; a finished job wins over it.
    const videoId = job.videoId ?? parseYoutubeId(job.source);
    if (!videoId) continue;
    const seen = jobs.get(videoId);
    if (!seen || (job.status === 'done' && seen.status !== 'done')) jobs.set(videoId, { jobId: job.id, status: job.status });
  }
  return store.listFeed().map((row) => ({
    videoId: row.videoId,
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    title: row.title,
    durationMs: row.durationMs,
    tab: row.tab,
    firstSeenAt: row.firstSeenAt,
    job: jobs.get(row.videoId) ?? null,
  }));
}
