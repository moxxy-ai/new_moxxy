import type {
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
  PermissionResolver,
  PermissionRule,
} from './permission.js';

export const autoAllowResolver: PermissionResolver = {
  name: 'auto-allow',
  async check(): Promise<PermissionDecision> {
    return { mode: 'allow', reason: 'auto-allow resolver (test mode)' };
  },
};

export const denyByDefaultResolver: PermissionResolver = {
  name: 'deny-by-default',
  async check(): Promise<PermissionDecision> {
    return { mode: 'deny', reason: 'No interactive resolver available in headless mode. Use --allow-tools or permissions.json.' };
  },
};

export interface CallbackResolverOptions {
  readonly name?: string;
  readonly callback: (call: PendingToolCall, ctx: PermissionContext) => Promise<PermissionDecision>;
}

export function createCallbackResolver(opts: CallbackResolverOptions): PermissionResolver {
  return {
    name: opts.name ?? 'callback',
    check: opts.callback,
  };
}

export function createAllowListResolver(toolNames: ReadonlyArray<string>): PermissionResolver {
  const allowed = new Set(toolNames);
  return {
    name: 'allow-list',
    async check(call) {
      if (allowed.has(call.name)) return { mode: 'allow_session', reason: 'allow-list' };
      return { mode: 'deny', reason: `Tool '${call.name}' not in allow-list` };
    },
  };
}

export type PermissionPromptHandler = (
  call: PendingToolCall,
  ctx: PermissionContext,
) => Promise<PermissionDecision>;

export interface DeferredPermissionResolverOptions {
  readonly prompt: PermissionPromptHandler;
  readonly name?: string;
  readonly sessionAllows?: Set<string>;
}

export interface DeferredPermissionResolver extends PermissionResolver {
  /**
   * Resolve all in-flight prompts with `deny`. Call from a channel's `stop`
   * so a pending permission prompt doesn't hang forever when the host UI
   * unmounts (the TUI bug the audit flagged).
   */
  abortAll(reason?: string): void;
}

/**
 * Resolver for channels that defer permission decisions to an external UI
 * (Ink dialog, Telegram inline keyboard, web form). Wraps a `prompt`
 * callback with:
 *   - sessionAllows shortcut — `allow_session` decisions skip subsequent
 *     prompts for the same tool name.
 *   - in-flight tracking — `abortAll()` resolves pending prompts with
 *     `deny`, so the channel can shut down cleanly without hangs.
 */
export function createDeferredPermissionResolver(
  opts: DeferredPermissionResolverOptions,
): DeferredPermissionResolver {
  const sessionAllows = opts.sessionAllows ?? new Set<string>();
  const pending = new Set<(d: PermissionDecision) => void>();
  return {
    name: opts.name ?? 'deferred',
    async check(call, ctx) {
      if (sessionAllows.has(call.name)) {
        return { mode: 'allow_session', reason: 'allow_session previously granted' };
      }
      const decision = await new Promise<PermissionDecision>((resolve) => {
        pending.add(resolve);
        opts.prompt(call, ctx).then(
          (d) => {
            pending.delete(resolve);
            resolve(d);
          },
          (err) => {
            pending.delete(resolve);
            resolve({ mode: 'deny', reason: err instanceof Error ? err.message : String(err) });
          },
        );
      });
      // Both allow_session and allow_always should skip future prompts for
      // the same tool within this resolver instance. allow_always
      // additionally signals to the caller (via the decision flag) that
      // the rule should be persisted to ~/.moxxy/permissions.json — but
      // that persistence isn't our job; the channel does it when wiring
      // up the dialog.
      if (decision.mode === 'allow_session' || decision.mode === 'allow_always') {
        sessionAllows.add(call.name);
      }
      return decision;
    },
    abortAll(reason = 'channel closed') {
      for (const r of pending) r({ mode: 'deny', reason });
      pending.clear();
    },
  };
}

/**
 * Evaluate a tool's OWN declared {@link PermissionRule} against a call.
 *
 * Tools can ship a `permission` rule to express their author's policy — e.g.
 * `reload_skills` / `load_tool` declare `{ action: 'allow' }` because they're
 * safe, internal, idempotent operations that should never prompt. That rule
 * was previously stored on the ToolDef but never consulted, so in headless
 * runs (where the channel resolver denies by default) even these safe tools
 * were blocked. The session resolver now consults this BETWEEN the user's
 * `permissions.json` policy and the channel resolver, so:
 *
 *   user policy (deny/allow)  >  tool-declared rule  >  channel resolver
 *
 * Returns a decision for a matching `allow`/`deny` rule, or `null` to defer
 * (no rule, pattern didn't match, or `action: 'prompt'` — the interactive
 * resolver should handle those).
 */
export function evaluateToolRule(
  rule: PermissionRule | undefined,
  call: PendingToolCall,
): PermissionDecision | null {
  if (!rule || !toolRuleMatches(rule, call)) return null;
  switch (rule.action) {
    case 'allow':
      return { mode: 'allow', reason: rule.reason ?? 'tool-declared allow' };
    case 'deny':
      return { mode: 'deny', reason: rule.reason ?? 'tool-declared deny' };
    case 'prompt':
      return null; // defer to the interactive resolver
  }
}

function toolRuleMatches(rule: PermissionRule, call: PendingToolCall): boolean {
  const p = rule.pattern;
  if (!p) return true; // no pattern → applies to every call of this tool
  if (p.name !== undefined && !patternMatch(p.name, call.name)) return false;
  if (p.inputMatches) {
    const input = (call.input ?? {}) as Record<string, unknown>;
    for (const [key, matcher] of Object.entries(p.inputMatches)) {
      if (!patternMatch(matcher, String(input[key] ?? ''))) return false;
    }
  }
  return true;
}

function patternMatch(pattern: string | RegExp, candidate: string): boolean {
  return pattern instanceof RegExp ? pattern.test(candidate) : pattern === candidate;
}
