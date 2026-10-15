// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelsScreen } from '../../src/app/renderer/components/ChannelsScreen';
import { ApiProvider } from '../../src/app/renderer/lib/api';
import type { ChannelInfo, FeedItem } from '../../src/app/shared/ipc';
import { channel, fakeChannelsApi, feedItem } from './channel-fakes';

afterEach(cleanup);

function renderScreen(over: { channels?: ChannelInfo[]; feed?: FeedItem[]; addError?: string } = {}) {
  const fake = fakeChannelsApi(over);
  const onReload = vi.fn();
  const onProcess = vi.fn();
  const onOpenJob = vi.fn();
  render(
    <ApiProvider api={fake.api}>
      <ChannelsScreen channels={over.channels ?? []} feed={over.feed ?? []} onReload={onReload} onProcess={onProcess} onOpenJob={onOpenJob} />
    </ApiProvider>,
  );
  return { ...fake, onReload, onProcess, onOpenJob };
}

describe('ChannelsScreen', () => {
  it('explains what to do with no channels and always points to New job for other videos', () => {
    renderScreen();
    expect(screen.getByText(/Follow a channel to see its new videos/)).toBeTruthy();
    expect(screen.getByText('Need an older or one-off video? Paste its link into New job.')).toBeTruthy();
  });

  it('follows a channel from what was typed and reloads', async () => {
    const t = renderScreen();
    fireEvent.change(screen.getByLabelText('Channel link or @handle'), { target: { value: '@someone' } });
    fireEvent.click(screen.getByText('Follow'));
    await waitFor(() => expect(t.channels.add).toHaveBeenCalledWith('@someone'));
    await waitFor(() => expect(t.onReload).toHaveBeenCalled());
    expect((screen.getByLabelText('Channel link or @handle') as HTMLInputElement).value).toBe('');
  });

  it('shows why a channel could not be followed and keeps what was typed', async () => {
    const t = renderScreen({ addError: 'Could not find that channel.' });
    fireEvent.change(screen.getByLabelText('Channel link or @handle'), { target: { value: '@nobody' } });
    fireEvent.click(screen.getByText('Follow'));
    expect(await screen.findByText('Could not find that channel.')).toBeTruthy();
    expect(t.onReload).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Channel link or @handle') as HTMLInputElement).value).toBe('@nobody');
  });

  it('shows when each channel was checked and its last error', () => {
    renderScreen({
      channels: [
        channel(1, { lastCheckedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
        channel(2, { lastError: 'yt-dlp could not read the channel', lastCheckedAt: null }),
        channel(3),
      ],
    });
    expect(screen.getByText(/Checked 5 min ago/)).toBeTruthy();
    expect(screen.getByText('yt-dlp could not read the channel')).toBeTruthy();
    expect(screen.getAllByText(/Not checked yet/).length).toBeGreaterThan(0);
  });

  it('asks before removing a channel and then removes it', async () => {
    const t = renderScreen({ channels: [channel(1)] });
    fireEvent.click(screen.getByText('Remove'));
    expect(screen.getByText(/Remove Channel 1 and its videos from the feed\?/)).toBeTruthy();
    expect(t.channels.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Yes, remove'));
    await waitFor(() => expect(t.channels.remove).toHaveBeenCalledWith(1));
    await waitFor(() => expect(t.onReload).toHaveBeenCalled());
  });

  it('cancelling the removal keeps the channel', () => {
    const t = renderScreen({ channels: [channel(1)] });
    fireEvent.click(screen.getByText('Remove'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(t.channels.remove).not.toHaveBeenCalled();
    expect(screen.queryByText(/Yes, remove/)).toBeNull();
  });

  it('lists feed items with length and a Stream badge, and processes or dismisses them', async () => {
    const t = renderScreen({
      channels: [channel(1)],
      feed: [feedItem('aaaaaaaaaaa'), feedItem('bbbbbbbbbbb', { tab: 'streams', durationMs: 3_725_000 })],
    });
    expect(screen.getByText('Video aaaaaaaaaaa')).toBeTruthy();
    expect(screen.getByText('0:02:05')).toBeTruthy();
    expect(screen.getByText('1:02:05')).toBeTruthy();
    expect(screen.getAllByText('Stream')).toHaveLength(1);
    // The thumbnail is decorative (the title sits next to it), so it has an empty alt and no img role.
    expect(document.querySelectorAll('img')[0].getAttribute('src')).toBe('https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg');
    fireEvent.click(screen.getAllByText('Process')[1]);
    expect(t.onProcess).toHaveBeenCalledWith('bbbbbbbbbbb');
    fireEvent.click(screen.getAllByText('Dismiss')[0]);
    await waitFor(() => expect(t.channels.dismiss).toHaveBeenCalledWith('aaaaaaaaaaa'));
    await waitFor(() => expect(t.onReload).toHaveBeenCalled());
  });

  it('a video that already has a job shows its status and opens it instead of processing again', () => {
    const t = renderScreen({ channels: [channel(1)], feed: [feedItem('aaaaaaaaaaa', { job: { jobId: 7, status: 'done' } })] });
    expect(screen.queryByText('Process')).toBeNull();
    expect(screen.getByText('Done')).toBeTruthy();
    fireEvent.click(screen.getByText('Open in library'));
    expect(t.onOpenJob).toHaveBeenCalledWith(7);
  });

  it('refreshes all channels and dismisses everything on request', async () => {
    const t = renderScreen({ channels: [channel(1)], feed: [feedItem('aaaaaaaaaaa')] });
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(t.channels.refresh).toHaveBeenCalledWith());
    fireEvent.click(screen.getByText('Dismiss all'));
    await waitFor(() => expect(t.channels.dismissAll).toHaveBeenCalledWith());
  });

  it('says so when there is nothing new', () => {
    renderScreen({ channels: [channel(1)] });
    expect(screen.getByText('No new videos right now.')).toBeTruthy();
  });
});
