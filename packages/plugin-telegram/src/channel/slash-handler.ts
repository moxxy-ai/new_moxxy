import { type Bot, type Context, InlineKeyboard } from 'grammy';
import type { Session } from '@moxxy/core';

export interface SlashState {
  readonly session: Session | null;
  readonly model: string | undefined;
  readonly activeModelOverride: string | null;
  readonly yolo: boolean;
}

export interface SlashCallbacks {
  /** Toggle yolo and return its new value (so we can echo the right message). */
  toggleYolo(): boolean;
  /** Apply a `session-action` result emitted from a registered command. */
  performSessionAction(
    ctx: Context,
    action: 'new' | 'clear' | 'exit',
    notice: string | undefined,
  ): Promise<void>;
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
 * /skills as text dumps).
 */
export async function runSlash(
  ctx: Context,
  text: string,
  state: SlashState,
  cb: SlashCallbacks,
): Promise<void> {
  const session = state.session;
  if (!session) return;
  const [head, ...rest] = text.split(/\s+/);
  const name = head!.slice(1);
  const args = rest.join(' ');

  // 1) Shared registry dispatch.
  const registered = session.commands.get(name);
  if (registered) {
    try {
      const result = await registered.handler({
        channel: 'telegram',
        sessionId: session.id,
        args,
        session,
      });
      if (result.kind === 'text') {
        await ctx.reply(result.text);
      } else if (result.kind === 'session-action') {
        await cb.performSessionAction(ctx, result.action, result.notice);
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
    case '/model':
      await renderModelPicker(ctx, session, state);
      return;
    case '/loop':
      await renderLoopPicker(ctx, session);
      return;
    case '/yolo': {
      const enabled = cb.toggleYolo();
      await ctx.reply(
        enabled
          ? '⚠ yolo mode ON — tool calls auto-approved for the rest of this session'
          : 'yolo mode OFF — tool prompts will resume',
      );
      return;
    }
    case '/tools': {
      const list = session.tools
        .list()
        .map((t) => `${t.name} — ${t.description}`)
        .join('\n');
      await ctx.reply(list || '(no tools registered)');
      return;
    }
    case '/skills': {
      const list = session.skills
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

async function renderModelPicker(
  ctx: Context,
  session: Session,
  state: SlashState,
): Promise<void> {
  const providers = session.providers.list();
  if (providers.length === 0) {
    await ctx.reply('no providers registered');
    return;
  }
  const keyboard = new InlineKeyboard();
  const providerName = session.providers.getActiveName() ?? '';
  const activeModel = state.activeModelOverride ?? state.model ?? '';
  // Same boot-time readiness set the TUI uses to flag unconfigured
  // providers — set by `@moxxy/cli` at setup time. Providers that
  // failed credential resolution get a "(not connected)" suffix
  // and a tap on them surfaces the right setup command instead of
  // a no-op switch.
  const ready =
    (session as unknown as { readyProviders?: Set<string> }).readyProviders ??
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
}

async function renderLoopPicker(ctx: Context, session: Session): Promise<void> {
  const strategies = session.loops.list();
  if (strategies.length === 0) {
    await ctx.reply('no loop strategies registered');
    return;
  }
  const keyboard = new InlineKeyboard();
  const activeLoopName = (() => {
    try {
      return session.loops.getActive().name;
    } catch {
      return '';
    }
  })();
  for (const s of strategies) {
    const isCurrent = s.name === activeLoopName;
    keyboard.text(`${isCurrent ? '• ' : ''}${s.name}`, `loop:${s.name}`).row();
  }
  await ctx.reply('Pick a loop strategy:', { reply_markup: keyboard });
}

/**
 * Push the union of registry commands + Telegram-local commands to
 * Telegram so they appear in the chat's command menu (the "/" picker
 * the official client shows). Best-effort: a network failure here
 * doesn't block channel startup, the commands still work via text.
 */
export async function publishBotCommands(
  bot: Bot | null,
  session: Session | null,
  logger?: { warn?(msg: string, meta?: Record<string, unknown>): void },
): Promise<void> {
  if (!session || !bot) return;
  const LOCAL: Array<{ command: string; description: string }> = [
    { command: 'model', description: 'Switch provider + model (inline keyboard)' },
    { command: 'loop', description: 'Switch loop strategy' },
    { command: 'yolo', description: 'Toggle auto-approve mode' },
    { command: 'tools', description: 'List the tools the active session can call' },
    { command: 'skills', description: 'List the discovered skills' },
    { command: 'cancel', description: 'Abort the current turn' },
  ];
  const shared = session.commands
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
    await bot.api.setMyCommands(merged);
  } catch (err) {
    logger?.warn?.('telegram setMyCommands failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
