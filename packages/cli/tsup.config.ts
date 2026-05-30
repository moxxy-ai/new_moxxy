import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Bundle @moxxy/cli into a single self-contained binary.
 *
 * Everything first-party (@moxxy/core, every plugin, modes, isolators, …)
 * is inlined: those packages live in cli's devDependencies so pnpm links
 * them at build time, and tsup only auto-externalizes runtime
 * `dependencies` — so devDeps get bundled.
 *
 * EXTERNAL (resolved from node_modules at runtime, never inlined):
 *   - @moxxy/sdk      the published public contract; ONE shared instance so
 *                     discovered third-party plugins share it with the builtins
 *   - zod             sdk's peer dep; must be the SAME instance the builtins and
 *                     third-party plugins use, or cross-boundary schemas diverge
 *   - keytar          native module, cannot be bundled (vault degrades to disk key)
 *   - playwright      huge; optional (browser plugin throws a clear hint if absent)
 *   - @huggingface/transformers  huge; optional (embedder falls back to TF-IDF)
 * keytar/playwright/transformers are loaded via dynamic import() with graceful
 * fallback already; @moxxy/sdk + zod ship as real runtime dependencies.
 */
export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    // Emitted as a standalone sibling so the Read tool's
    // `handlerModule: { url: new URL('./read-handler.js', import.meta.url) }`
    // (tools-builtin/src/read.ts) still resolves next to the bundled bin.
    // Out-of-process isolators (worker/subprocess/wasm) re-import this URL.
    'read-handler': '../tools-builtin/src/read-handler.ts',
    // Playwright browser sidecar, run as a child process via
    // `node dist/sidecar.js`. plugin-browser's `defaultSidecarPath()` resolves
    // it next to its own module — which, once bundled into bin.js, is dist/ —
    // so it MUST be emitted here too. Without it, `browser_session` spawns a
    // missing file and the sidecar exits code=1.
    sidecar: '../plugin-browser/src/sidecar.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  bundle: true,
  splitting: false,
  treeshake: true,
  sourcemap: true,
  clean: true,
  dts: false, // a binary ships no types; `tsc --noEmit` still typechecks
  shims: false, // code uses import.meta.url directly; no __dirname shims
  external: ['@moxxy/sdk', 'zod', 'keytar', 'playwright', '@huggingface/transformers'],
  // Several bundled CJS deps (ulid, jiti, …) call require() for node builtins.
  // ESM output has no `require`, so esbuild's __require stub throws. Inject a
  // real createRequire-backed `require` so those calls resolve. esbuild keeps
  // the entry shebang as line 1 and places this banner after it.
  banner: {
    js: "import { createRequire as __moxxyCreateRequire } from 'node:module';\nvar require = __moxxyCreateRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    // Ink/React TUI — matches cli tsconfig "jsx": "react-jsx".
    options.jsx = 'automatic';
    options.jsxImportSource = 'react';
    // ink dynamically imports react-devtools-core only under DEV=true; it's a
    // dev-only dep that isn't installed. Alias it to an empty stub so the
    // bundle resolves; the devtools path never runs in a normal session.
    options.alias = {
      ...options.alias,
      'react-devtools-core': path.resolve(here, 'scripts/devtools-stub.mjs'),
      // Bundled deps (whatwg-url/tr46 via node-fetch, uri-js via ajv) call bare
      // require("punycode"), which resolves to Node's DEPRECATED builtin (DEP0040).
      // Redirect to the API-compatible userland package so esbuild inlines it and
      // the deprecation warning never fires. (`punycode/` forces node_modules.)
      punycode: 'punycode/',
    };
  },
  async onSuccess() {
    // bin.ts already carries the shebang; tsup preserves it. Just make it executable.
    await fs.chmod(path.resolve(here, 'dist/bin.js'), 0o755);
    // Copy builtin skill markdown next to the bin so the cli-local
    // BUILTIN_SKILLS_DIR (see setup/builtins.ts) resolves post-bundle.
    const skillsSrc = path.resolve(here, '../skills-builtin/skills');
    const skillsDest = path.resolve(here, 'dist/skills');
    await fs.rm(skillsDest, { recursive: true, force: true });
    await fs.cp(skillsSrc, skillsDest, { recursive: true });

    // Copy the web-surface frontend bundle next to the bin. When bundled, the
    // WebChannel's import.meta.url is dist/bin.js, so it serves from dist/public
    // — without this copy the browser gets "web surface bundle missing".
    const webSrc = path.resolve(here, '../plugin-channel-web/dist/public');
    const webDest = path.resolve(here, 'dist/public');
    if (await fs.stat(webSrc).then(() => true).catch(() => false)) {
      await fs.rm(webDest, { recursive: true, force: true });
      await fs.cp(webSrc, webDest, { recursive: true });
    } else {
      console.warn(`[cli build] web frontend missing at ${webSrc} — build @moxxy/plugin-channel-web first`);
    }
  },
});
