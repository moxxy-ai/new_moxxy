import { definePlugin, type Plugin, type ToolDef } from '@moxxy/sdk';
import { IS_DARWIN } from './shell.js';
import { applescriptTool } from './tools/applescript.js';
import { clickTool } from './tools/click.js';
import { clipboardTool } from './tools/clipboard.js';
import { keyTool } from './tools/key.js';
import { openTool } from './tools/open.js';
import { screenshotTool } from './tools/screenshot.js';
import { typeTool } from './tools/type.js';

export {
  applescriptTool,
  clickTool,
  clipboardTool,
  keyTool,
  openTool,
  screenshotTool,
  typeTool,
};

export const computerControlTools: ReadonlyArray<ToolDef> = [
  screenshotTool,
  clickTool,
  typeTool,
  keyTool,
  openTool,
  clipboardTool,
  applescriptTool,
];

/**
 * `@moxxy/plugin-computer-control` — programmatic control of the host
 * computer (mouse, keyboard, screenshot, clipboard, app launching,
 * AppleScript escape hatch).
 *
 * Currently macOS-only: every tool shells out to built-in binaries
 * (`screencapture`, `osascript`, `open`, `pbpaste`, `pbcopy`). On any
 * other platform the plugin still registers — the tools' handlers
 * throw a clear "macOS only" error — so the model's tool list stays
 * stable across hosts (avoids "tool disappeared on Linux" confusion).
 *
 * Every tool is `permission: 'prompt'`. There is intentionally no
 * "allow always" shortcut for these — granting blanket permission to
 * drive the user's screen + keyboard is exactly the wrong default.
 */
export const computerControlPlugin: Plugin = definePlugin({
  name: '@moxxy/plugin-computer-control',
  version: '0.0.0',
  tools: [...computerControlTools],
});

export default computerControlPlugin;

// Re-export for callers that want a runtime gate.
export { IS_DARWIN };
