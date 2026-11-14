import { defineConfig } from 'vite';
import { harnessPlugin } from './tools/harness-plugin.mjs';

// In development the page runs on :5173 and talks to the Python server on :8000.
export default defineConfig({
  plugins: [harnessPlugin()], // lets /harness.html save its sheets to .deck/harness/
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
      '/api': 'http://127.0.0.1:8000',
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
