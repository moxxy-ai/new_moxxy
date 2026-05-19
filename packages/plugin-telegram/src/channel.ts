import { Bot, GrammyError, HttpError } from 'grammy';
import type { Context } from 'grammy';
import { runTurn, type Session } from '@moxxy/core';
import type {
  ApprovalRequest,
  Channel,
  ChannelHandle,
  ChannelStartOptsBase,
  PendingToolCall,
  PermissionContext,
} from '@moxxy/sdk';
import type { VaultStore } from '@moxxy/plugin-vault';
import { TelegramPermissionResolver } from './permission.js';
import { TelegramApprovalResolver } from './approval.js';
import { FramePump } from './channel/frame-pump.js';
import { TypingIndicator } from './channel/typing-indicator.js';
import {
  PairingHandler,
  type PairingConfirmResult,
  type PairingIssuedEvent,
} from './channel/pairing-handler.js';
import { askForPermission } from './channel/permission-prompt.js';
import { askForApproval } from './channel/approval-prompt.js';
import { publishBotCommands, runSlash } from './channel/slash-handler.js';
import {
  handleCallback,
  type AwaitingApprovalText,
} from './channel/callback-handler.js';

const TOKEN_KEY = 'telegram_bot_token';

export type { PairingIssuedEvent, PairingConfirmResult } from './channel/pairing-handler.js';

export interface TelegramStartOpts extends ChannelStartOptsBase {
  readonly session: Session;
  /**
   * If true, open a pairing window on startup. The window waits for the
   * user to send /start to the bot in Telegram; when /start lands the
   * bot DMs a 6-digit code to that chat. The host (terminal wizard)
   * subscribes via `onPairingIssued` and prompts the user to paste the
   * code, then calls `confirmPairingCode` to finalize.
   */
  readonly pair?: boolean;
}

export interface TelegramChannelOptions {
  readonly vault: VaultStore;
  readonly token?: string;
  readonly logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  readonly editFrameMs?: number;
}

export class TelegramChannel implements Channel<TelegramStartOpts> {
  readonly name = 'telegram';
  readonly permissionResolver: TelegramPermissionResolver;
  readonly approvalResolver: TelegramApprovalResolver;
  private readonly opts: TelegramChannelOptions;
  private bot: Bot | null = null;
  private busy = false;
  private currentChatId: number | null = null;
  private session: Session | null = null;
  private model: string | undefined;
  private activeModelOverride: string | null = null;
  private yolo = false;
  // Per-turn abort controller so /cancel aborts only the current turn
  // without poisoning the session-level signal (which other channels
  // sharing the same Session would also observe).
  private turnController: AbortController | null = null;
  // When a user clicks an approval option that needs text follow-up
  // (e.g. plan-execute "Redraft with feedback"), we stash the
  // approval+option pair and capture the user's NEXT message as the
  // follow-up text — same mechanism the TUI uses, just over chat.
  private awaitingApprovalText: AwaitingApprovalText | null = null;
  private handle: ChannelHandle | null = null;
  private readonly framePump: FramePump;
  private readonly typing = new TypingIndicator();
  private readonly pairing: PairingHandler;

  constructor(opts: TelegramChannelOptions) {
    this.opts = opts;
    this.permissionResolver = new TelegramPermissionResolver();
    this.approvalResolver = new TelegramApprovalResolver();
    const pumpOpts: ConstructorParameters<typeof FramePump>[0] = {
      editFrameMs: opts.editFrameMs ?? 1000,
    };
    if (opts.logger) pumpOpts.logger = opts.logger;
    this.framePump = new FramePump(pumpOpts);
    const pairingOpts: ConstructorParameters<typeof PairingHandler>[0] = { vault: opts.vault };
    if (opts.logger) pairingOpts.logger = opts.logger;
    this.pairing = new PairingHandler(pairingOpts);
  }

