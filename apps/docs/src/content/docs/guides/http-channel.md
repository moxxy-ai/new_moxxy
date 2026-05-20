---
title: HTTP channel
description: POST /v1/turn + SSE streaming, bearer-token auth, allow-list permissions.
---

`@moxxy/plugin-channel-http` exposes a moxxy `Session` over HTTP. There
is no human in the loop, so the operator declares trust up-front via a
tool allow-list and a bearer token.

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/v1/health` | — | `{ "status": "ok" }` |
| `POST` | `/v1/turn` | `{ prompt, model?, systemPrompt? }` | `{ events: MoxxyEvent[], assistant: string }` |
| `POST` | `/v1/turn/stream` | same | SSE: one `data:` line per `MoxxyEvent`, terminating with `data: [DONE]` |
| `POST` | `/v1/turn/audio` | raw audio bytes with `Content-Type: audio/*` | `{ transcript, events, assistant }` |

The request body schema is exported as `turnRequestSchema` from
`@moxxy/plugin-channel-http`.

## Auth

Every protected route requires `Authorization: Bearer <token>`. Configure
via env or config:

```sh
export MOXXY_HTTP_TOKEN=$(openssl rand -hex 32)
moxxy channels http
```

```ts
// moxxy.config.ts
import { defineConfig } from '@moxxy/config';

export default defineConfig({
  channels: {
    http: {
      port: 3737,                // default
      host: '127.0.0.1',         // default — bind to localhost
      authToken: '${vault:MOXXY_HTTP_TOKEN}',
      allowedTools: ['Read', 'Glob', 'Grep', 'web_fetch'],
    },
  },
});
```

`channels.http.allowedTools` is **required** — `isAvailable` refuses to
start without it. The HTTP channel uses `createAllowListResolver` from
`@moxxy/core`; any tool not in the list is denied. Set `allowedTools: []`
disables all tools.

## SSE stream

```sh
curl -N http://localhost:3737/v1/turn/stream \
  -H "Authorization: Bearer $MOXXY_HTTP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"list TS files"}'
```

Each event is one of the discriminated `MoxxyEvent` variants exported
from `@moxxy/sdk`. For a chat UI, pull `assistant_chunk` events and append
their `delta` field; for tool activity, watch `tool_call_requested` →
`tool_result`.

## Audio input

`POST /v1/turn/audio` takes raw audio bytes in the body and the audio
type in the `Content-Type` header. The session must have an active
`Transcriber` (e.g. `@moxxy/plugin-stt-whisper`) — otherwise the
endpoint returns `503 no_transcriber`. The bytes are transcribed, the
transcript becomes the user prompt, and the rest of the run is
identical to `/v1/turn`.

Optional tuning lives in the query string so the body stays raw:

```sh
curl -X POST \
  "http://localhost:3737/v1/turn/audio?model=claude-sonnet-4-6&language=en" \
  -H "Authorization: Bearer $MOXXY_HTTP_TOKEN" \
  -H "Content-Type: audio/m4a" \
  --data-binary @voicenote.m4a
```

Response:

```json
{
  "transcript": "summarize today's calendar",
  "assistant": "you have three meetings: ...",
  "events": [...]
}
```

### iOS Shortcut recipe

Build a Shortcut on iPhone (or Mac) and assign it to the Action Button
or a Home Screen icon for one-tap voice → agent:

1. **Record Audio** — record from microphone, output as M4A
2. **Get Contents of URL** — set:
   - Method: `POST`
   - URL: `https://<your-tunnel-or-LAN>/v1/turn/audio`
   - Headers:
     - `Authorization`: `Bearer <your MOXXY_HTTP_TOKEN>`
     - `Content-Type`: `audio/m4a`
   - Request Body: `File` → the Recording from step 1
3. **Get Dictionary Value** — key `assistant`
4. **Show Result** *(or Speak Text, or send to Notes)*

Bind the Shortcut to the Action Button (Settings → Action Button →
Shortcut) and you have a push-to-talk personal assistant. Open the bind
on Apple Watch and the same Shortcut works wrist-side.

Hosting note: bind the moxxy HTTP channel to `127.0.0.1` and front it
with Tailscale, Cloudflare Tunnel, or a reverse proxy that re-checks
auth. Never expose the bare port to the internet.

## Run as a service

```sh
moxxy service install http
moxxy service status http
moxxy service logs http --lines 100
```

See [Running as a service](./running-as-a-service) for launchd / systemd
details.

## Notes

- Errors short-circuit the SSE stream with `event: error\ndata: {...}`.
- Request bodies are capped at 64 KB.
- Bind to `127.0.0.1` unless you fronted the port with a reverse proxy
  that terminates TLS and re-checks auth.
- For more interactive flows where humans approve tools per-call, use
  the TUI or Telegram channel instead.
