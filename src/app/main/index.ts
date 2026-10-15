import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, protocol, session, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import { openDb } from '../../core/db';
import { Repo } from '../../core/db/repo';
import { StageRepo } from '../../core/db/stage-repo';
import { addChannel as followChannel, checkChannel } from '../../core/channels/check';
import { ChannelStore } from '../../core/db/channel-repo';
import { SubmissionStore } from '../../core/db/submission-repo';
import { createPerfStore } from '../../core/pipeline/estimate';
import { createRealDeps } from '../../core/pipeline/real-deps';
import { createRealModelPool } from '../../core/pipeline/real-llm';
import { startChildTracking } from '../../core/tools/children';
import { transcribeModelName, wantsOfOptions } from '../../core/setup/components';
import { detectHardware } from '../../core/setup/hardware';
import { freeDiskBytes, installComponents, removeDamaged, uninstallComponents } from '../../core/setup/installer';
import { ensureInstalled } from '../../core/setup/plan';
import { currentTier, ensureSettings } from '../../core/setup/settings';
import { loadLock } from '../../core/tools/lock';
import { dataDir, projectRoot, resolveTool, resourcesDir } from '../../core/tools/paths';
import { updateYtDlp } from '../../core/tools/ytdlp';
import { CHANNELS } from '../shared/ipc';
import { ChannelWatcher } from './channel-watcher';
import { createHandlers } from './handlers';
import { broadcast, registerIpc } from './ipc';
import { resolveAppPaths } from './app-paths';
import { SetupService } from './setup-service';
import { buildMediaResponse, parseMediaUrl, resolveMediaPath } from './media';
import { denyAllPermissions, runShutdown, runStartup, shouldConfirmQuit } from './lifecycle';
import { isAllowedNavigation } from './navigation';
import { JobQueue } from './queue';
import { runSubmission } from './run-submission';

const smoke = process.argv.includes('--smoke');
// Every location is decided before any core code reads it (`import.meta.url` root discovery does not work from a bundle).
const paths = resolveAppPaths({
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  appData: app.getPath('appData'),
  documents: app.getPath('documents'),
  env: process.env,
});
process.env.BGT_PROJECT_ROOT = paths.projectRoot;
process.env.BGT_RESOURCES_DIR = paths.resourcesDir;
process.env.BGT_DATA_DIR = paths.dataDir;
process.env.BGT_OUTPUT_DIR = paths.outDir;
if (paths.userData) app.setPath('userData', paths.userData);

