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

### 1. Promote runtime session capabilities onto the contract — ⚠️ MOSTLY DONE
**Findings:** plugin-cli #4, plugin-telegram #6, cross-cut 2.4 (all **high**).
**Done:** added `CredentialResolver`, `McpAdminView`/`McpServerStatusView` to `@moxxy/sdk`,
exposed `readyProviders?`/`credentialResolver?`/`mcpAdmin?` as typed optional members on
`SessionLike` and as declared fields on core's `Session`, and **deleted every `as unknown as`
cast** (8 sites across cli/plugin-cli/plugin-telegram + core's own `getInfo` self-cast).
The host now sets them type-checked; channels read them type-checked.
**Remaining (deferred — the genuine runner/thin-client coupling):** the channel handlers are still
typed against the *concrete* `@moxxy/core` `Session`, not the `ClientSession`/`SessionLike` contract,
so they would not yet compile against a `RemoteSession`. Retype `picker-handlers`/`use-mcp-status`/
`run-slash`/telegram handler params to the SDK contract (now that it carries the capabilities) and
verify graceful degradation when a `RemoteSession` leaves them undefined. Do this alongside the
runner/thin-client work, not standalone.

### 2. Tests for security-critical code with zero coverage — ✅ DONE
**Findings:** vault #10/#11, plugin-cli #5, plugin-mcp #14 (all **high**). Added on this branch (+85 tests):
- `plugin-vault/src/keysource.test.ts` + `store.canary.test.ts` (+17): full key-resolution precedence
  (env→keytar→disk→prompt), env keys NOT persisted, keytar↔disk cross-backfill, `resolvedName`, disk-key
  mode `0o600`; canary write/verify, wrong-passphrase `VaultPassphraseError` with recovery hint,
  legacy-vault backfill.
- `plugin-cli/src/components/chat/pair-events.test.ts` (+24): tool↔result pairing, orphan-at-turn-boundary
  synthesis (the forever-pulsing-dot guard), skill grouping + continuation, compact live-aggregation,
  subagent lifecycle, `isSettled`/`countToolCalls`/`blocksEquivalent`.
- `plugin-mcp/src/admin/*.test.ts` (+44 across 6 files): config-io atomic round-trip + Zod-discard of
  corrupt files, runtime collision/lazy/`getOrConnect` retry/`refreshServerCache` rollback, add dup-guard
  + hot-attach + skill side-effect, remove, test, skill frontmatter YAML.

No bugs surfaced — the security paths behave correctly under test.

### 3. Collapse the duplicate RFC 8628 device-flow in plugin-oauth — ✅ DONE
**Finding:** oauth #12 (**high**). Extracted the shared RFC 8628 device-authorization request +
poll-response classification into `src/oauth/device-flow-shared.ts`
(`requestDeviceAuthorization`, `classifyDeviceTokenResponse`). The legacy `runDeviceCodeFlow` and
the `rfc8628DeviceFlow` adapter now both call it; each keeps only its genuine difference (the legacy
flow appends `client_id`/`client_secret` on the poll; the adapter reports ms vs the legacy's
seconds). Behavior preserved, 22/22 oauth tests green. `openai-device-flow.ts` is a distinct
non-RFC-8628 protocol (two-step authorization_code exchange) and correctly stays separate.

---

## P2 — Medium

### 4. Plugin `version` literals are hardcoded and wrong — ✅ DONE (discovered/installed path)
**Cross-cut 2.9.** `PluginLoader.load` now stamps the manifest's `packageVersion` over the
hardcoded `definePlugin` literal, so discovered/installed plugins (the ones `moxxy plugins list`
shows) report their real `package.json` version (+regression test in `discovery.test.ts`). The
~30 placeholder literals are now ignored on that path — they need not be maintained.
**Remaining (minor):** bundled plugins registered directly via `registerStatic` (no manifest at
register time) still carry their literal. Harmless — they're the framework's own packages; their
"version" is the framework version. Could stamp from a known framework version if it ever matters.

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

### 9. `runSingleShotTurn` mode-helper — ✅ DONE
**Cross-cut 1.9.** Added `runSingleShotTurn(ctx, messages, { maxTokens? })` to SDK `mode-helpers`
(compaction + elision → `provider_request` → `collectProviderStream({ includeTools: false })` →
`error`/`provider_response`). Collapsed all four duplicated blocks onto it: `mode-deep-research`
query + synthesis, `mode-plan-execute` plan, `mode-bmad` collect. As a side effect the planner/collect
turns now run `runElisionIfNeeded` like every other turn (the consistency the finding wanted). All
mode suites green.

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

- **B1.** oauth: collapse legacy `runDeviceCodeFlow` onto the rfc8628 adapter — ✅ resolved via a
  shared-helper extraction (P1 #3 DONE) rather than a full collapse, preserving each flow's genuine difference.
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
