import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, protocol, session, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import { openDb } from '../../core/db';
import { Repo } from '../../core/db/repo';
import { StageRepo } from '../../core/db/stage-repo';
import { SubmissionStore } from '../../core/db/submission-repo';
import { createPerfStore } from '../../core/pipeline/estimate';
import { createRealDeps } from '../../core/pipeline/real-deps';
import { createRealModelPool } from '../../core/pipeline/real-llm';
import { startChildTracking } from '../../core/tools/children';
import { dataDir } from '../../core/tools/paths';
import { CHANNELS } from '../shared/ipc';
import { createHandlers } from './handlers';
import { broadcast, registerIpc } from './ipc';
import { buildMediaResponse, parseMediaUrl, resolveMediaPath } from './media';
import { denyAllPermissions, runShutdown, runStartup, shouldConfirmQuit } from './lifecycle';
import { isAllowedNavigation } from './navigation';
import { JobQueue } from './queue';
import { runSubmission } from './run-submission';

const smoke = process.argv.includes('--smoke');
// `import.meta.url`-based root discovery in src/core does not work from a bundle.
process.env.BGT_PROJECT_ROOT ??= app.getAppPath();

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
  const outDir = path.resolve(process.env.BGT_OUTPUT_DIR ?? path.join(app.getAppPath(), 'output'));
  const db = openDb(path.join(dir, 'bgt.sqlite'));
  const repo = new Repo(db);
  repo.resetRunningJobs(); // a crash or hard kill can leave jobs claiming to be running
  const stages = new StageRepo(db);
  const store = new SubmissionStore(db);
  const pool = createRealModelPool({ log: (m) => console.log(m), tier: () => 'gpu' });
  const probeDeps = () => createRealDeps({ dataDir: dir, model: 'large-v3', db, log: () => {} }).deps;

  queue = new JobQueue({
    store,
    run: (sub, ctx) =>
      runSubmission(
        {
          repo,
          stages,
          makeDeps: (s) => createRealDeps({ dataDir: dir, model: s.options.model, db, log: (m) => console.log(m) }).deps,
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
          'window.bgt ? Promise.all([window.bgt.ping(), window.bgt.library.list()]) : Promise.resolve(["no-bridge"])',
        );
        clearTimeout(timer);
        if (reply[0] === 'pong' && reply[1]?.ok === true) {
          console.log('SMOKE OK');
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
  }

  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!confirmQuit(BrowserWindow.getAllWindows()[0])) {
      event.preventDefault();
      return;
    }
    quitting = true;
    event.preventDefault();
    void runShutdown(
      [
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
