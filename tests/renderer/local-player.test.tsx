// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalPlayer } from '../../src/app/renderer/components/LocalPlayer';

afterEach(cleanup);

describe('LocalPlayer', () => {
  it('reports a video that cannot be loaded (moved, deleted or unsupported)', () => {
    const onFail = vi.fn();
    const { container } = render(<LocalPlayer jobId={4} startSeconds={0} onReady={() => {}} onFail={onFail} />);
    fireEvent.error(container.querySelector('video') as HTMLVideoElement);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0]).toMatch(/could not be played/i);
  });

  it('hands over a TimeSource once the metadata has loaded', () => {
    const onReady = vi.fn();
    const { container } = render(<LocalPlayer jobId={4} startSeconds={0} onReady={onReady} onFail={() => {}} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(typeof onReady.mock.calls[0][0].getTimeMs()).toBe('number');
  });
});
