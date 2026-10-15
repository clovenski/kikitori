import path from 'node:path';
import { fetchEntry } from '../src/core/tools/fetch';
import { loadLock } from '../src/core/tools/lock';
import { projectRoot, resourcesDir } from '../src/core/tools/paths';

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.error('setup:tools currently supports Windows x64 only. Install yt-dlp, ffmpeg and whisper.cpp manually.');
    process.exit(1);
  }
  const tierFlag = process.argv.indexOf('--tier');
  const tier = tierFlag >= 0 ? process.argv[tierFlag + 1] : 'gpu';
  if (tier !== 'gpu' && tier !== 'cpu') {
    console.error('Usage: pnpm setup:tools [--tier gpu|cpu]');
    process.exit(1);
  }
  const lock = loadLock(path.join(projectRoot(), 'tools.lock.json'));
  for (const component of lock.components.filter((c) => c.tier === 'all' || c.tier === tier)) {
    for (const entry of component.files) {
      let lastPercent = -1;
      await fetchEntry(entry, resourcesDir(), console.log, (received, total) => {
        if (!total) return;
        const percent = Math.floor((received / total) * 100);
        if (percent !== lastPercent && percent % 5 === 0) {
          lastPercent = percent;
          process.stdout.write(`\r  ${entry.id}: ${percent}%   `);
          if (percent === 100) process.stdout.write('\n');
        }
      });
    }
  }
  console.log('Done. Run "pnpm bgt doctor" to verify.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
