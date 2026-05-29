import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * electron-vite manages three build targets (main / preload / renderer)
 * with one config. Each has its own output dir under `dist-electron/`,
 * and the renderer also writes to `dist/` so it can be served by Vite
 * during dev and packaged by electron-builder for production.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: { index: path.resolve('electron/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: { index: path.resolve('electron/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: '.',
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '@shared': path.resolve(__dirname, 'electron/shared'),
        // @clerk/elements optionally peers on Next.js for SSR. We're
        // a plain Vite + Electron app; satisfy the imports with no-op
        // shims so the bundle doesn't try to resolve real Next.
        'next/compat/router': path.resolve(__dirname, 'src/lib/next-compat-shim.ts'),
        'next/navigation': path.resolve(__dirname, 'src/lib/next-compat-shim.ts'),
        'next/router': path.resolve(__dirname, 'src/lib/next-compat-shim.ts'),
      },
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: { index: path.resolve(__dirname, 'index.html') },
      },
    },
  },
});
