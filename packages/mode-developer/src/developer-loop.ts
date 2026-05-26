import { toolUseMode } from '@moxxy/mode-tool-use';
import {
  asToolCallId,
  type ModeContext,
  type MoxxyEvent,
} from '@moxxy/sdk';

import { runCommitApprovalGate } from './commit-approval.js';
import {
  DEFAULT_MAX_ITERATIONS,
  DEVELOPER_MODE_NAME,
  DEVELOPER_PLUGIN_ID,
  DEVELOPER_SYSTEM_PROMPT,
} from './constants.js';
import { collectChangedFiles } from './diff-preview.js';
import { formatCommitMessage, parseVerify } from './parse-verify.js';
import { runVerifyPhase } from './verify-phase.js';

/**
 * Developer mode driver: tool-use sub-loop under a developer-flavored
 * system prompt, then a forced verify phase, then a deterministic diff
 * preview + commit approval gate. Headless contexts (no ctx.approval)
 * skip the commit gate but still emit the suggested message so a script
 * or Telegram session sees it.
 */
export async function* runDeveloperMode(ctx: ModeContext): AsyncIterable<MoxxyEvent> {
  if (ctx.signal.aborted) {
    yield await ctx.emit({
      type: 'abort',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      reason: 'aborted before developer mode start',
    });
    return;
  }

  yield await ctx.emit({
    type: 'mode_iteration',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    strategy: DEVELOPER_MODE_NAME,
    iteration: 0,
    routing: 'unresolved',
  });

  yield await ctx.emit({
    type: 'plugin_event',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'plugin',
    pluginId: DEVELOPER_PLUGIN_ID,
    subtype: 'developer_implementation_started',
    payload: {},
  });

  // Phase 1: tool-use loop with the developer system prompt layered on top.
  // We wrap the ctx so runToolUseMode sees a composed prompt without us
  // having to fork its iteration logic. maxIterations is dialed down from
  // tool-use's default (500) because dev sessions should be punchy.
  const composedSystem = composeSystemPrompts(ctx.systemPrompt, DEVELOPER_SYSTEM_PROMPT);
  const devToolUseCtx: ModeContext = {
    ...ctx,
    systemPrompt: composedSystem,
    maxIterations: ctx.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  };
  for await (const ev of toolUseMode.run(devToolUseCtx)) {
    yield ev;
  }

  if (ctx.signal.aborted) return;

  // If the model ended the implementation phase by asking the user a question
  // or requesting an action (e.g. "run `/vault set <key>`"), it is PAUSED
  // waiting for input — not declaring the work done. Forcing the verify+commit
  // phase here would re-invoke the model (so it looks like it "keeps thinking"
  // after it already stopped to ask) and could commit a half-finished change.
  // Yield back to the user instead.
  if (lastTurnAwaitsUser(ctx)) {
    yield await ctx.emit({
      type: 'plugin_event',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'plugin',
      pluginId: DEVELOPER_PLUGIN_ID,
      subtype: 'developer_awaiting_user',
      payload: { reason: 'implementation phase ended awaiting user input' },
    });
    return;
  }

  // Short-circuit when the tool-use phase didn't actually modify any
  // files. Common cases: the user just said "hi", asked a question
  // about the codebase, or the model decided it needed clarification
  // before editing. In all those, running a verify pass + opening a
  // commit gate is pure noise — there's nothing to commit. We do the
  // diff gather ONCE here and reuse it later if we don't short-circuit.
  const diff = await collectChangedFiles(process.cwd());
  yield await ctx.emit({
    type: 'plugin_event',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'plugin',
    pluginId: DEVELOPER_PLUGIN_ID,
    subtype: 'developer_diff_collected',
    payload: {
      filesShown: diff.files.length,
      totalFiles: diff.totalFiles,
      empty: diff.empty,
      ...(diff.error ? { error: diff.error } : {}),
    },
  });

  if (diff.empty && !diff.error) {
    yield await ctx.emit({
      type: 'plugin_event',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'plugin',
      pluginId: DEVELOPER_PLUGIN_ID,
      subtype: 'developer_no_changes_detected',
      payload: { reason: 'tool-use phase ended without modifying any files' },
    });
    return;
  }

  // Phase 2: verify + report (SUMMARY: / COMMIT: blocks).
  yield await ctx.emit({
    type: 'plugin_event',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'plugin',
    pluginId: DEVELOPER_PLUGIN_ID,
    subtype: 'developer_verify_started',
    payload: {},
  });

  const verifyText = yield* runVerifyPhase(ctx);
  if (verifyText === null || ctx.signal.aborted) return;

  const parsed = parseVerify(verifyText);
  yield await ctx.emit({
    type: 'plugin_event',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'plugin',
    pluginId: DEVELOPER_PLUGIN_ID,
    subtype: 'developer_verify_completed',
    payload: {
      summary: parsed.summary,
      hasCommitSubject: parsed.commitSubject !== null,
    },
  });

  if (!parsed.commitSubject) {
    // Verify phase didn't produce a parseable commit message — surface
    // the raw text and end. Don't open an approval gate with empty
    // contents; that's just confusing.
    return;
  }
  const proposedMessage = formatCommitMessage(parsed.commitSubject, parsed.commitBody);

  // Headless / non-TTY: skip the gate but emit the suggested message so
  // automation can still pipe-and-commit if it wants.
  if (!ctx.approval) {
    yield await ctx.emit({
      type: 'assistant_message',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      content:
        `Headless mode — skipping commit gate. Suggested message:\n\n${proposedMessage}\n\n` +
        `(${diff.files.length} of ${diff.totalFiles} changed file(s) shown in transcript.)`,
      stopReason: 'end_turn',
    });
    return;
  }

  // Phase 4: commit approval gate.
  const gate = await runCommitApprovalGate(ctx, proposedMessage, diff);
  if (gate.kind === 'cancel') {
    yield await ctx.emit({
      type: 'abort',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'user',
      reason: 'commit cancelled by user',
    });
    return;
  }
  if (gate.kind === 'skip') {
    yield await ctx.emit({
      type: 'plugin_event',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'plugin',
      pluginId: DEVELOPER_PLUGIN_ID,
      subtype: 'developer_commit_skipped',
      payload: {},
    });
    return;
  }

  // approve OR edit — run git add + git commit via the Bash tool so the
  // call goes through the same hooks + permission resolver as any other
  // tool. The mode never bypasses permissions for git ops.
  const message = gate.message;
  yield* runGitCommit(ctx, message);
}

