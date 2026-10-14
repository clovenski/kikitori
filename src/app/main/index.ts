import path from 'node:path';
import { app, BrowserWindow, dialog, net, protocol, session, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import { openDb } from '../../core/db';
import { Repo } from '../../core/db/repo';
import { StageRepo } from '../../core/db/stage-repo';
import { SubmissionStore } from '../../core/db/submission-repo';
import { createPerfStore } from '../../core/pipeline/estimate';
import { createRealDeps } from '../../core/pipeline/real-deps';
import { createRealModelPool } from '../../core/pipeline/real-llm';
import { dataDir } from '../../core/tools/paths';
import { CHANNELS } from '../shared/ipc';
import { createHandlers } from './handlers';
import { broadcast, registerIpc } from './ipc';
import { parseMediaUrl, resolveMediaPath } from './media';
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
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault();
  });
  win.on('close', (e) => {
    if (quitting || !queue) return;
    const running = queue.list().some((s) => s.state === 'running');
    if (!running) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Keep running', 'Quit and resume later'],
      defaultId: 0,
      cancelId: 0,
      message: 'A job is still running.',
      detail: 'If you quit now it is paused and can be resumed the next time you open the app.',
    });
    if (choice === 0) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

function configureSession(): void {
  const ses = session.defaultSession;
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
    ses.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }
}

void app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  configureSession();

  const dir = dataDir();
  const outDir = path.resolve(process.env.BGT_OUTPUT_DIR ?? path.join(app.getAppPath(), 'output'));
  const db = openDb(path.join(dir, 'bgt.sqlite'));
  const repo = new Repo(db);
  const stages = new StageRepo(db);
  const store = new SubmissionStore(db);
  const pool = createRealModelPool({ log: (m) => console.log(m) });
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
    }),
  );

  protocol.handle('bgt-media', (request) => {
    const file = resolveMediaPath(repo, parseMediaUrl(request.url));
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
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
    quitting = true;
    event.preventDefault();
    void (async () => {
      try {
        await queue?.shutdown();
        await pool.stopAll();
      } finally {
        db.close();
        app.exit(0);
      }
    })();
  });
});

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
