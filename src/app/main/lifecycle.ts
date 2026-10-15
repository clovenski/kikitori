export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

export interface ShutdownResult {
  name: string;
  outcome: 'ok' | 'error' | 'timeout';
}

/**
 * Runs quit-time cleanup steps one after another. A step that throws or hangs is abandoned (after
 * `timeoutMs`) and the next one still runs, so a stuck queue can neither skip stopping the models nor
 * leave an invisible process holding the single-instance lock.
 */
export async function runShutdown(
  steps: ShutdownStep[],
  timeoutMs: number,
  log: (message: string) => void,
): Promise<ShutdownResult[]> {
  const results: ShutdownResult[] = [];
  for (const step of steps) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([step.run().then(() => 'ok' as const), deadline]);
      if (outcome === 'timeout') log(`Shutdown: "${step.name}" did not finish within ${timeoutMs / 1000}s; moving on.`);
      results.push({ name: step.name, outcome });
    } catch (err) {
      log(`Shutdown: "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      results.push({ name: step.name, outcome: 'error' });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

/** Quitting needs a confirmation only while a job is actually running. */
export function shouldConfirmQuit(submissions: { state: string }[]): boolean {
  return submissions.some((s) => s.state === 'running');
}

export interface StartupFailure {
  title: string;
  detail: string;
}

export function startupFailureMessage(err: unknown): StartupFailure {
  const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : 'An unknown error occurred.';
  return { title: 'BG Auto Translator could not start', detail };
}

/** Runs app initialisation; on failure reports it once (the app shows a dialog and exits) instead of dying silently. */
export async function runStartup(init: () => Promise<void>, onFailure: (failure: StartupFailure) => void): Promise<boolean> {
  try {
    await init();
    return true;
  } catch (err) {
    onFailure(startupFailureMessage(err));
    return false;
  }
}

interface PermissionSession {
  setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void): void;
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string) => boolean): void;
}

/** Electron grants every permission request by default (camera, microphone, ...); the app needs none. */
export function denyAllPermissions(session: PermissionSession): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