  async start(startOpts: TelegramStartOpts): Promise<ChannelHandle> {
    if (this.handle) return this.handle;
    this.session = startOpts.session;
    this.model = startOpts.model;

    const token = this.opts.token ?? (await this.opts.vault.get(TOKEN_KEY));
    if (!token) {
      throw new Error(
        `Telegram bot token not found. Store one via vault_set('${TOKEN_KEY}', ...) or set MOXXY_TELEGRAM_TOKEN.`,
      );
    }
    await this.pairing.loadAuthorized();

    if (startOpts.pair) {
      this.pairing.beginWindow();
      this.opts.logger?.info?.('telegram pairing window open');
    } else if (this.pairing.phase() !== 'paired') {
      throw new Error(
        'No Telegram chat is paired yet. Run `moxxy channels telegram pair` to start a pairing window first.',
      );
    }

    this.bot = new Bot(token);
    this.framePump.attachBot(this.bot);
    this.pairing.attachBot(this.bot);
    this.permissionResolver.setDecider((call, ctx) => this.askForPermission(call, ctx));
    this.approvalResolver.setDecider((id, request) => this.askForApproval(id, request));
    // Register the approval resolver on the session so loop strategies
    // (plan-execute) actually surface their plan-validation dialog on
    // this channel. setApprovalResolver(null) on stop tears it down so
    // headless code paths after channel close don't see a stale handler.
    this.session.setApprovalResolver(this.approvalResolver);

    this.bot.command('start', (ctx) => this.pairing.handleStartCommand(ctx));
    this.bot.on('callback_query:data', (ctx) => this.dispatchCallback(ctx));
    this.bot.on('message:text', (ctx) => this.handleText(ctx));
    // Surface the shared registry commands in Telegram's bot-command
    // menu so users see /info, /clear, /new, /exit, /help next to the
    // Telegram-local /model, /loop, /yolo, /tools, /skills, /cancel.
    void publishBotCommands(this.bot, this.session, this.opts.logger);
    this.bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) this.opts.logger?.warn('grammy error', { description: e.description });
      else if (e instanceof HttpError) this.opts.logger?.warn('http error', { message: e.message });
      else this.opts.logger?.warn('telegram error', { err: String(e) });
    });

    this.opts.logger?.info?.('telegram channel starting', {
      paired: this.pairing.phase() === 'paired',
    });

    const running = this.bot.start({ drop_pending_updates: false });
    this.handle = {
      running,
      stop: async (reason = 'shutdown') => {
        this.permissionResolver.abortAll(reason);
        this.approvalResolver.abortAll(reason);
        if (this.session) this.session.setApprovalResolver(null);
        this.framePump.endTurn();
        this.typing.stop();
        if (this.bot) await this.bot.stop();
      },
    };
    return this.handle;
  }

  beginPairingWindow(): void {
    this.pairing.beginWindow();
  }

  pairingPhase(): ReturnType<PairingHandler['phase']> {
    return this.pairing.phase();
  }

  unpair(): void {
    this.pairing.unpair();
  }

  onPairingIssued(listener: (e: PairingIssuedEvent) => void): () => void {
    return this.pairing.onIssued(listener);
  }

  async confirmPairingCode(rawInput: string): Promise<PairingConfirmResult> {
    return this.pairing.confirmCode(rawInput);
  }

  private async handleText(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    if (!chatId || !text) return;

    if (!this.pairing.isAuthorized(chatId)) {
      await ctx.reply(
        'This bot is paired with a different chat (or not paired yet). Run `moxxy telegram pair` to (re-)pair.',
      );
      return;
    }

    // Capture awaiting-text BEFORE the busy guard so the user can answer
    // an approval text prompt even while the strategy is technically
    // still mid-turn (it's pending on us).
    if (this.awaitingApprovalText) {
      const { approvalId, optionId } = this.awaitingApprovalText;
      this.awaitingApprovalText = null;
      const handled = this.approvalResolver.resolvePendingWithText(approvalId, optionId, text);
      if (handled) {
        await ctx.reply(`✓ submitted (${optionId})`);
      } else {
        await ctx.reply('that approval is no longer pending');
      }
      return;
    }

    // /cancel works even while busy; everything else routes through
    // runSlash or the user-turn path.
    if (text === '/cancel') {
      if (this.turnController && !this.turnController.signal.aborted) {
        this.turnController.abort('user cancel');
        await ctx.reply('cancelling current turn…');
      } else {
        await ctx.reply('nothing to cancel.');
      }
      return;
    }

    if (text.startsWith('/')) {
      await runSlash(
        ctx,
        text,
        {
          session: this.session,
          model: this.model,
          activeModelOverride: this.activeModelOverride,
          yolo: this.yolo,
        },
        {
          toggleYolo: () => {
            this.yolo = !this.yolo;
            return this.yolo;
          },
          performSessionAction: (c, action, notice) =>
            this.performSessionAction(c, action, notice),
        },
      );
      return;
    }

    if (this.busy) {
      await ctx.reply('I am still working on the previous prompt. Send /cancel to abort it.');
      return;
    }

    await this.runUserTurn(ctx, chatId, text);
  }

  /**
   * Channel-side handler for `session-action` outputs from registered
   * commands. The TUI does the same thing; both channels translate the
   * action into their own UI semantics (Telegram = reply text, Ink =
   * setState + exit).
   */
  private async performSessionAction(
    ctx: Context,
    action: 'new' | 'clear' | 'exit',
    notice: string | undefined,
  ): Promise<void> {
    if (!this.session) return;
    if (action === 'exit') {
      await ctx.reply(notice ?? 'closing Telegram channel');
      if (this.handle) await this.handle.stop('user /exit');
      return;
    }
    if (action === 'clear') {
      this.framePump.resetRenderer();
      if (notice) await ctx.reply(`✓ ${notice}`);
      return;
    }
    if (action === 'new') {
      if (this.turnController && !this.turnController.signal.aborted) {
        this.turnController.abort('user reset');
      }
      this.session.log.clear();
      this.framePump.resetRenderer();
      this.yolo = false;
      this.awaitingApprovalText = null;
      this.approvalResolver.abortAll('session reset');
      this.permissionResolver.abortAll('session reset');
      await ctx.reply(`✓ ${notice ?? 'new session — conversation history cleared'}`);
    }
  }

  private async runUserTurn(ctx: Context, chatId: number, text: string): Promise<void> {
    if (!this.session) throw new Error('TelegramChannel.start() must be called first');
    this.busy = true;
    this.currentChatId = chatId;
    this.framePump.beginTurn(chatId);
    // Kick off "typing…" right away so the user gets immediate
    // feedback. Don't send an ellipsis placeholder message — the
    // typing indicator IS the placeholder. The frame pump lazily sends
    // the first real frame when there's content to display, then
    // edits that message for every subsequent frame.
    this.typing.start(this.bot, chatId);

    const unsubscribe = this.session.log.subscribe((event) => {
      const frame = this.framePump.renderState.accept(event);
      if (frame.hasUpdate) this.framePump.scheduleEdit();
    });

    // Per-turn AbortController so /cancel only aborts THIS turn.
    const controller = new AbortController();
    this.turnController = controller;
    const effectiveModel = this.activeModelOverride ?? this.model;

    try {
      for await (const _event of runTurn(this.session, text, {
        ...(effectiveModel ? { model: effectiveModel } : {}),
        signal: controller.signal,
      })) {
        void _event;
      }
      await this.framePump.flush(true);
    } catch (err) {
      this.opts.logger?.warn('telegram turn failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      try {
        await ctx.reply(`Turn failed: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        /* ignore */
      }
    } finally {
      this.typing.stop();
      unsubscribe();
      this.busy = false;
      this.turnController = null;
      this.currentChatId = null;
      this.framePump.endTurn();
    }
  }

  private askForPermission(call: PendingToolCall, ctx: PermissionContext): Promise<void> {
    return askForPermission(call, ctx, {
      bot: this.bot,
      chatId: this.currentChatId,
      session: this.session,
      resolver: this.permissionResolver,
      yolo: this.yolo,
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
    });
  }

  private askForApproval(id: string, request: ApprovalRequest): Promise<void> {
    return askForApproval(id, request, {
      bot: this.bot,
      chatId: this.currentChatId,
      resolver: this.approvalResolver,
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
    });
  }

  private dispatchCallback(ctx: Context): Promise<void> {
    return handleCallback(
      ctx,
      {
        bot: this.bot,
        session: this.session,
        chatId: this.currentChatId,
        permissionResolver: this.permissionResolver,
        approvalResolver: this.approvalResolver,
      },
      {
        setAwaitingApprovalText: (state) => {
          this.awaitingApprovalText = state;
        },
        setActiveModelOverride: (modelId) => {
          this.activeModelOverride = modelId;
        },
      },
    );
  }
}
