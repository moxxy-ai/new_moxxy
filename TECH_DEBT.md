# Tech debt — code-quality audit follow-ups

Backlog from the May 2026 plugin-by-plugin code-quality audit (38-agent analysis →
18-agent fix sweep). The **safe high-value subset** is already done and lives on
branch `refactor/code-quality-sweep` (commits `74359b8` SDK foundation, `e5690d6`
adoption + fixes). This file tracks what was **deliberately deferred** and what
fix agents **blocked** as unsafe to do mechanically.

Audit scoring snapshot: every package averaged ≥ 3.57/5; the default blocks
(`compactor-summarize`, `cache-strategy-stable-prefix`, `mode-tool-use`) were
near-exemplary. 206 findings (18 high · 67 medium · 121 low). 11 of 18 highs are
fixed; the remaining 7 are below (design-change or large test-suite work).

---

## P1 — High, deferred (design or large effort)

### 1. Promote runtime session capabilities onto the `ClientSession`/`SessionLike` contract
**Findings:** plugin-cli #4, plugin-telegram #6, cross-cut 2.4 (all **high**). **Risk:** design-change.
Channels reach off-contract via `session as unknown as { readyProviders | credentialResolver | mcpAdmin | detach }`:
- read sites: `plugin-cli/src/session/run-slash.ts:155`, `picker-handlers.ts:86,104,143,165`,
  `use-mcp-status.ts:21`; `plugin-telegram/src/channel/slash-handler.ts:134`, `callback-handler.ts:148,174`
- write sites (CLI monkey-patches them on): `packages/cli/src/.../activate-provider.ts:123,132`, `builtins.ts:338`

These casts silently break against a `RemoteSession` — the exact scenario the runner/thin-client
split exists for. **Deferred because** it changes the SDK `ClientSession` contract and is entangled
with the in-flight runner/thin-client work; it should be designed with that, not bolted on here.
**Action:** add typed optional views to `ClientSession` (`mcpAdmin?`, `credentialResolver?`, and a
reconciled `readyProviders` — contract says `ReadonlyArray<string>`, callers want `Set<string>`),
set them via a typed setter on core's `Session` (not a cast), delete the `as unknown as` casts, and
make the TUI/Telegram degrade gracefully when a `RemoteSession` leaves them undefined.

### 2. Tests for security-critical code with zero coverage
**Findings:** vault #10/#11, plugin-cli #5, plugin-mcp #14 (all **high**). **Risk:** mechanical but large.
Deferred from this sweep (it explicitly excluded large new test suites). Add:
- `packages/plugin-vault/src/keysource.test.ts` — the full key-resolution precedence (env → keytar →
  disk → prompt), first-prompt persistence, keytar↔disk cross-backfill, `resolvedName`, and the
  disk file being mode `0o600`. Assert env-derived keys are NOT persisted.
- vault `store.ts` canary / legacy-vault / `VaultPassphraseError` paths (`store.ts:90-149`): wrong-passphrase
  raises the friendly error w/ recovery hint; legacy (no-canary) vault backfills a canary and still verifies.
- `packages/plugin-cli/src/components/chat/pair-events.test.ts` — the 356-LOC event-folding state machine
  (`pairToolEvents`, `blocksEquivalent`, `isSettled`, `countToolCalls`): tool↔result pairing, orphan tool
  calls across a turn boundary, skill grouping + assistant continuation, compact-tool live aggregation,
  subagent lifecycle.
- `packages/plugin-mcp/src/admin/*.test.ts` — `mcp_add_server` collision + persistence, `attachServerLazy`
  /`getOrConnect` retry, `refreshServerCache` rollback, `mcp_remove_server` race, skill frontmatter.

### 3. Collapse the duplicate RFC 8628 device-flow in plugin-oauth
**Finding:** oauth #12 (**high**). **Risk:** moderate. **Blocked** by the fix agent (see Blocked §B1).
`src/oauth/device-flow.ts` (`runDeviceCodeFlow`) duplicates `src/adapters/rfc8628-device-flow.ts`
(~90 lines) and they've already drifted. Not collapsible mechanically because the legacy path
conditionally sends `client_secret` and surfaces interval/expiry in seconds vs the adapter's
`*Ms`. **Action:** unify deliberately — extend the rfc8628 adapter to cover the legacy dialect (or
explicitly fork two named adapters), repoint `tools.ts`, and keep tests green.

---

## P2 — Medium

### 4. Plugin `version` literals are hardcoded and wrong
**Cross-cut 2.9.** ~30 packages hardcode `definePlugin({ version: '0.0.0' })` while `package.json` is
`0.0.1`; two say `'1.2.3'`/`'1.0.0'`. The runtime-reported version is meaningless.
**Action (pick one, apply uniformly):** have `PluginLoader` stamp `spec.version` from the package
manifest it already reads, then drop the literals; or inject the version at build time. Touches core
loader semantics — a deliberate decision, not a per-package edit.

### 5. `moxxy.plugin` manifest `kind` is semantically wrong for non-plugin packages
**Cross-cut 2.10.** Both embedders declare `kind: 'tools'` but export no `definePlugin` (they're
injected `EmbeddingProvider` classes); the three isolators declare `kind: 'hooks'` but export a
factory + singleton `Isolator`. **Action:** either remove the manifest from packages that aren't
loaded as `PluginSpec`s, or add an `'isolator'`/`'embedder'` kind the loader understands and align
the entry exports. Requires a loader-semantics decision.

