import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Backend that owns the `pi --mode rpc` child process. */
const API_PORT = Number(process.env.PI_WEBX_PORT ?? 8787);
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: API_ORIGIN,
        changeOrigin: false,
        // SSE must not be buffered by the dev proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
