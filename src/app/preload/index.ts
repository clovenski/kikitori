import { contextBridge, ipcRenderer } from 'electron';
import type { BgtApi } from '../shared/ipc';

const api: BgtApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
};

contextBridge.exposeInMainWorld('bgt', api);
