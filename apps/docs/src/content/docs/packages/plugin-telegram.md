---
title: '@moxxy/plugin-telegram'
description: Telegram bot channel via grammy with bot-issued code pairing.
---

`@moxxy/plugin-telegram` is a `Channel` that drives a moxxy `Session`
through a Telegram bot. One bot is paired to exactly one chat via a
6-digit bot-issued code (TOFU). After pairing, the bot answers only
the authorized chat.

## Install

```sh
pnpm add @moxxy/plugin-telegram
```

Requires `grammy` (already a dep) and a `VaultStore` for the bot
token + paired chat id.

## Build

```ts
import { buildTelegramPlugin } from '@moxxy/plugin-telegram';

const plugin = buildTelegramPlugin({ vault });
session.pluginHost.registerStatic(plugin);
```

Then start it as a channel:

```sh
moxxy channels telegram pair      # open the bot-issued code pairing window
moxxy telegram                    # auto-authorize and run forever
moxxy service install telegram    # promote to a background unit
```

## Pairing flow

1. Terminal opens a pairing window (`beginPairing`).
2. User sends `/start` to the bot. The handler generates a 6-digit
   code and DMs it back (`handleStart`).
3. User pastes it into the terminal (`submitTerminalCode`). Match → the
   chat id persists to the vault as `telegram_authorized_chat_id`.

State machine: `packages/plugin-telegram/src/pairing.ts`.

## Tools

| Tool | Purpose |
|---|---|
| `telegram_set_token` | Store a token in the vault under `telegram_bot_token`. |
| `telegram_status` | Token + paired-chat state (no secrets). |
| `telegram_send_message` | Push a one-off message to the authorized chat. |
| `telegram_unpair` | Forget the authorized chat. |

`telegram_send_message` is the link that makes the scheduler useful
from the Telegram side — `--channel telegram` schedules expect the
prompt to call it.

## Slash commands

In addition to the shared registry commands (`/info`, `/clear`, `/new`,
`/exit`, `/help`), the channel adds `/model`, `/mode`, `/yolo`,
`/tools`, `/skills`, `/cancel`. Both groups are published to Telegram's
`/`-picker on startup.

## Vault keys

| Key | What it holds |
|---|---|
| `telegram_bot_token` | The bot's API token. |
| `telegram_authorized_chat_id` | The numeric chat id paired to this bot. |

## See also

- [Telegram channel guide](../guides/telegram-channel) — bot setup, pairing, slash commands.
- [Running as a service](../guides/running-as-a-service) — launchd / systemd.
