import { definePlugin } from '@moxxy/sdk';
import { webFetchTool } from './web-fetch.js';
import { buildBrowserSessionTool, closeBrowserSidecar, type BrowserSessionDeps } from './browser-session.js';

export { webFetchTool, htmlToPlainText, htmlToMarkdown } from './web-fetch.js';
export {
  buildBrowserSessionTool,
  closeBrowserSidecar,
  type BrowserSessionDeps,
  type SidecarStream,
} from './browser-session.js';

export interface BuildBrowserPluginOptions extends BrowserSessionDeps {}

export function buildBrowserPlugin(opts: BuildBrowserPluginOptions = {}) {
  return definePlugin({
    name: '@moxxy/plugin-browser',
    version: '0.0.0',
    tools: [webFetchTool, buildBrowserSessionTool(opts)],
    hooks: {
      onShutdown: async () => {
        // Make sure the sidecar process exits with the session.
        await closeBrowserSidecar();
      },
    },
  });
}

export const browserPlugin = buildBrowserPlugin();

export default browserPlugin;