function composeSystemPrompts(user: string | undefined, layer: string): string {
  if (!user || user.trim() === '') return layer;
  return `${layer}\n\n---\n\n${user}`;
}

/**
 * Did the implementation phase end with the model asking the user a question
 * or requesting an action? Inspects the most recent assistant message in the
 * log. A turn that ends awaiting user input is a pause, not a completion —
 * the caller skips verify+commit and yields back to the user.
 */
function lastTurnAwaitsUser(ctx: ModeContext): boolean {
  const events = ctx.log.slice();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'assistant_message') return messageAwaitsUser(e.content);
  }
  return false;
}

const AWAIT_USER_PATTERNS: ReadonlyArray<RegExp> = [
  /\/vault\s+set/i, // directing the user to store a secret themselves
  /\bplease\s+(run|provide|share|paste|set|enter|add|confirm)\b/i,
  /\b(can|could|would)\s+you\s+(run|provide|share|paste|confirm|set)\b/i,
  /\bi\s+(need|'ll need|will need)\s+(you|your)\b/i,
  /\blet me know\b/i,
  /\bonce you('ve| have| 're)\b/i,
  /\bwaiting for (you|your)\b/i,
];

/** Heuristic for "this message is awaiting user input": a trailing question
 *  mark, or an explicit request for the user to do/provide something. Biased
 *  to fire on clear pauses (asking for a key, "please run …", "let me know"). */
export function messageAwaitsUser(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // Trailing markdown/punctuation shouldn't hide a closing question mark.
  const lastChar = t.replace(/[`*_)\]\s]+$/, '').slice(-1);
  if (lastChar === '?') return true;
  return AWAIT_USER_PATTERNS.some((re) => re.test(t));
}

async function* runGitCommit(
  ctx: ModeContext,
  message: string,
): AsyncGenerator<MoxxyEvent, void, unknown> {
  // Pass the message through a tempfile + `git commit -F` to avoid any
  // shell quoting concerns with multi-line messages or special chars.
  const tmpPath = `/tmp/moxxy-developer-commit-${ctx.turnId}.txt`;
  const escaped = message.replace(/'/g, "'\\''");
  const command =
    `printf '%s' '${escaped}' > ${tmpPath} && ` +
    `git add -A && ` +
    `git commit -F ${tmpPath}; rc=$?; rm -f ${tmpPath}; exit $rc`;

  const callId = asToolCallId(`developer-commit-${ctx.turnId}`);
  yield await ctx.emit({
    type: 'tool_call_requested',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    callId,
    name: 'Bash',
    input: { command, timeoutMs: 60_000 },
  });

  const decision = await ctx.permissions.check(
    { callId, name: 'Bash', input: { command } },
    { sessionId: String(ctx.sessionId), toolDescription: ctx.tools.get('Bash')?.description },
  );
  if (decision.mode === 'deny') {
    yield await ctx.emit({
      type: 'tool_call_denied',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      callId,
      decidedBy: 'resolver',
      reason: decision.reason ?? 'denied',
    });
    yield await ctx.emit({
      type: 'tool_result',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'tool',
      callId,
      ok: false,
      error: { kind: 'denied', message: decision.reason ?? 'denied' },
    });
    return;
  }
  yield await ctx.emit({
    type: 'tool_call_approved',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    callId,
    decidedBy: 'resolver',
    mode: decision.mode,
  });

  try {
    const output = await ctx.tools.execute('Bash', { command, timeoutMs: 60_000 }, ctx.signal, {
      callId: String(callId),
      sessionId: String(ctx.sessionId),
      turnId: String(ctx.turnId),
      log: ctx.log,
    });
    yield await ctx.emit({
      type: 'tool_result',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'tool',
      callId,
      ok: true,
      output,
    });
    yield await ctx.emit({
      type: 'plugin_event',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'plugin',
      pluginId: DEVELOPER_PLUGIN_ID,
      subtype: 'developer_commit_created',
      payload: { message },
    });
  } catch (err) {
    yield await ctx.emit({
      type: 'tool_result',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'tool',
      callId,
      ok: false,
      error: {
        kind: ctx.signal.aborted ? 'aborted' : 'threw',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
