import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/app/main/index.ts') },
        external: [/^node:/],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/app/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/app/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve('src/app/renderer/index.html') } } },
  },
});
