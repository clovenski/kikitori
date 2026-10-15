// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallProgress } from '../../src/app/renderer/components/InstallProgress';
import type { SetupProgress } from '../../src/app/shared/ipc';

afterEach(cleanup);

const comp = (id: string, installed = false) => ({ id, title: `Title ${id}`, tier: 'all' as const, sizeBytes: 1e9, installed });
const running = (componentId: string): SetupProgress => ({
  phase: 'installing',
  message: null,
  progress: {
    componentId,
    componentTitle: `Title ${componentId}`,
    fileId: 'f',
    fileIndex: 2,
    fileCount: 3,
    fileReceived: 5e8,
    fileTotal: 1e9,
    overallReceived: 1.5e9,
    overallTotal: 3e9,
    bytesPerSecond: 10e6,
    etaSeconds: 100,
  },
});

describe('InstallProgress', () => {
  it('shows totals, speed and time left, and marks each component done, downloading or waiting', () => {
    render(<InstallProgress components={[comp('a'), comp('b'), comp('c'), comp('z', true)]} progress={running('b')} />);
    expect(screen.getByText(/1\.5 GB of 3\.0 GB/)).toBeTruthy();
    expect(screen.getByText(/10 MB\/s/)).toBeTruthy();
    expect(screen.getByText(/about 2 min/)).toBeTruthy();
    expect(screen.getByText('Title a').parentElement?.textContent).toContain('Done');
    expect(screen.getByText('Title b').parentElement?.textContent).toContain('Downloading');
    expect(screen.getByText('Title c').parentElement?.textContent).toContain('Waiting');
    expect(screen.queryByText('Title z')).toBeNull();
  });

  it('shows the status message while nothing is downloading yet', () => {
    render(<InstallProgress components={[comp('a')]} progress={{ phase: 'installing', progress: null, message: 'Checking vad...' }} />);
    expect(screen.getByText('Checking vad...')).toBeTruthy();
  });

  it('without a component list it names the file being downloaded', () => {
    render(<InstallProgress progress={running('b')} />);
    expect(screen.getByText(/Downloading Title b/)).toBeTruthy();
  });
});
