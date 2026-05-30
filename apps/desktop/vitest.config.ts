import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Two test environments coexist:
 *   - jsdom for renderer (React) tests under `src/`.
 *   - node for main-process tests under `electron/`.
 *
 * `environmentMatchGlobs` routes each test file to the right env so
 * we don't bloat node tests with a fake DOM.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'electron/shared'),
    },
  },
  test: {
    globals: false,
    setupFiles: ['./src/test-setup.ts'],
    environmentMatchGlobs: [
      ['src/**', 'jsdom'],
      ['electron/**', 'node'],
    ],
    include: ['src/**/*.test.{ts,tsx}', 'electron/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test-setup.ts',
        'electron/main/index.ts',
        'electron/preload/index.ts',
        'src/main.tsx',
      ],
    },
  },
});
