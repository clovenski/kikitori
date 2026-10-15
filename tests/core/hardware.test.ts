import { describe, expect, it } from 'vitest';
import { decideTier, detectHardware, parseNvidiaSmi } from '../../src/core/setup/hardware';
import type { RunResult } from '../../src/core/tools/process';

const gpu = (name: string, vramMb: number, driver: string) => ({ name, vramMb, driver });

describe('parseNvidiaSmi', () => {
  it('reads one line per GPU, taking the last two fields as memory and driver', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3080, 12288, 560.94\r\nNVIDIA GeForce GTX 1050, 2048, 560.94\r\n')).toEqual([
      gpu('NVIDIA GeForce RTX 3080', 12288, '560.94'),
      gpu('NVIDIA GeForce GTX 1050', 2048, '560.94'),
    ]);
  });

  it('keeps commas inside a name and ignores malformed lines', () => {
    expect(parseNvidiaSmi('Weird, Name, 8188, 552.12\nnot a gpu line\n\nNo devices were found')).toEqual([
      gpu('Weird, Name', 8188, '552.12'),
    ]);
  });
});

describe('decideTier', () => {
  it('picks gpu for a big enough card with a new enough driver', () => {
    expect(decideTier([gpu('RTX 3080', 12288, '560.94')]).tier).toBe('gpu');
    expect(decideTier([gpu('RTX 4060', 8188, '551.23')]).tier).toBe('gpu');
  });

  it('falls back to cpu and says why', () => {
    expect(decideTier([])).toEqual({ tier: 'cpu', reason: 'No NVIDIA graphics card was found.' });
    expect(decideTier([gpu('GTX 1660', 6144, '560.94')]).reason).toBe(
      'The NVIDIA GPU (GTX 1660) has only 6144 MB of memory; 8 GB are needed.',
    );
    expect(decideTier([gpu('RTX 3080', 12288, '535.10')]).reason).toBe(
      'The NVIDIA driver (535.10) is older than 551, which the GPU programs need.',
    );
  });

  it('uses the card with the most memory', () => {
    expect(decideTier([gpu('small', 2048, '560.1'), gpu('big', 12288, '560.1')]).tier).toBe('gpu');
  });
});

describe('detectHardware', () => {
  const run = (result: RunResult | Error) => async () => {
    if (result instanceof Error) throw result;
    return result;
  };

  it('reports the best GPU and the machine size', async () => {
    const info = await detectHardware(run({ code: 0, stdout: 'RTX 3080, 12288, 560.94\n', stderr: '' }));
    expect(info.tier).toBe('gpu');
    expect(info.best?.name).toBe('RTX 3080');
    expect(info.cores).toBeGreaterThan(0);
    expect(info.ramMb).toBeGreaterThan(0);
  });

  it('treats a missing or failing nvidia-smi as "no NVIDIA GPU"', async () => {
    expect((await detectHardware(run(new Error('ENOENT')))).tier).toBe('cpu');
    expect((await detectHardware(run({ code: 9, stdout: '', stderr: 'driver not loaded' }))).tier).toBe('cpu');
  });
});
