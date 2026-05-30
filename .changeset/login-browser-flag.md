---
"@moxxy/cli": patch
---

`moxxy login`: add a `--browser` flag that forces the loopback/browser OAuth flow even when stdin isn't a TTY.

Previously a GUI host (the desktop app) that spawned `moxxy login <provider>` with piped stdio got the headless device-code flow — the user had to open a URL and type a code by hand. With `--browser`, the CLI runs the loopback flow that opens the system browser automatically and catches the localhost callback, so no copying is needed. (`--no-browser` still forces device-code.)
