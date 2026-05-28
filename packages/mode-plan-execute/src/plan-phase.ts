import {
  buildSystemPromptWithSkills,
  runSingleShotTurn,
  type ModeContext,
  type ProviderMessage,
} from '@moxxy/sdk';

import { PLAN_SYSTEM_PROMPT } from './constants.js';

/**
 * Drive the planner: collect a plan draft from the provider and emit the
 * streaming chunks + provider request/response bookends. Returns the raw
 * plan text, or `null` when the provider errored (already emitted).
 */
export async function collectPlan(
  ctx: ModeContext,
  redraftFeedback: string | null,
): Promise<string | null> {
  const messages = buildPlannerMessages(ctx, redraftFeedback);
  return runSingleShotTurn(ctx, messages, { maxTokens: 1024 });
}

function buildPlannerMessages(
  ctx: ModeContext,
  redraftFeedback: string | null,
): ProviderMessage[] {
  const userMessages = buildBaseUserMessages(ctx);
  // On redraft, append the user's feedback as an extra user turn so the
  // planner sees both the original request AND what they wanted changed.
  if (redraftFeedback) {
    userMessages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `The previous plan needs to be redrafted. Feedback from the user: ${redraftFeedback}\n\n` +
            `Produce a new PLAN block addressing this feedback.`,
        },
      ],
    });
  }
  // Include skills in the planner's view so plans can name skills as
  // steps (e.g. "Use the media-digest skill") instead of always routing
  // to generic tools like web_fetch.
  const systemWithSkills = buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list()) ?? '';
  return [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: PLAN_SYSTEM_PROMPT + (systemWithSkills ? `\n\n${systemWithSkills}` : ''),
        },
      ],
    },
    ...userMessages,
  ];
}

/**
 * Slim baseline used only by the planning phase: just the raw user
 * prompts, no assistant/tool history.
 */
function buildBaseUserMessages(ctx: ModeContext): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const e of ctx.log.slice()) {
    if (e.type === 'user_prompt') {
      out.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
    }
  }
  return out;
}
