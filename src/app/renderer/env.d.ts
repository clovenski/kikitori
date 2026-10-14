/// <reference types="vite/client" />
import type { BgtApi } from '../shared/ipc';

declare global {
  interface Window {
    bgt: BgtApi;
  }
}

export {};
