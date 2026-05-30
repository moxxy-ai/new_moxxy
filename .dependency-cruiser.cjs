/**
 * Architectural invariants for moxxy (see AGENTS.md):
 *   1. @moxxy/sdk has zero internal deps — it must not import from any other @moxxy/* package.
 *   2. @moxxy/core must not import from any plugin package
 *      (@moxxy/plugin-*, @moxxy/mode-*, @moxxy/compactor-*, @moxxy/cache-strategy-*,
 *      @moxxy/skills-builtin). Core can only import @moxxy/sdk + @moxxy/tools-builtin.
 *
 * Run with: `pnpm check:deps`
 *
 * Note: plugins CAN import @moxxy/core (e.g., channel plugins like @moxxy/plugin-cli
 * and @moxxy/plugin-telegram need runTurn). The hard rule is the reverse direction:
 * core never depends on a plugin.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-internal-deps-from-sdk',
      severity: 'error',
      comment:
        '@moxxy/sdk must have zero internal dependencies. It is the typed public surface; ' +
        'pulling in any sibling package would create a cycle with everything that imports it.',
      from: { path: '^packages/sdk/src' },
      to: { path: '^packages/(?!sdk/)' },
    },
    {
      name: 'no-plugin-deps-from-core',
      severity: 'error',
      comment:
        '@moxxy/core must not import from any plugin. Plugins are dynamically loaded; ' +
        'a static import from core inverts the dependency arrow.',
      from: { path: '^packages/core/src' },
      to: {
        // Loop strategies were renamed loop-* → mode-*; cache-strategy-* was
        // added. Match all current block packages so the invariant stays
        // enforced. tools-builtin is intentionally NOT listed (core may import it).
        path: '^packages/(plugin-|mode-|compactor-|cache-strategy-|skills-builtin)',
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies between packages indicate a layering bug. Re-route through @moxxy/sdk.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Source files reachable from no entry point are usually dead code. ' +
        'Package entry points (src/index.ts, src/bin.ts, matchers, etc.) are not orphans — they are consumed across the workspace.',
      from: {
        orphan: true,
        pathNot: [
          '\\.test\\.ts$',
          '\\.test-d\\.ts$',
          '__fixtures__/',
          'vitest\\.config\\.',
          'tsconfig\\.',
          'src/index\\.ts$',
          'src/bin\\.ts$',
          'src/matchers\\.ts$',
          // Standalone executables shipped via a package's `bin` field
          // (consumed by spawning a child process, not by being imported).
          'src/sidecar\\.ts$',
          // Electron process entry points — invoked by the Electron
          // runtime / loaded as a window preload, never imported.
          'apps/desktop/electron/main/index\\.ts$',
          'apps/desktop/electron/preload/index\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^(packages/.*/src|apps/desktop/electron)',
    exclude: {
      path: '(dist/|node_modules/|\\.turbo/|\\.test\\.ts$|\\.test-d\\.ts$|__fixtures__/)',
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
