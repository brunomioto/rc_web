import { defineConfig } from 'vite';

// Static site: relative base so it works on GitHub Pages or any host, with no
// special headers (no SharedArrayBuffer, no COOP/COEP).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
});
