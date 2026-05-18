import { Bot, InlineKeyboard, GrammyError, HttpError } from 'grammy';
import type { Context } from 'grammy';
import { runTurn, savePreferences, type Session } from '@moxxy/core';
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
import {
  beginPairing,
  clearPairing,
  createPairingState,
  handleCode,
  handleStart,
  isAuthorized,
  type PairingState,
} from './pairing.js';
import { TurnRenderer, splitForTelegram } from './render.js';

const AUTHORIZED_CHAT_KEY = 'telegram_authorized_chat_id';
const TOKEN_KEY = 'telegram_bot_token';

export interface TelegramStartOpts extends ChannelStartOptsBase {
  readonly session: Session;
  /**
   * If true, begin a pairing window on startup and emit the 6-digit code via
   * the logger / stderr so the host operator can read it. Equivalent to the
   * previous `moxxy telegram pair` invocation.
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
  private pairing: PairingState = createPairingState();
  private busy = false;
  private currentMessageId: number | null = null;
  private currentChatId: number | null = null;
  private renderer = new TurnRenderer();
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentFrame = '';
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
  private awaitingApprovalText: { approvalId: string; optionId: string } | null = null;
  private handle: ChannelHandle | null = null;
  private readonly editFrameMs: number;
  // Repeating "typing…" chat-action timer. Telegram clears the indicator
  // ~5s after the last sendChatAction call, so we re-send every ~4s for
  // the lifetime of a turn. Cleared in `stopTyping()` (always called
  // from runUserTurn's finally block).
  private typingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TelegramChannelOptions) {
    this.opts = opts;
    this.editFrameMs = opts.editFrameMs ?? 1000;
    this.permissionResolver = new TelegramPermissionResolver();
    this.approvalResolver = new TelegramApprovalResolver();
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
    const authorizedRaw = await this.opts.vault.get(AUTHORIZED_CHAT_KEY);
    this.pairing = createPairingState({
      authorizedChatId: authorizedRaw ? Number(authorizedRaw) : null,
    });

    if (startOpts.pair) {
      const code = this.beginPairingWindow();
      this.opts.logger?.info?.('telegram pairing window open', { code });
      process.stderr.write(
        `\n  Telegram pairing code:  ${code}\n` +
          '  Send /start to your bot, then type this code in Telegram.\n' +
          '  (Window: 5 minutes)\n\n',
      );
    } else if (this.pairing.phase !== 'paired') {
      throw new Error(
        'No Telegram chat is paired yet. Run `moxxy channels telegram pair` to start a pairing window first.',
      );
    }

    this.bot = new Bot(token);
    this.permissionResolver.setDecider((call, ctx) => this.askForPermission(call, ctx));
    this.approvalResolver.setDecider((id, request) => this.askForApproval(id, request));
    // Register the approval resolver on the session so loop strategies
    // (plan-execute) actually surface their plan-validation dialog on
    // this channel. setApprovalResolver(null) on stop tears it down so
    // headless code paths after channel close don't see a stale handler.
    this.session.setApprovalResolver(this.approvalResolver);

    this.bot.command('start', (ctx) => this.handleStartCommand(ctx));
    this.bot.on('callback_query:data', (ctx) => this.handleCallback(ctx));
    this.bot.on('message:text', (ctx) => this.handleText(ctx));
    // Surface the shared registry commands in Telegram's bot-command
    // menu so users see /info, /clear, /new, /exit, /help next to the
    // Telegram-local /model, /loop, /yolo, /tools, /skills, /cancel.
    void this.publishBotCommands();
    this.bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) this.opts.logger?.warn('grammy error', { description: e.description });
      else if (e instanceof HttpError) this.opts.logger?.warn('http error', { message: e.message });
      else this.opts.logger?.warn('telegram error', { err: String(e) });
    });

    this.opts.logger?.info?.('telegram channel starting', {
      paired: this.pairing.phase === 'paired',
    });

    const running = this.bot.start({ drop_pending_updates: false });
    this.handle = {
      running,
      stop: async (reason = 'shutdown') => {
        this.permissionResolver.abortAll(reason);
        this.approvalResolver.abortAll(reason);
        if (this.session) this.session.setApprovalResolver(null);
        if (this.editTimer) clearTimeout(this.editTimer);
        this.stopTyping();
        if (this.bot) await this.bot.stop();
      },
    };
    return this.handle;
  }

  /** Begin a pairing window. Returns the 6-digit code to display in the host. */
  beginPairingWindow(): string {
    const { state, code } = beginPairing(this.pairing);
    this.pairing = state;
    return code;
  }