### 6. Add a tool/platform `MoxxyErrorCode`
Flagged by the tools-builtin and computer-control fix agents (see Blocked §B2). `MoxxyErrorCode` is a
fixed union with no IO/tool/platform/ABORTED member, so tool failures were wrapped as `INTERNAL`.
**Action:** add e.g. `TOOL_ERROR` / `PLATFORM_UNSUPPORTED` / `ABORTED` to `packages/sdk/src/errors.ts`
and re-tag the `INTERNAL` placeholders in tools-builtin / computer-control.

### 7. Shared HTTP-channel server base
**Cross-cut 1.4.** `readRequestBody` + `bearerTokenMatches` are now shared (done), but each HTTP
surface still rolls its own `createServer`/`listen`/health/routing (`plugin-channel-http`,
`plugin-channel-web`, `plugin-webhooks`). **Action:** an optional `HttpChannelServer` base in the SDK
so they differ only in routing. (Deferred — larger refactor, lower payoff than the helpers already hoisted.)

### 8. Unify tunnel subprocess management + make webhooks use `TunnelProviderDef`
**Cross-cut 1.5.** Three near-identical spawn-CLI-and-parse-URL impls (`channel-web/cloudflared.ts`,
`channel-web/ngrok.ts`, `webhooks/tunnel.ts`); webhooks ignores the existing `TunnelProviderDef`
contract entirely. **Action:** hoist a `spawnCliTunnel({cmd,args,urlRegex})` helper; make webhooks
consume registered `TunnelProviderDef`s instead of its bespoke `tunnel.ts`.

### 9. `runSingleShotTurn` mode-helper
**Cross-cut 1.9.** The ~40-line `emit provider_request → collectProviderStream({includeTools:false})
→ emit response/error` block is duplicated across `mode-deep-research` (twice), `mode-plan-execute`,
`mode-bmad`. **Action:** add `runSingleShotTurn(ctx, messages, opts)` to SDK `mode-helpers` and
collapse the phases onto it (also fixes deep-research's skipped `runElisionIfNeeded` in one place).
Deferred because it changes mode event-emission and warrants its own focused review.

### 10. Finish MoxxyError adoption / HTTP-status classification
**Cross-cut 1.7, 1.13, 2.6.** The clear user-facing throws were converted. Remaining: oauth
input/usage-validation throws (`tools.ts:~114,~146`), browser sidecar-internal throws (cross the
JSON-RPC boundary as strings — low value), and any remaining `throw new Error` in handler bodies.
Route remaining non-OK HTTP paths through `classifyHttpStatus`. Optionally lint-ban bare
`throw new Error` inside handler bodies.

### 11. Persisted-config read validation parity
**Cross-cut 2.12.** provider-admin + mcp now Zod-validate reads (done); audit any remaining store
that still does `JSON.parse(...) as T` with only a shallow shape check and bring it to `safeParse`.

---

## P3 — Low / per-package nits

121 low-severity findings remain (naming, comment hygiene, minor KISS). Not individually tracked here —
they're low-risk polish. Notable clusters worth a future pass:
- `plugin-embeddings-transformers`: `TransformersEmbedder.name` is a static `'transformers'` regardless
  of model, which collides cache namespaces in `CachedEmbeddingProvider` (cross-cut 1.11). Make `name`
  include the model id.
- `plugin-memory` could wrap its raw embedder in the SDK `CachedEmbeddingProvider` instead of the
  parallel `EmbeddingIndex` cache (cross-cut 1.11) — the atomic-write + recall-race fixes are already in,
  so this is now pure simplification.
- Spurious/again-audited `@moxxy/core` prod deps: removed from webhooks/scheduler; **kept** on
  plugin-subagents/plugin-view (their `*.test.ts` import core — devDep is correct) and on
  plugin-cli/plugin-telegram (real core imports: `loadUsageStats`, `PermissionEngine`, `savePreferences`,
  `clearUsageStats`, `newTurnId`). To fully sever the channel→core dep, hoist those provider-neutral
  helpers into `@moxxy/sdk` (cross-cut 2.14) — deferred.

---

## Blocked items (fix agents declined to do mechanically — sound calls)

- **B1.** oauth: collapse legacy `runDeviceCodeFlow` onto the rfc8628 adapter — not behavior-preserving
  (client_secret + seconds-vs-ms divergence). → P1 #3.
- **B2.** tools-builtin / computer-control: no tool/platform `MoxxyErrorCode` exists; used `INTERNAL`. → P2 #6.
- **B3.** plugin-cli/plugin-telegram: kept `@moxxy/core` dep (real imports remain). → P3.
- **B4.** plugin-subagents/plugin-view: kept `@moxxy/core` **dev**Dep — `*.test.ts` import `collectTurn` /
  `defaultViewRenderer` / `Session` from core. (The audit's "zero core imports in src" premise missed test files.)
- **B5.** plugin-cli/plugin-telegram off-contract session casts — deferred. → P1 #1.
- **B6.** mcp `wrap.ts` `throw new Error('aborted')` ×3 — internal abort control-flow, not user-facing; left as-is.
- **B7.** browser sidecar-internal throws and the two `new Error(String(err))` normalizers — left
  (errors cross JSON-RPC as strings; no user-facing code value). → P2 #10.
- **B8.** oauth `tools.ts` missing-URL throws — input validation, not the HTTP/network class targeted. → P2 #10.

---

*Full per-package reports + cross-cut themes were produced by the audit workflow
(`.claude/wf-quality-audit.js`); the fix sweep is `.claude/wf-apply-fixes.js`.*
