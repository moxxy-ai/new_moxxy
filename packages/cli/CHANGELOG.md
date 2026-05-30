# @moxxy/cli

## 0.1.6

### Patch Changes

- bf8ef82: `moxxy login`: add a `--browser` flag that forces the loopback/browser OAuth flow even when stdin isn't a TTY.

  Previously a GUI host (the desktop app) that spawned `moxxy login <provider>` with piped stdio got the headless device-code flow — the user had to open a URL and type a code by hand. With `--browser`, the CLI runs the loopback flow that opens the system browser automatically and catches the localhost callback, so no copying is needed. (`--no-browser` still forces device-code.)

## 0.1.5

### Patch Changes

- f846b56: `moxxy serve` now boots even when no provider key is configured.

  Previously `serve` activated a provider at startup and exited 1 with `AUTH_NO_CREDENTIALS` when none was found — _before_ binding its socket. Clients (notably the desktop app) then looped forever on "lost the runner / reconnecting" and could never connect to add a provider. `serve` now boots with `tolerateNoProvider` (matching `channels` / `login`): it binds the socket with no active provider, and turns fail with a clear "no provider" error until one is configured.

## 0.1.4

### Patch Changes

- f07d698: Remove the two `npm install` deprecation warnings (`prebuild-install`, `boolean`) and slim the default install.

  `@moxxy/cli` no longer installs heavy native optional dependencies by default:

  - **keytar → `@napi-rs/keyring`**: keytar pulls the deprecated `prebuild-install`; `@napi-rs/keyring` ships per-platform NAPI prebuilds with no install scripts. OS-keychain unlock for the vault is preserved (it still falls back to the disk key / passphrase when the native binary is unavailable).
  - **`@huggingface/transformers` and `playwright` are now install-on-demand** (dropped from `optionalDependencies`). Both were already loaded via guarded dynamic `import()`; the local-embeddings and browser features degrade gracefully and prompt to install when first used. This is what pulled `boolean` (via `onnxruntime-node` → `global-agent`).

  Net effect: `npx @moxxy/cli` installs only `@moxxy/sdk`, `zod`, and `@napi-rs/keyring` — no deprecation warnings, smaller and faster.

- e73b51e: `moxxy init`: collect the vault passphrase as a styled first step instead of a bare prompt.

  On a first run the vault needs a passphrase to derive its encryption key. Previously this fired as an unstyled `readline` prompt _before_ the wizard (and before the logo). It's now a `@clack/prompts` `password` step — rendered under the moxxy logo, with a short description — so it reads as the first pre-requirement step of setup, consistent with the rest of the wizard. Threaded via a new `SetupOptions.passphrasePrompt`; headless `init` is unaffected (still uses `MOXXY_VAULT_PASSPHRASE` / the non-TTY guard).

## 0.1.3

### Patch Changes

- 93d9a2d: Publish with `pnpm publish` instead of `npm publish` so pnpm's `workspace:*` and `catalog:` protocols are rewritten to concrete version ranges in the published `package.json`.

  The previous `npm publish` shipped those protocols verbatim, so `npx @moxxy/cli init` failed on a clean machine with:

  ```
  npm error code EUNSUPPORTEDPROTOCOL
  npm error Unsupported URL Type "workspace:": workspace:*
  ```

  Both `@moxxy/cli` (`dependencies."@moxxy/sdk": "workspace:*"`, `zod: "catalog:"`) and `@moxxy/sdk` (`peerDependencies.zod: "catalog:"`) were affected, so both are republished.

- Updated dependencies [93d9a2d]
  - @moxxy/sdk@0.1.3

## 0.1.0

### Minor Changes

- c4352f9: First published release of the `moxxy` CLI and SDK (off the `0.0.0` placeholder).

### Patch Changes

- Updated dependencies [c4352f9]
  - @moxxy/sdk@0.1.0