  pairingPhase(): PairingState['phase'] {
    return this.pairing.phase;
  }

  unpair(): void {
    this.pairing = clearPairing(this.pairing);
  }

  private async handleStartCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const decision = handleStart(this.pairing, chatId);
    this.pairing = decision.state;
    const action = decision.action;
    if (action.kind === 'still-paired') {
      await ctx.reply('Welcome back! Send me a prompt.');
      return;
    }
    if (action.kind === 'reject' || action.kind === 'request-code') {
      await ctx.reply(action.message);
    }
  }

  private async handleText(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    if (!chatId || !text) return;

    if (this.pairing.phase === 'awaiting-code') {
      const decision = handleCode(this.pairing, chatId, text);
      this.pairing = decision.state;
      switch (decision.action.kind) {
        case 'paired':
          await this.opts.vault.set(AUTHORIZED_CHAT_KEY, String(decision.action.chatId));
          await ctx.reply(decision.action.message);
          return;
        case 'reject':
        case 'wait':
          await ctx.reply(decision.action.message);
          return;
        default:
          return;
      }
    }

    if (!isAuthorized(this.pairing, chatId)) {
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
      await this.runSlash(ctx, text);
      return;
    }

    if (this.busy) {
      await ctx.reply('I am still working on the previous prompt. Send /cancel to abort it.');
      return;
    }

    await this.runUserTurn(ctx, chatId, text);
  }

  /**
   * Slash-command dispatcher for the Telegram channel.
   *
   * First tries the shared `session.commands` registry — this is where
   * the universal commands (/info, /clear, /new, /exit, /help) live, so
   * Telegram gets them for free alongside any plugin-contributed
   * commands without needing a switch case here.
   *
   * Falls through to channel-local cases for Telegram-specific UI
   * (model/loop pickers as inline keyboards, /yolo toggle, /tools and
   * /skills as text dumps, /cancel for in-flight aborts).
   */
  private async runSlash(ctx: Context, text: string): Promise<void> {
    if (!this.session) return;
    const [head, ...rest] = text.split(/\s+/);
    const name = head!.slice(1);
    const args = rest.join(' ');

    // 1) Shared registry dispatch.
    const registered = this.session.commands.get(name);
    if (registered) {
      try {
        const result = await registered.handler({
          channel: 'telegram',
          sessionId: this.session.id,
          args,
          session: this.session,
        });
        if (result.kind === 'text') {
          await ctx.reply(result.text);
        } else if (result.kind === 'session-action') {
          await this.performSessionAction(ctx, result.action, result.notice);
        } else if (result.kind === 'error') {
          await ctx.reply(`error: ${result.message}`);
        }
      } catch (err) {
        await ctx.reply(
          `command /${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // 2) Channel-local cases.
    switch (head) {
      case '/model': {
        const providers = this.session.providers.list();
        if (providers.length === 0) {
          await ctx.reply('no providers registered');
          return;
        }
        const keyboard = new InlineKeyboard();
        const providerName = this.session.providers.getActiveName() ?? '';
        const activeModel = this.activeModelOverride ?? this.model ?? '';
        // Same boot-time readiness set the TUI uses to flag unconfigured
        // providers — set by `@moxxy/cli` at setup time. Providers that
        // failed credential resolution get a "(not connected)" suffix
        // and a tap on them surfaces the right setup command instead of
        // a no-op switch.
        const ready =
          (this.session as unknown as { readyProviders?: Set<string> }).readyProviders ??
          new Set<string>();
        let count = 0;
        for (const p of providers) {
          for (const m of p.models) {
            const isCurrent = providerName === p.name && activeModel === m.id;
            const connected = ready.has(p.name);
            const label =
              `${isCurrent ? '• ' : ''}${p.name}: ${m.id}` +
              (connected ? '' : ' (not connected)');
            keyboard.text(label, `model:${p.name}::${m.id}`).row();
            count += 1;
            if (count >= 30) break;
          }
          if (count >= 30) break;
        }
        await ctx.reply('Pick a model:', { reply_markup: keyboard });
        return;
      }
      case '/loop': {
        const strategies = this.session.loops.list();
        if (strategies.length === 0) {
          await ctx.reply('no loop strategies registered');
          return;
        }
        const keyboard = new InlineKeyboard();
        const activeLoopName = (() => {
          try {
            return this.session!.loops.getActive().name;
          } catch {
            return '';
          }
        })();
        for (const s of strategies) {
          const isCurrent = s.name === activeLoopName;
          keyboard.text(`${isCurrent ? '• ' : ''}${s.name}`, `loop:${s.name}`).row();
        }
        await ctx.reply('Pick a loop strategy:', { reply_markup: keyboard });
        return;
      }
      case '/yolo': {
        this.yolo = !this.yolo;
        await ctx.reply(
          this.yolo
            ? '⚠ yolo mode ON — tool calls auto-approved for the rest of this session'
            : 'yolo mode OFF — tool prompts will resume',
        );
        return;
      }
      case '/tools': {
        const list = this.session.tools
          .list()
          .map((t) => `${t.name} — ${t.description}`)
          .join('\n');
        await ctx.reply(list || '(no tools registered)');
        return;
      }
      case '/skills': {
        const list = this.session.skills
          .list()
          .map((s) => {
            const triggers = s.frontmatter.triggers ?? [];
            const triggerLine = triggers.length
              ? `\n   triggers: ${triggers.map((t) => `"${t}"`).join(', ')}`
              : '';
            return `${s.frontmatter.name} — ${s.frontmatter.description}${triggerLine}`;
          })
          .join('\n');
        await ctx.reply(list || '(no skills discovered)');
        return;
      }
      default:
        await ctx.reply(`unknown command: ${head} (try /help)`);
    }
  }

  /**
   * Push the union of registry commands + Telegram-local commands to
   * Telegram so they appear in the chat's command menu (the "/" picker
   * the official client shows). Best-effort: a network failure here
   * doesn't block channel startup, the commands still work via text.
   */
  private async publishBotCommands(): Promise<void> {
    if (!this.session || !this.bot) return;
    const LOCAL: Array<{ command: string; description: string }> = [
      { command: 'model', description: 'Switch provider + model (inline keyboard)' },
      { command: 'loop', description: 'Switch loop strategy' },
      { command: 'yolo', description: 'Toggle auto-approve mode' },
      { command: 'tools', description: 'List the tools the active session can call' },
      { command: 'skills', description: 'List the discovered skills' },
      { command: 'cancel', description: 'Abort the current turn' },
    ];
    const shared = this.session.commands
      .listForChannel('telegram')
      .map((c) => ({ command: c.name, description: c.description }));
    const seen = new Set(shared.map((c) => c.command));
    const merged = [...shared, ...LOCAL.filter((c) => !seen.has(c.command))]
      .sort((a, b) => a.command.localeCompare(b.command))
      // Telegram caps descriptions at 256 chars and rejects empties.
      .map((c) => ({
        command: c.command,
        description: (c.description || c.command).slice(0, 256),
      }));
    try {
      await this.bot.api.setMyCommands(merged);
    } catch (err) {
      this.opts.logger?.warn?.('telegram setMyCommands failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
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
      this.renderer.reset();
      if (notice) await ctx.reply(`✓ ${notice}`);
      return;
    }
    if (action === 'new') {
      if (this.turnController && !this.turnController.signal.aborted) {
        this.turnController.abort('user reset');
      }
      this.session.log.clear();
      this.renderer.reset();
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
    this.renderer.reset();
    this.currentChatId = chatId;
    // Kick off "typing…" right away so the user gets immediate feedback
    // even before the first placeholder message lands.
    this.startTyping(chatId);
    const initial = await ctx.reply('…');
    this.currentMessageId = initial.message_id;
    this.lastSentFrame = '…';

    const unsubscribe = this.session.log.subscribe((event) => {
      const frame = this.renderer.accept(event);
      if (frame.hasUpdate) this.scheduleEdit();
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
      await this.flushEdit(true);
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
      this.stopTyping();
      unsubscribe();
      this.busy = false;
      this.turnController = null;
      this.currentChatId = null;
      this.currentMessageId = null;
    }
  }

  /**
   * Show a "typing…" indicator in the chat for the lifetime of a turn.
   * Telegram clears the indicator ~5s after the last sendChatAction, so
   * we re-fire every 4s. Best-effort — a single failure shouldn't crash
   * the turn (we keep the interval going so transient network blips
   * recover on the next tick).
   */
  private startTyping(chatId: number): void {
    if (!this.bot) return;
    this.stopTyping();
    const fire = (): void => {
      this.bot?.api.sendChatAction(chatId, 'typing').catch(() => {
        /* best-effort */
      });
    };
    fire();
    this.typingTimer = setInterval(fire, 4_000);
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  private scheduleEdit(): void {
    if (this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      void this.flushEdit(false);
    }, this.editFrameMs);
  }

  private async flushEdit(final: boolean): Promise<void> {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    if (!this.bot || !this.currentChatId || !this.currentMessageId) return;
    const frame = this.renderer.snapshot();
    if (!frame || frame === this.lastSentFrame) {
      if (final && !frame) {
        await this.safeEdit(this.currentChatId, this.currentMessageId, '(no output)');
      }
      return;
    }
    const parts = splitForTelegram(frame);
    const head = parts[0]!;
    await this.safeEdit(this.currentChatId, this.currentMessageId, head);
    this.lastSentFrame = head;
    if (final && parts.length > 1) {
      for (const tail of parts.slice(1)) {
        try {
          await this.bot.api.sendMessage(this.currentChatId, tail);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async safeEdit(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.bot!.api.editMessageText(chatId, messageId, text);
    } catch (err) {
      if (err instanceof GrammyError && err.description?.includes('not modified')) return;
      this.opts.logger?.warn('editMessageText failed', { err: String(err) });
    }
  }

  private async askForPermission(call: PendingToolCall, ctx: PermissionContext): Promise<void> {
    if (!this.bot || !this.currentChatId || !this.session) return;
    void ctx;
    // YOLO short-circuit: resolve immediately without rendering a prompt.
    // Mirrors the TUI's `/yolo` flag — once set, every tool call passes.
    if (this.yolo) {
      this.permissionResolver.resolvePending(call.callId, { mode: 'allow', reason: 'yolo mode' });
      return;
    }
    const keyboard = new InlineKeyboard()
      .text('Allow once', `perm:${call.callId}:allow`)
      .text('Allow session', `perm:${call.callId}:allow_session`)
      .row()
      .text('Deny', `perm:${call.callId}:deny`);
    const description = this.session.tools.get(call.name)?.description ?? '';
    const summary =
      `🔐 Tool permission requested\n` +
      `Tool: ${call.name}\n` +
      (description ? `Desc: ${description}\n` : '') +
      `Input: ${truncate(JSON.stringify(call.input), 300)}`;
    try {
      await this.bot.api.sendMessage(this.currentChatId, summary, { reply_markup: keyboard });
    } catch (err) {
      this.opts.logger?.warn('permission send failed', { err: String(err) });
      this.permissionResolver.resolvePending(call.callId, { mode: 'deny', reason: 'unable to render prompt' });
    }
  }

  /** Render an approval request (e.g. plan-execute "validate plan") as a
   *  message + inline-keyboard option list. Options with `requestsText`
   *  are still picked here; we then capture the user's NEXT message as
   *  the follow-up text via the awaitingApprovalText state. */
  private async askForApproval(id: string, request: ApprovalRequest): Promise<void> {
    if (!this.bot || !this.currentChatId) return;
    const keyboard = new InlineKeyboard();
    for (const opt of request.options) {
      const label = `${opt.hotkey ? `[${opt.hotkey}] ` : ''}${opt.label}`;
      keyboard.text(label, `appr:${id}:${opt.id}`).row();
    }
    // Telegram has a ~4096-char message limit; truncate the body so a
    // verbose plan doesn't fail to send. The full plan is also in the
    // chat scrollback (the assistant_message events get streamed in).
    const bodySnippet = truncate(request.body, 3000);
    const summary =
      `📋 ${request.title}\n\n${bodySnippet}\n\n` +
      `Pick an option below. Some options (e.g. Redraft) will prompt for follow-up text after you click.`;
    try {
      await this.bot.api.sendMessage(this.currentChatId, summary, { reply_markup: keyboard });
    } catch (err) {
      this.opts.logger?.warn('approval send failed', { err: String(err) });
      // Default-resolve on send failure so the loop strategy doesn't hang.
      const fallback = request.defaultOptionId ?? request.options[0]?.id ?? 'cancel';
      this.approvalResolver.resolvePending(id, fallback);
    }
  }

  private async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    if (data.startsWith('perm:')) {
      const parts = data.split(':');
      if (parts.length !== 3) return;
      const [, callId, choice] = parts;
      if (!callId || !choice) return;
      const decision = mapChoice(choice);
      const handled = this.permissionResolver.resolvePending(callId, decision);
      await ctx.answerCallbackQuery({ text: handled ? choice : 'no pending permission' });
      if (handled && ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageReplyMarkup({});
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (data.startsWith('appr:')) {
      // Format: appr:<approvalId>:<optionId>
      const idx = data.indexOf(':', 5);
      if (idx < 0) return;
      const approvalId = data.slice(5, idx);
      const optionId = data.slice(idx + 1);
      const pending = this.approvalResolver.getPending(approvalId);
      if (!pending) {
        await ctx.answerCallbackQuery({ text: 'no pending approval' });
        return;
      }
      const option = pending.request.options.find((o) => o.id === optionId);
      if (!option) {
        await ctx.answerCallbackQuery({ text: 'unknown option' });
        return;
      }
      // Clear the inline keyboard so the user can't double-click.
      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageReplyMarkup({});
        } catch {
          /* ignore */
        }
      }
      if (option.requestsText) {
        // Don't resolve yet — capture the user's next message as the
        // follow-up text. Mirrors the TUI dialog's text-entry sub-mode.
        this.awaitingApprovalText = { approvalId, optionId };
        await ctx.answerCallbackQuery({ text: option.label });
        const prompt =
          option.textPrompt ??
          `Send your message — the next text you type becomes the ${optionId} input.`;
        if (this.currentChatId && this.bot) {
          try {
            await this.bot.api.sendMessage(this.currentChatId, `✏️ ${prompt}`);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      this.approvalResolver.resolvePending(approvalId, optionId);
      await ctx.answerCallbackQuery({ text: option.label });
      return;
    }

    if (data.startsWith('model:')) {
      // Format: model:<providerName>::<modelId>
      const payload = data.slice(6);
      const [providerId, modelId] = payload.split('::');
      if (!providerId || !modelId || !this.session) {
        await ctx.answerCallbackQuery({ text: 'invalid model selection' });
        return;
      }
      // Intercept switches to unconfigured providers — otherwise OAuth-
      // backed providers (openai-codex) would surface a credential
      // error on the next turn. Match the TUI's wording so the user
      // sees the same setup command in both channels.
      const ready =
        (this.session as unknown as { readyProviders?: Set<string> }).readyProviders ??
        new Set<string>();
      if (!ready.has(providerId)) {
        const cmd =
          providerId === 'openai-codex'
            ? 'moxxy login openai-codex'
            : `moxxy init   # (will prompt for ${providerId.toUpperCase()}_API_KEY)`;
        await ctx.answerCallbackQuery({ text: `${providerId} not connected` });
        if (ctx.callbackQuery?.message) {
          try {
            await ctx.editMessageText(
              `${providerId} isn't connected.\n\nRun \`${cmd}\` then restart moxxy.`,
              { parse_mode: 'Markdown' },
            );
          } catch {
            /* ignore */
          }
        }
        return;
      }
      try {
        if (this.session.providers.getActiveName() !== providerId) {
          // Resolve credentials and drop the cached instance, same as
          // the TUI. Without this the new provider gets createClient({})
          // and openai-codex throws "no OAuth credentials" on next turn.
          const resolver = (
            this.session as unknown as {
              credentialResolver?: (name: string) => Promise<Record<string, unknown>>;
            }
          ).credentialResolver;
          const cfg = resolver ? await resolver(providerId) : {};
          const def = this.session.providers.list().find((p) => p.name === providerId);
          if (def) this.session.providers.replace(def);
          this.session.providers.setActive(providerId, cfg);
        }
        this.activeModelOverride = modelId;
        // Persist for next CLI run — same preferences file the TUI writes.
        void savePreferences({ providerName: providerId, model: modelId });
        await ctx.answerCallbackQuery({ text: `→ ${providerId}:${modelId}` });
        if (ctx.callbackQuery?.message) {
          try {
            await ctx.editMessageText(`✓ switched to ${providerId}:${modelId}`);
          } catch {
            /* ignore */
          }
        }
      } catch (err) {
        await ctx.answerCallbackQuery({
          text: `failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    if (data.startsWith('loop:')) {
      const loopName = data.slice(5);
      if (!loopName || !this.session) {
        await ctx.answerCallbackQuery({ text: 'invalid loop' });
        return;
      }
      try {
        this.session.loops.setActive(loopName);
        void savePreferences({ loopStrategy: loopName });
        await ctx.answerCallbackQuery({ text: `loop → ${loopName}` });
        if (ctx.callbackQuery?.message) {
          try {
            await ctx.editMessageText(`✓ loop strategy → ${loopName}`);
          } catch {
            /* ignore */
          }
        }
      } catch (err) {
        await ctx.answerCallbackQuery({
          text: `failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }
  }
}

function mapChoice(choice: string): import('@moxxy/sdk').PermissionDecision {
  if (choice === 'allow') return { mode: 'allow' };
  if (choice === 'allow_session') return { mode: 'allow_session' };
  return { mode: 'deny', reason: 'denied by user' };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
