import {
  defineMode,
  definePlugin,
  type CollectedToolUse,
} from '@moxxy/sdk';

import { runToolUseMode, TOOL_USE_MODE_NAME } from './turn-iterator.js';

export { TOOL_USE_MODE_NAME };
export type { CollectedToolUse };

export const toolUseMode = defineMode({
  name: TOOL_USE_MODE_NAME,
  run: runToolUseMode,
});

export const toolUseModePlugin = definePlugin({
  name: '@moxxy/mode-tool-use',
  version: '0.0.0',
  modes: [toolUseMode],
});

export default toolUseModePlugin;