const REFERER = 'https://bgt.local/';
protocol.registerSchemesAsPrivileged([
  { scheme: 'bgt-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let queue: JobQueue | null = null;
let quitting = false;

let quitConfirmed = false;

/** Asks before quitting while a job runs. Used by the close button and by File > Exit alike. */
function confirmQuit(parent: BrowserWindow | undefined): boolean {
  if (quitConfirmed || quitting || !queue || !shouldConfirmQuit(queue.list())) return true;
  const options = {
    type: 'question' as const,
    buttons: ['Keep running', 'Quit and resume later'],
    defaultId: 0,
    cancelId: 0,
    message: 'A job is still running.',
    detail: 'If you quit now it is paused and can be resumed the next time you open the app.',
  };
  const choice = parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
  if (choice === 0) return false;
  quitConfirmed = true; // the window closing next must not ask a second time
  return true;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    show: !smoke,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Anything that is not our own page opens in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const appUrl =
    process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(path.join(import.meta.dirname, '../renderer/index.html')).toString();
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedNavigation(url, appUrl)) e.preventDefault();
  });
  win.on('close', (e) => {
    if (!confirmQuit(win)) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

function configureSession(): void {
  const ses = session.defaultSession;
  denyAllPermissions(ses);
  // The YouTube embed refuses requests without a plausible referrer (player error 153).
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.youtube.com/*', 'https://*.youtube-nocookie.com/*'] }, (details, cb) => {
    details.requestHeaders.Referer = REFERER;
    cb({ requestHeaders: details.requestHeaders });
  });
  if (!process.env.ELECTRON_RENDERER_URL) {
    const csp = [
      "default-src 'self'",
      "script-src 'self' https://www.youtube.com https://s.ytimg.com",
      "style-src 'self' 'unsafe-inline'",
      'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
      "img-src 'self' data: https://i.ytimg.com",
      "media-src 'self' bgt-media:",
      "connect-src 'self'",
    ].join('; ');
    // Only our own pages get this policy; YouTube's embed page must keep its own.
    ses.webRequest.onHeadersReceived({ urls: ['file://*/*', 'bgt-media://*/*'] }, (details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }
}

void app.whenReady().then(() => runStartup(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  configureSession();

  const dir = dataDir();
  // Before anything can start: kill helpers an earlier crash left behind, then record this run's helpers.
  const cleaned = await startChildTracking(path.join(dir, 'children.json'));
  if (cleaned.killed.length > 0) console.log(`Cleaned up ${cleaned.killed.length} orphaned helper process(es).`);
  const outDir = path.resolve(paths.outDir);
  const db = openDb(path.join(dir, 'bgt.sqlite'));
  const repo = new Repo(db);
  repo.resetRunningJobs(); // a crash or hard kill can leave jobs claiming to be running
  const stages = new StageRepo(db);
  const store = new SubmissionStore(db);
  const channelStore = new ChannelStore(db);
  const lock = loadLock(path.join(projectRoot(), 'tools.lock.json'));
  const resources = resourcesDir();
  ensureSettings({ dataDir: dir, lock, resources }); // a checkout that already has a whole tier needs no wizard
  const tier = () => currentTier(dir);
  const model = () => transcribeModelName(tier());
  const setup = new SetupService({
    lock,
    resourcesDir: resources,
    dataDir: dir,
    hardware: () => detectHardware(),
    install: installComponents,
    uninstall: uninstallComponents,
    removeDamaged,
    freeBytes: freeDiskBytes,
    jobRunning: () => queue?.list().some((s) => s.state === 'running') ?? false,
    updateYtDlp: () => updateYtDlp(resolveTool('yt-dlp')),
    emit: (p) => broadcast(CHANNELS.setupProgress, p),
    log: (m) => console.log(m),
  });
  const channelDeps = { store: channelStore, ytdlpPath: () => resolveTool('yt-dlp'), log: (m: string) => console.log(m) };
  const watcher = new ChannelWatcher({
    store: channelStore,
    check: (channel, signal) => checkChannel(channelDeps, channel, signal),
    canRun: () => {
      const state = setup.state();
      if (state.needsWizard || state.installing) return false;
      try {
        resolveTool('yt-dlp');
        return true;
      } catch {
        return false;
      }
    },
    onChanged: () => broadcast(CHANNELS.channelsChanged, null),
    log: (m) => console.log(m),
  });
  const pool = createRealModelPool({ log: (m) => console.log(m), tier });
  const probeDeps = () => createRealDeps({ dataDir: dir, model: model(), db, log: () => {} }).deps;

  queue = new JobQueue({
    store,
    run: (sub, ctx) =>
      runSubmission(
        {
          repo,
          stages,
          // The installed tier decides the speech model; a submission from before a tier switch still runs.
          makeDeps: () => createRealDeps({ dataDir: dir, model: model(), db, log: (m) => console.log(m) }).deps,
          autoGlossary: () => setup.autoGlossaryAvailable(),
          workRoot: path.join(dir, 'work'),
          outDir,
          pool,
          log: (m) => console.log(m),
        },
        sub,
        ctx,
      ),
    emitChanged: (subs) => broadcast(CHANNELS.queueChanged, subs),
    emitProgress: (p) => broadcast(CHANNELS.queueProgress, p),
  });

  registerIpc(
    createHandlers({
      repo,
      stages,
      queue,
      probe: (source) => probeDeps().probe(source),
      speedFactor: () => createPerfStore(path.join(dir, 'perf.json')).read(),
      pickFile: async (kind) => {
        const filters =
          kind === 'media'
            ? [{ name: 'Audio and video', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'] }]
            : [{ name: 'Glossary JSON', extensions: ['json'] }];
        const r = await dialog.showOpenDialog({ properties: ['openFile'], filters });
        return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
      },
      openFolder: async (folder) => {
        await shell.openPath(folder);
      },
      outDir,
      fileExists: existsSync,
      setup,
      openNotices: async () => {
        await shell.openPath(path.join(projectRoot(), 'THIRD_PARTY_NOTICES.md'));
      },
      ensureReady: (options) => ensureInstalled(lock, tier(), wantsOfOptions(options), resources),
      transcribeModel: model,
      channels: { store: channelStore, add: (input) => watcher.runTracked((signal) => followChannel(channelDeps, input, signal)), refresh: (id) => watcher.refresh(id) },
    }),
  );

  protocol.handle('bgt-media', (request) => {
    const file = resolveMediaPath(repo, parseMediaUrl(request.url));
    if (!file) return new Response('Not found', { status: 404 });
    return buildMediaResponse(file, request.headers.get('range'));
  });

  const win = createWindow();
  if (smoke) {
    const timer = setTimeout(() => {
      console.error('SMOKE TIMEOUT');
      app.exit(1);
    }, 30_000);
    win.webContents.once('did-finish-load', async () => {
      try {
        const reply = await win.webContents.executeJavaScript(
          'window.bgt ? Promise.all([window.bgt.ping(), window.bgt.library.list(), window.bgt.setup.state()]) : Promise.resolve(["no-bridge"])',
        );
        clearTimeout(timer);
        if (reply[0] === 'pong' && reply[1]?.ok === true && reply[2]?.ok === true) {
          const line = `SMOKE OK wizard=${reply[2].value.needsWizard}`;
          console.log(line);
          if (process.env.BGT_SMOKE_OUT) writeFileSync(process.env.BGT_SMOKE_OUT, line); // packaged GUI apps may not show stdout
          app.exit(0);
        } else {
          console.error(`SMOKE FAIL: ${JSON.stringify(reply)}`);
          app.exit(1);
        }
      } catch (err) {
        console.error('SMOKE ERROR', err);
        app.exit(1);
      }
    });
  } else {
    queue.start();
    watcher.start();
  }

  app.on('before-quit', (event) => {
    if (quitting) {
      event.preventDefault(); // a second quit request must not cut the cleanup short
      return;
    }
    if (!confirmQuit(BrowserWindow.getAllWindows()[0])) {
      event.preventDefault();
      return;
    }
    quitting = true;
    event.preventDefault();
    void runShutdown(
      [
        { name: 'channels', run: () => watcher.stop() },
        { name: 'setup', run: () => setup.cancel() },
        { name: 'queue', run: async () => void (await queue?.shutdown()) },
        { name: 'models', run: () => pool.stopAll() },
        { name: 'database', run: async () => db.close() },
      ],
      10_000,
      (m) => console.log(m),
    ).finally(() => app.exit(0));
  });
}, (failure) => {
  dialog.showErrorBox(failure.title, failure.detail);
  app.exit(1);
}));

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
