import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: './app/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'app/renderer/index.html'),
        popup: path.resolve(__dirname, 'app/renderer/popup.html'),
        welcome: path.resolve(__dirname, 'app/renderer/welcome.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './app/renderer'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
    hmr: true,
  },
  optimizeDeps: {
    exclude: ['electron'],
  },
});
