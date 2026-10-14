import { contextBridge, ipcRenderer } from 'electron';
import type { BgtApi } from '../shared/ipc';

// Temporary narrow type: the full API is exposed in the lifecycle task.
const api: Pick<BgtApi, 'ping'> = {
  ping: () => ipcRenderer.invoke('app:ping'),
};

contextBridge.exposeInMainWorld('bgt', api);
