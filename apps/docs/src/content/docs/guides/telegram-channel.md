---
title: Telegram channel
description: Bot setup, the bot-issued pairing flow, slash commands, and running as a service.
---

`@moxxy/plugin-telegram` ships a `Channel` that drives a moxxy `Session`
through a Telegram bot. One bot is paired to exactly one chat (TOFU +
6-digit code), so the bot answers only the user who set it up.

## Bot setup

1. Talk to [@BotFather](https://t.me/BotFather) and create a bot. Copy the
   token (`<digits>:<22+ url-safe>`).
2. Store the token. Either env var or vault works:

   ```sh
   export MOXXY_TELEGRAM_TOKEN=1234567890:ABC...
   # or, from the TUI, ask the agent: "store this Telegram token in the vault"
   # → the agent calls telegram_set_token(token) and writes
   # `telegram_bot_token` to ~/.moxxy/vault.json.
   ```

## Pairing (bot-issued code)

The flow was inverted in a recent release. The bot now generates the
code and DMs it to you; you paste it into the terminal.

```sh
moxxy channels telegram pair
# → "Waiting for /start from a Telegram chat…"
```

1. Open Telegram. Find your bot. Send `/start`.
2. The bot DMs you a 6-digit code. The window expires after 5 minutes.
3. Paste the code into the moxxy terminal.
4. The wizard persists the chat id to the vault as
   `telegram_authorized_chat_id` and confirms in chat.

The state machine lives in `packages/plugin-telegram/src/pairing.ts` and
the CLI driver in `packages/cli/src/commands/telegram/pair.ts`.

Why this direction? Copying a code out of an auth-trusted device matches
how Authy / Signal device-link / GitHub mobile already work — and the
terminal can validate synchronously inside the wizard.

## Running the bot

After pairing, start it again and it auto-authorizes:

```sh
moxxy telegram                    # foreground (Ctrl-C to stop)
moxxy service install telegram    # background as a launchd / systemd --user unit
```

See [Running as a service](./running-as-a-service) for the service flow.

## Slash commands

The Telegram channel surfaces both shared registry commands (`/info`,
`/clear`, `/new`, `/exit`, `/help`) and a small set of Telegram-local
ones. Both groups are published to Telegram's `/`-picker on startup.

| Command | Effect |
|---|---|
| `/model` | Inline keyboard to switch provider + model for this chat. |
| `/mode` | Switch mode (`tool-use` / `plan-execute` / `bmad`). |
| `/yolo` | Toggle auto-approve mode for this session. |
| `/tools` | List the tools the active session can call. |
| `/skills` | List discovered skills. |
| `/cancel` | Abort the in-flight turn (aborts only the current turn). |
| `/info`, `/clear`, `/new`, `/exit`, `/help` | Shared registry commands. |

Permission and approval prompts arrive as inline-keyboard messages; the
bot polls for the click and resumes the loop. Approvals needing text
follow-up (e.g. plan-execute "Redraft with feedback") capture your next
message as the feedback.

## Tools the plugin contributes

| Tool | Purpose |
|---|---|
| `telegram_set_token` | Store a token in the vault under `telegram_bot_token`. |
| `telegram_status` | Report token + paired-chat state (no secrets). |
| `telegram_send_message` | Push a one-off message to the authorized chat. Useful from scheduled prompts. |
| `telegram_unpair` | Forget the authorized chat. |

`telegram_send_message` is what makes the scheduler useful from the
Telegram side — see [Scheduler](./scheduler).

## Config

```ts
// moxxy.config.ts
import { defineConfig } from '@moxxy/config';

export default defineConfig({
  channels: {
    telegram: {
      token: '${vault:telegram_bot_token}', // optional override
    },
  },
});
```
