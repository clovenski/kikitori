import path from 'node:path';
import { startChildTracking } from '../core/tools/children';
import { dataDir } from '../core/tools/paths';

/** Kill helpers an earlier crash left behind, and start recording this run's helpers. */
export async function trackChildren(): Promise<void> {
  const { killed } = await startChildTracking(path.join(dataDir(), 'children.json'));
  if (killed.length > 0) console.log(`Cleaned up ${killed.length} helper process(es) left behind by an earlier crash.`);
}
