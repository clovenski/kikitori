// Starts an installed app against an empty profile and checks that it reports the first-run wizard.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2];
if (!exe || !existsSync(exe)) {
  console.error('Usage: pnpm smoke:installed "<path to Kikitori.exe>"');
  process.exit(2);
}
const profile = mkdtempSync(join(tmpdir(), 'bgt-profile-'));
const out = join(profile, 'smoke.txt');
const r = spawnSync(exe, ['--smoke'], { env: { ...process.env, BGT_USER_DATA: profile, BGT_SMOKE_OUT: out }, timeout: 90_000 });
const text = existsSync(out) ? readFileSync(out, 'utf8').trim() : '';
rmSync(profile, { recursive: true, force: true });
console.log(text || `no result (exit ${r.status})`);
process.exit(text === 'SMOKE OK wizard=true' ? 0 : 1);
