---
name: add-provider
description: Register a new LLM provider (z.ai, deepseek, groq, openrouter, fireworks, together, mistral, perplexity, …) with moxxy and configure its API key so the user can switch to it.
triggers:
  - add provider
  - new provider
  - install provider
  - register provider
  - add z.ai
  - add deepseek
  - add groq
  - add openrouter
  - add fireworks
  - add together
  - add mistral
  - add perplexity
allowed-tools:
  - provider_add
  - provider_list
  - provider_remove
  - provider_test
  - vault_status
  - vault_list
---

The user wants to add a new LLM provider to moxxy so they can switch to it later (`/provider <name>` or via `provider.name` in moxxy.config.ts). Walk them through these steps; be terse and pause for confirmation between gather → register → key.

## Scope

This skill only handles **OpenAI-compatible** vendors — i.e. those that expose a Chat Completions endpoint shaped like OpenAI's (`/v1/chat/completions`, tool-call format, streaming with `data:` chunks). That covers the vast majority of modern API vendors: z.ai (GLM), deepseek, groq, openrouter, fireworks, together, mistral, perplexity, anyscale, deepinfra, octoai, and many more.

If the vendor speaks a different protocol (Anthropic-style, Google Vertex, custom), tell the user this skill can't handle it and direct them to author a full provider plugin (see `.claude/agents/provider-author.md`).

## 1. Gather the basics

Ask the user, or infer from their request:

- **Provider slug** — short lowercase identifier (e.g. `zai`, `deepseek`, `groq`, `openrouter`). This becomes the registry key, the canonical vault entry name (`<SLUG>_API_KEY`), and what the user types in `/provider <slug>`. Must match `[a-z][a-z0-9-]*`.
- **API base URL** — the vendor's OpenAI-compatible endpoint root. Examples:
  - z.ai → `https://api.z.ai/api/coding/paas/v4`
  - deepseek → `https://api.deepseek.com`
  - groq → `https://api.groq.com/openai/v1`
  - openrouter → `https://openrouter.ai/api/v1`
  - fireworks → `https://api.fireworks.ai/inference/v1`
  - together → `https://api.together.xyz/v1`
  - mistral → `https://api.mistral.ai/v1`
- **Default model id** — the model to use when no other is specified (you'll usually pick the vendor's "flagship" or "best general purpose" model).

If the user hasn't given you the baseURL, look it up via WebFetch on the vendor's docs (search for "openai compatible", "base url", "endpoint") and propose it back to them for confirmation. **Do not guess.**

## 2. Discover the model list

You need to populate a `models` array. Each entry needs `id`, `contextWindow`, `maxOutputTokens?`, `supportsTools`, `supportsStreaming`, `supportsImages?`, `supportsAudio?`.

Two paths, in order of preference:

1. **WebFetch the vendor's models / pricing page** to extract the current catalog. Good search prompts: `"<vendor> models pricing context window"`, `"<vendor> api models list"`. Common locations:
   - z.ai → `https://docs.z.ai/guides/llm/glm-4.6`, `https://z.ai/pricing`
   - deepseek → `https://api-docs.deepseek.com/quick_start/pricing`
   - groq → `https://console.groq.com/docs/models`
   - openrouter → `https://openrouter.ai/models`
   - fireworks → `https://fireworks.ai/models`
2. **The vendor's `/v1/models` endpoint** lists canonical model ids (but not context windows). This needs the API key, which you will NOT have (see step 3 — the key goes straight into the vault, never to you). So prefer WebFetch for discovery; if you must use `/v1/models`, ask the user to run it themselves and paste the model-id list (not the key).

Build the list, show it to the user as a markdown table (id / context / tools / images), and ask them to confirm or trim. **Do not invent context-window numbers.** If a model's context is unknown, ask the user or leave it out.

Tool-call support and streaming default to `true` for OpenAI-compatible vendors (their /v1/chat/completions endpoint inherits both). Only flip them to `false` if you've confirmed the vendor doesn't.

## 3. Store the API key in the vault — via the `/vault` command

**Never ask the user to paste their API key to you.** The key must not pass through the conversation or a tool argument (both are visible to you). Instead, tell the user to store it themselves:

```
/vault set <SLUG>_API_KEY <their-key>
```

Use the uppercase slug, e.g. "Please run `/vault set DEEPSEEK_API_KEY <your-key>` — the value stays local; I'll only get a reference." `<SLUG>_API_KEY` is moxxy's canonical resolution path (config.apiKey → vault → env → prompt), so once it's there the provider picks it up automatically. **Stop and wait** for the user to confirm before continuing.

After they run it you'll get a note confirming storage and the reference `${vault:<SLUG>_API_KEY}` — you never see the key itself.

## 4. (Optional) Test the endpoint

`provider_test` needs the plaintext key, which you don't have — so don't call it with the key yourself. To verify the endpoint, either:
- ask the user to run a quick check themselves, or
- skip ahead: after registering (step 5), have the user run `moxxy doctor`, which resolves `<SLUG>_API_KEY` from the vault and reports whether the provider's key is present.

## 5. Register the provider

Call `provider_add` with the gathered fields:

```json
{
  "kind": "openai-compat",
  "name": "<slug>",
  "baseURL": "<base url>",
  "defaultModel": "<id>",
  "models": [
    { "id": "<id>", "contextWindow": 200000, "supportsTools": true, "supportsStreaming": true }
  ]
}
```

`provider_add` does two things atomically:
1. Registers the provider in the LIVE session — switchable immediately.
2. Persists to `~/.moxxy/providers.json` so it survives restarts.

If `provider_add` returns `{ replaced: true }`, mention that to the user — it means a provider with the same slug already existed and they just overwrote it.

## 6. Help them switch to it (optional)

Ask if they want this provider as the default:

- **Just this session** → suggest `/provider <slug>` (typed in the TUI). Don't do it for them unless asked.
- **Permanently** → offer to edit `moxxy.config.ts` and set `provider.name` (and optionally `provider.model`) to the new values. Use the Edit tool. Mention they can run `moxxy doctor` afterward to confirm the key resolves.

## 7. Summarize

Report:
- Provider slug + baseURL + default model.
- That the API key is in the vault under `<SLUG>_API_KEY` (the user stored it via `/vault set`).
- That `~/.moxxy/providers.json` was updated and the provider is live this session.
- How to switch to it.

## Don't

- Don't ask the user to paste their API key to you, and don't call any tool with the key as an argument. Direct them to `/vault set <SLUG>_API_KEY <key>` so it never enters the conversation.
- Don't invent baseURLs, model ids, or context windows. If you're not sure, WebFetch or ask.
- Don't store the API key anywhere except the vault. Never write it into a file in the repo, never echo it back.
- Don't try to handle non-OpenAI-compatible vendors here — those need a real provider plugin (`.claude/agents/provider-author.md`).
- Don't overwrite an existing provider slug without telling the user first. Call `provider_list` if you're unsure whether the slug is taken.
- Don't auto-edit `moxxy.config.ts` to switch the default without asking. The user may want to keep their current provider as primary.
