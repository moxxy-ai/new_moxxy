import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Workspace packages the main process imports at runtime. They MUST be
 * bundled INTO the main/preload output rather than left as bare
 * `require('@moxxy/…')` calls: electron-builder packs only `dist` /
 * `dist-electron` (not the pnpm symlink farm under node_modules), so an
 * externalized workspace import would `MODULE_NOT_FOUND` in the packaged
 * app. Excluding them from `externalizeDepsPlugin` inlines them.
 */
const BUNDLED_WORKSPACE_DEPS = [
  '@moxxy/runner',
  '@moxxy/sdk',
  '@moxxy/plugin-vault',
  '@moxxy/plugin-stt-whisper-codex',
  '@moxxy/desktop-ipc-contract',
  '@moxxy/desktop-host',
];

/**
 * Native / optional modules that must stay external even though they ride
 * in on a bundled workspace dep. `keytar` is loaded via a guarded dynamic
 * `import('keytar')` (plugin-vault falls back to a disk/passphrase key
 * when it is absent), so it is never statically required — keep it out of
 * the bundle and let it resolve (or gracefully fail) at runtime.
 */
const EXTERNAL_NATIVE = ['keytar'];

/**
 * electron-vite manages three build targets (main / preload / renderer)
 * with one config. Each has its own output dir under `dist-electron/`,
 * and the renderer also writes to `dist/` so it can be served by Vite
 * during dev and packaged by electron-builder for production.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_DEPS })],
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: { index: path.resolve('electron/main/index.ts') },
        external: EXTERNAL_NATIVE,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_DEPS })],
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: { index: path.resolve('electron/preload/index.ts') },
        external: EXTERNAL_NATIVE,
        // A `sandbox: true` window loads its preload as a classic
        // CommonJS script — an ESM (.mjs) preload throws "Cannot use
        // import statement outside a module" and never runs. Emit CJS.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
      // Dedupe React + clerk-react so the wizard's ClerkProvider and
      // any hook that reads Clerk context share a single React tree
      // (pnpm's symlink layout can produce two copies otherwise).
      // We DON'T dedupe @clerk/shared — its sub-path exports
      // (e.g. /loadClerkJsScript) can't be resolved when dedupe
      // collapses it.
      dedupe: ['@clerk/clerk-react', 'react', 'react-dom'],
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'index.html'),
          // Dedicated entry for the floating focus widget. Separate
          // HTML + entry script means the focus window doesn't share
          // any module side-effects with the main app — no #hash
          // routing, no splash fallback bleed, no ClerkProvider, no
          // StrictMode double-mount.
          focus: path.resolve(__dirname, 'focus.html'),
        },
      },
    },
  },
});
