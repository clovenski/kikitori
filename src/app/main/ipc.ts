import { BrowserWindow, ipcMain } from 'electron';
import { CHANNELS } from '../shared/ipc';
import type { Handlers } from './handlers';

export function registerIpc(handlers: Handlers): void {
  ipcMain.handle(CHANNELS.ping, () => 'pong');
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, arg) => (handler as (a?: unknown) => Promise<unknown>)(arg));
  }
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
