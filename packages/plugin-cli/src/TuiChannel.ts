import React from 'react';
import { render, type Instance } from 'ink';
import type {
  Channel,
  ChannelHandle,
  ChannelStartOptsBase,
  ClientSession as Session,
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
} from '@moxxy/sdk';
import {
  createInteractivePermissionResolver,
  type PermissionPromptHandler,
} from './resolver.js';
import { InteractiveSession } from './InteractiveSession.js';

export interface TuiStartOpts extends ChannelStartOptsBase {
  /**
   * Pre-resolved session. Either this OR `bootstrap` must be set. When
   * both are present, `session` wins and `bootstrap` is ignored.
   */
  readonly session?: Session;
  /**
   * Lazy session loader: the TUI mounts immediately, shows the boot
   * checklist, and calls `bootstrap(progress)` in an effect. Each
   * `progress(step)` invocation ticks a row in the checklist.
   */
  readonly bootstrap?: (
    progress: (step: import('./InteractiveSession.js').InteractiveBootStep) => void,
  ) => Promise<Session>;
  /** Optional version string surfaced in the logo + /info. */
  readonly version?: string;
}

/**
 * Channel implementation that mounts the Ink-based `InteractiveSession`
 * component and routes permission prompts through it. The CLI binary's
 * `moxxy tui` subcommand uses this.
 */
export class TuiChannel implements Channel<TuiStartOpts> {
  readonly name = 'tui';
  readonly permissionResolver: ReturnType<typeof createInteractivePermissionResolver>;
  private promptHandler:
    | ((call: PendingToolCall, ctx: PermissionContext) => Promise<PermissionDecision>)
    | null = null;
  private inkInstance: Instance | null = null;

  constructor() {
    this.permissionResolver = createInteractivePermissionResolver({
      name: 'tui',
      prompt: async (call, ctx) => {
        if (!this.promptHandler) {
          return { mode: 'deny', reason: 'TUI not ready' };
        }
        return this.promptHandler(call, ctx);
      },
    });
  }

  async start(opts: TuiStartOpts): Promise<ChannelHandle> {
    if (!opts.session && !opts.bootstrap) {
      throw new Error('TuiChannel.start requires either `session` or `bootstrap`');
    }
    const registerInteractiveResolver: (h: PermissionPromptHandler) => void = (handler) => {
      this.promptHandler = handler;
    };

    this.inkInstance = render(
      React.createElement(InteractiveSession, {
        ...(opts.session ? { session: opts.session } : {}),
        ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
        registerInteractiveResolver,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.version ? { version: opts.version } : {}),
      }),
    );

    return {
      running: this.inkInstance.waitUntilExit(),
      stop: async () => {
        // Reject any in-flight permission prompts so callers awaiting them
        // don't hang once the UI is gone.
        this.permissionResolver.abortAll('TUI unmounted');
        this.inkInstance?.unmount();
      },
    };
  }
}
