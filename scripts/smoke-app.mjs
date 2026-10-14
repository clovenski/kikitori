import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron'); // the electron package exports the binary path
const result = spawnSync(electronPath, ['.', '--smoke'], { encoding: 'utf8', timeout: 60_000 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status === 0 && (result.stdout ?? '').includes('SMOKE OK') ? 0 : 1);
