import { defineConfig } from 'electron-vite';
import path from 'path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'app/main/main.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@main': path.resolve(__dirname, 'app/main'),
        '@shared': path.resolve(__dirname, 'app/shared'),
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          preload: path.resolve(__dirname, 'app/main/preload.ts'),
        },
      },
    },
  },
  renderer: {
    // This will be handled by the separate vite config
  },
});