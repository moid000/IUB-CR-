import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Same-origin API: /api/* is either proxied to the local Express server
// (dev) or rewritten to the serverless function on Vercel (prod).
// No API base URL or secret ever needs to be embedded in the bundle.
export default defineConfig({
  base: '/frontend/', // static-build output is namespaced under /frontend/ on Vercel
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
});
