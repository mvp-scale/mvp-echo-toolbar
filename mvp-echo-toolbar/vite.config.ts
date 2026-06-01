import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

// Dev-only plugin: serves model files at /model-files/* from the local sherpa_onnx_models directory
function serveModelFiles(): Plugin {
  const modelDir = path.resolve(__dirname, 'sherpa_onnx_models/sherpa-onnx-nemo-parakeet-ctc-0.6b-en-int8');
  return {
    name: 'serve-model-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/model-files/')) {
          const fileName = req.url.replace('/model-files/', '');
          const filePath = path.join(modelDir, fileName);
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
          res.statusCode = 404;
          res.end('Model file not found');
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveModelFiles()],
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
    port: 5175,
    strictPort: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    hmr: true,
    fs: {
      allow: ['../..'],
    },
  },
  optimizeDeps: {
    exclude: ['electron', 'onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
});
