---
name: computer-control
description: Drive the user's Mac (mouse, keyboard, screenshot, clipboard, app launch) when the task can't be done with files/web alone.
triggers:
  - "click on"
  - "click the"
  - "take a screenshot"
  - "screenshot the"
  - "screen capture"
  - "screen shot"
  - "open the app"
  - "open app"
  - "launch app"
  - "switch to"
  - "type into"
  - "type this"
  - "paste this"
  - "what's on my screen"
  - "what is on screen"
  - "show me the screen"
  - "control my computer"
  - "automate"
  - "for me on the screen"
  - "use my mac"
  - "drive the ui"
allowed-tools:
  - computer_screenshot
  - computer_click
  - computer_type
  - computer_key
  - computer_open
  - computer_clipboard
  - computer_applescript
---

# Computer control (macOS)

When the task requires driving the user's actual desktop — clicking a UI
button, typing into an open app, taking a screenshot, launching software —
use the `computer_*` tools. Each one prompts for permission **every time**;
the user explicitly approves each action. There is no "allow always" for
these by design.

## macOS permission prerequisites

On first use the user will see a system dialog from macOS itself. Tell them
which one to expect:

- **Screen Recording** — required by `computer_screenshot`. Grant in System
  Settings → Privacy & Security → Screen Recording.
- **Accessibility** — required by `computer_click`, `computer_type`,
  `computer_key`, and most `computer_applescript` snippets that touch UI.
  Grant in System Settings → Privacy & Security → Accessibility.

If a tool returns "(check Accessibility permission)" or "(check Screen
Recording permission)" in its error, surface that message verbatim and
stop — don't loop on the same failing call.

## The standard loop: see → act → verify

Almost every UI automation follows this rhythm. Do it explicitly:

1. **See** — call `computer_screenshot` to capture the current state.
   Look at the image, identify the target element, note its pixel
   coordinates from the top-left.
2. **Act** — `computer_click` / `computer_type` / `computer_key` on the
   coordinates / focused field.
3. **Verify** — `computer_screenshot` again, confirm the expected
   change. If not, diagnose before retrying.

**Do NOT skip the verify.** A 200ms animation, a popup, or a focus shift
can silently break the next step. The agent that screenshots after every
action is the agent that doesn't accidentally type a password into the
wrong field.

## Tool reference (quick)

```
computer_screenshot({ region?, maxDim?, format?, quality? })
  → { mediaType, base64, byteLength, maxDim, format }
  Default: full screen → 1280px JPEG @ q72 (~150 KB).
  Override `maxDim`/`format`/`quality` only when you need pixel detail —
  context-cost climbs fast for large/PNG images.

computer_click({ x, y, count? })          # count: 1=single, 2=double, 3=triple

computer_type({ text })                   # types into whatever has focus
                                          # CLICK FIRST to set focus

computer_key({ key, modifiers? })         # key: "a", "tab", "return", "f5", ...
                                          # modifiers: ["cmd","shift","option","control"]

computer_open({ target?, app? })          # app: "Safari", target: URL or path

computer_clipboard({ action: "read" })
computer_clipboard({ action: "write", text })

computer_applescript({ script })          # escape hatch — anything else
```

## Common patterns

**Take a screenshot and describe it:**
```
1. computer_screenshot({})
2. Look at the image — describe the active app, visible windows, any errors
```

**Open an app and click a known button:**
```
1. computer_open({ app: "Safari" })
2. (wait a moment for activation)
3. computer_screenshot({})       # find the button's coordinates
4. computer_click({ x: ..., y: ... })
5. computer_screenshot({})       # verify
```

**Paste text into the focused field:**
```
1. computer_clipboard({ action: "write", text: "..." })
2. computer_key({ key: "v", modifiers: ["cmd"] })
```

**Get the frontmost app name (via the escape hatch):**
```
computer_applescript({
  script: 'tell application "System Events" to get name of first application process whose frontmost is true'
})
```

## Don't

- **Don't click without screenshotting first.** Coordinates change between
  turns; a button moves when the window resizes. One screenshot per
  action group is the minimum.
- **Don't type into "focus" you didn't set.** `computer_type` sends keys
  to whatever currently has keyboard focus. Click the target field first
  (or call `computer_key` with cmd+l to focus an address bar, etc.).
- **Don't loop on a failed click.** If a click "succeeded" (exit 0) but
  the next screenshot shows nothing changed, the coordinates were wrong.
  Re-screenshot, re-find the target, try again — but stop after two
  failed attempts and explain to the user.
- **Don't use computer_key for typing words.** `computer_key({ key: "h" })`
  sends one keystroke. Use `computer_type({ text: "hello" })` instead.
- **Don't paste passwords / API keys via clipboard if the user has a
  password manager.** Suggest they trigger the manager instead. The
  clipboard is observable by every app.
- **Don't run open-ended `computer_applescript` snippets when a
  dedicated tool fits.** The escape hatch is for the long tail.
- **Don't take screenshots the user didn't ask for.** Each one captures
  whatever happens to be on screen — including messages, notifications,
  unrelated windows. Take one when you need pixels for an action, not
  out of curiosity.

## Platforms other than macOS

This plugin currently only supports macOS. On Linux/Windows the tools
register but each handler throws `currently only supports macOS`. Tell
the user that explicitly instead of looping on failures.
