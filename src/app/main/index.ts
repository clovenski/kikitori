import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';

const smoke = process.argv.includes('--smoke');
// `import.meta.url`-based root discovery in src/core does not work from a bundle.
process.env.BGT_PROJECT_ROOT ??= app.getAppPath();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: !smoke,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

void app.whenReady().then(() => {
  ipcMain.handle('app:ping', () => 'pong');
  const win = createWindow();

  if (smoke) {
    const timer = setTimeout(() => {
      console.error('SMOKE TIMEOUT');
      app.exit(1);
    }, 30_000);
    win.webContents.once('did-finish-load', async () => {
      try {
        const reply = await win.webContents.executeJavaScript(
          'window.bgt ? window.bgt.ping() : Promise.resolve("no-bridge")',
        );
        clearTimeout(timer);
        if (reply === 'pong') {
          console.log('SMOKE OK');
          app.exit(0);
        } else {
          console.error(`SMOKE FAIL: ${String(reply)}`);
          app.exit(1);
        }
      } catch (err) {
        console.error('SMOKE ERROR', err);
        app.exit(1);
      }
    });
  }
});

app.on('window-all-closed', () => app.quit());
