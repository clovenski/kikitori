import electronUpdater, { type AppUpdater, type ProgressInfo } from 'electron-updater';
import type { UpdaterPort } from './update-service';

/** The real updater: reads the latest GitHub Release named in the `app-update.yml` that electron-builder embeds. */
export function createUpdaterPort(): UpdaterPort {
  let updater: AppUpdater | null = null;
  // Built on first use, so a development run or the smoke test never touches it.
  const get = (): AppUpdater => {
    if (!updater) {
      // electron-updater is CommonJS; its named exports are not visible to an ES module import.
      updater = electronUpdater.autoUpdater;
      // The user decides when to download and when to restart; nothing happens behind their back.
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
    }
    return updater;
  };
  return {
    async check() {
      const result = await get().checkForUpdates();
      return result?.isUpdateAvailable ? { version: result.updateInfo.version } : null;
    },
    async download(onProgress) {
      const u = get();
      const listener = (p: ProgressInfo) => onProgress(p.percent);
      u.on('download-progress', listener);
      try {
        await u.downloadUpdate();
      } finally {
        u.off('download-progress', listener);
      }
    },
    install() {
      // Silent: the wizard-style installer would ask questions the user already answered. Start the new version afterwards.
      get().quitAndInstall(true, true);
    },
  };
}
