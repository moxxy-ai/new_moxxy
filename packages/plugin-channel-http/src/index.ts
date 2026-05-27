import { defineChannel, definePlugin, type Plugin } from '@moxxy/sdk';
import { HttpChannel } from './channel.js';

export { HttpChannel, type HttpChannelOptions, type HttpStartOpts } from './channel.js';
export {
  routeRequest,
  handleHealth,
  handleSessionSelection,
  handleInputCapabilities,
  handleTranscription,
  handleTurn,
  handleTurnStream,
  handleTurnAudio,
  handleProviders,
  handleProviderModels,
  handleAgents,
  handleCreateAgent,
  handleGetAgent,
  handleDeleteAgent,
  handleAgentRun,
  handleStopAgent,
  handleAgentHistory,
  handleResetAgent,
  handleVirtualOfficeEvents,
  handlePermissionDecision,
  turnRequestSchema,
  type TurnRequest,
  type RouterContext,
  type RouteHandler,
} from './router.js';
export {
  HttpPermissionBroker,
  PERMISSION_REQUESTED_SUBTYPE,
  PERMISSION_RESOLVED_SUBTYPE,
} from './permission-broker.js';
export {
  OfficeAgentRuntime,
  type OfficeAgentCreateInput,
  type OfficeAgentHistory,
  type OfficeRunStart,
  type VirtualOfficeAgent,
} from './office-agent-runtime.js';
export {
  eventToVirtualOfficeEnvelope,
  type VirtualOfficeEnvelope,
} from './virtual-office-events.js';

export const httpChannelDef = defineChannel({
  name: 'http',
  description: 'Request-response HTTP channel. POST /v1/turn + SSE streaming. Bearer-token auth + allow-list perms.',
  create: (deps) => {
    const opts = deps.options ?? {};
    return new HttpChannel({
      port: typeof opts.port === 'number' ? opts.port : undefined,
      host: typeof opts.host === 'string' ? opts.host : undefined,
      authToken: typeof opts.authToken === 'string' ? opts.authToken : process.env.MOXXY_HTTP_TOKEN,
      allowedTools: Array.isArray(opts.allowedTools) ? (opts.allowedTools as string[]) : undefined,
      logger: deps.logger as never,
    });
  },
  isAvailable: async (deps) => {
    const tools = deps.options?.['allowedTools'];
    const authToken = deps.options?.['authToken'] ?? process.env.MOXXY_HTTP_TOKEN;
    if (!authToken) {
      return {
        ok: false,
        reason: "No auth token. Set MOXXY_HTTP_TOKEN or pass channels.http.authToken in moxxy.config.ts.",
      };
    }
    if (!Array.isArray(tools) || tools.length === 0) {
      return {
        ok: false,
        reason:
          'No allowed-tools list. The HTTP channel needs an upfront tool allow-list since there is no human in the loop. Set channels.http.allowedTools in moxxy.config.ts.',
      };
    }
    return { ok: true };
  },
});

export const httpChannelPlugin: Plugin = definePlugin({
  name: '@moxxy/plugin-channel-http',
  version: '0.0.0',
  channels: [httpChannelDef],
});

export default httpChannelPlugin;
