---
title: '@moxxy/plugin-computer-control'
description: macOS-only screenshot / click / type / key / open / clipboard / AppleScript tools.
---

`@moxxy/plugin-computer-control` lets the agent drive the host
computer — mouse, keyboard, screen, clipboard, app launching, and an
AppleScript escape hatch. macOS-only; every tool shells out to a
built-in binary (`screencapture`, `osascript`, `open`, `pbpaste`,
`pbcopy`).

On any other platform the plugin still registers — the tools throw a
clear "macOS only" error when called — so the model's tool list stays
stable across hosts.

## Install

```sh
pnpm add @moxxy/plugin-computer-control
```

## Tools

| Tool | Purpose |
|---|---|
| `computer_screenshot` | Capture the screen (or a region) and return a path / base64. |
| `computer_click` | Move + click at (x, y). |
| `computer_type` | Type a string at the current focus. |
| `computer_key` | Press a key combo (e.g. `cmd+space`). |
| `computer_open` | `open` a URL / file / app. |
| `computer_clipboard` | Read or write the clipboard. |
| `computer_applescript` | Run an AppleScript expression for anything not covered above. |

## Use

```ts
import { computerControlPlugin } from '@moxxy/plugin-computer-control';
session.pluginHost.registerStatic(computerControlPlugin);
```

## Security

Every tool is `permission: 'prompt'` and there is intentionally no
"allow always" shortcut. Granting blanket permission to drive your
screen + keyboard is exactly the wrong default — review each call.

## Why ship on non-macOS

The tool list staying stable means a "click on the menubar icon" prompt
on Linux returns a clear "macOS only" error to the model instead of
the tool silently disappearing — which used to send the agent into
modes trying to figure out why its first step failed.
