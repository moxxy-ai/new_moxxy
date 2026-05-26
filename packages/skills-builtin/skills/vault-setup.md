---
name: vault-setup
description: Help the user store secrets in the encrypted vault via the /vault command, without the secret ever reaching the model.
triggers: ["set up vault", "initialize vault", "store a secret", "save api key", "need an api key", "provide your key"]
allowed-tools: [vault_status, vault_list]
---
# Vault setup

The user wants to store secrets (API keys, tokens, webhook URLs) in moxxy's encrypted vault.

## The golden rule: never handle the plaintext yourself

**Never ask the user to paste a secret into the chat, and never call a tool with a secret value the user gave you.** Anything the user types to you, and any tool argument you send, is visible to you (the model) and is recorded in the conversation. Secrets must not flow through there.

Instead, **the user stores the secret themselves** with the `/vault` slash command. Its argument is intercepted by the channel and never sent to you — you only ever learn the *reference*.

## How to get a secret stored

When you need a secret from the user (e.g. an API key for a platform), tell them to run:

```
/vault set <NAME> <value>
```

For example: "I need your OpenAI API key. Please run `/vault set OPENAI_API_KEY <your-key>` — the value stays local and I'll only get a reference to it." Then **stop and wait** for the user; don't keep working until they confirm.

After they run it, you'll receive a short note confirming the secret was stored and giving you the reference `${vault:<NAME>}`. Use that reference — you will never see the value.

Naming: use slug-style names like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `slack_webhook_url` (letters, digits, `_`, `.`, `-`).

## Using a stored secret

- In `moxxy.config.ts` / `moxxy.config.yaml`: write `${vault:OPENAI_API_KEY}` anywhere a string is expected. The CLI resolves it on session start.
- For a tool/integration that needs the value at call time: pass the `${vault:NAME}` reference where supported, or let the integration resolve it — do not fetch and inline the plaintext.

## Where things live

`~/.moxxy/vault.json` — AES-256-GCM ciphertext per entry. The master key comes from the OS keychain (macOS Keychain / libsecret / Windows Credential Manager) when available, otherwise a passphrase prompt; on headless systems set `MOXXY_VAULT_PASSPHRASE`. The first vault use triggers the unlock.

## Verify

Call `vault_list` (names + metadata only, never plaintext) or have the user run `/vault list` to confirm the entry is present.

## Don't

- Don't ask the user to type or paste a secret value into the chat — direct them to `/vault set` instead.
- Don't print the plaintext of an existing secret. If the user wants to verify, suggest they run `/vault list`.
- Don't reuse a name for two different secrets — storing overwrites silently.
