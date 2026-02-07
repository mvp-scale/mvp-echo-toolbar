import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: './app/renderer',
  base: './',
  publicDir: 'public',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './app/renderer'),
      '@/components': path.resolve(__dirname, './styleGuide/components'),
      '@/lib': path.resolve(__dirname, './styleGuide/lib'),
      '@/hooks': path.resolve(__dirname, './styleGuide/hooks'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
    middlewareMode: false,
    hmr: {
      port: 5174,
    },
  },
  optimizeDeps: {
    exclude: ['electron'],
  },
});