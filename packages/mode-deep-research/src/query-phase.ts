import {
  buildSystemPromptWithSkills,
  collectProviderStream,
  runCompactionIfNeeded,
  usageEventFields,
  type ModeContext,
  type ProviderMessage,
} from '@moxxy/sdk';

import {
  FOLLOWUP_PLAN_SYSTEM_PROMPT,
  QUERY_PLAN_SYSTEM_PROMPT,
} from './constants.js';
import type { RoundFinding } from './fanout-phase.js';

/**
 * Drive the initial query-planning turn. Single-shot stream — the
 * planner shouldn't be web-searching, that's the subagents' job.
 * Returns the raw text, or null on provider error (already emitted).
 */
export async function collectQueryPlan(
  ctx: ModeContext,
  redraftFeedback: string | null,
): Promise<string | null> {
  const messages = buildPlannerMessages(
    ctx,
    QUERY_PLAN_SYSTEM_PROMPT,
    buildInitialUserMessages(ctx, redraftFeedback),
  );
  return streamSingleShot(ctx, messages);
}

/**
 * Drive the follow-up planning turn between gather rounds. The model
 * sees the prior round(s)' findings as context and decides whether to
 * spawn more parallel research or move to synthesis.
 */
export async function collectFollowupPlan(
  ctx: ModeContext,
  originalPrompt: string,
  priorFindings: ReadonlyArray<RoundFinding>,
): Promise<string | null> {
  const messages = buildPlannerMessages(
    ctx,
    FOLLOWUP_PLAN_SYSTEM_PROMPT,
    buildFollowupUserMessages(originalPrompt, priorFindings),
  );
  return streamSingleShot(ctx, messages);
}

async function streamSingleShot(
  ctx: ModeContext,
  messages: ProviderMessage[],
): Promise<string | null> {
  await runCompactionIfNeeded(ctx);

  await ctx.emit({
    type: 'provider_request',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    provider: ctx.provider.name,
    model: ctx.model,
  });

  const { text, usage, error } = await collectProviderStream(ctx, messages, {
    includeTools: false,
    maxTokens: 800,
  });
  if (error) {
    await ctx.emit({
      type: 'error',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      kind: error.retryable ? 'retryable' : 'fatal',
      message: error.message,
    });
    return null;
  }

  await ctx.emit({
    type: 'provider_response',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    provider: ctx.provider.name,
    model: ctx.model,
    ...usageEventFields(usage),
  });

  return text;
}

function buildPlannerMessages(
  ctx: ModeContext,
  systemPrompt: string,
  userMessages: ProviderMessage[],
): ProviderMessage[] {
  const systemWithSkills =
    buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list()) ?? '';
  return [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: systemPrompt + (systemWithSkills ? `\n\n${systemWithSkills}` : ''),
        },
      ],
    },
    ...userMessages,
  ];
}

function buildInitialUserMessages(
  ctx: ModeContext,
  redraftFeedback: string | null,
): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const e of ctx.log.slice()) {
    if (e.type === 'user_prompt') {
      out.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
    }
  }
  if (redraftFeedback) {
    out.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `The previous query plan needs to be redrafted. Feedback from the user: ${redraftFeedback}\n\n` +
            `Produce a new QUERIES block addressing this feedback.`,
        },
      ],
    });
  }
  return out;
}

function buildFollowupUserMessages(
  originalPrompt: string,
  priorFindings: ReadonlyArray<RoundFinding>,
): ProviderMessage[] {
  const sections: string[] = [];
  sections.push(`Original question:\n${originalPrompt}`);
  sections.push('');
  sections.push('Prior research findings:');
  for (const f of priorFindings) {
    sections.push('');
    sections.push(`### Round ${f.round}, sub-question: ${f.question}`);
    if (f.error) {
      sections.push(`(errored: ${f.error})`);
    } else {
      sections.push(f.text.trim() || '(empty response)');
    }
  }
  sections.push('');
  sections.push(
    'Decide whether more parallel research is needed. Reply with a FOLLOWUPS: block as instructed.',
  );
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: sections.join('\n') }],
    },
  ];
}
