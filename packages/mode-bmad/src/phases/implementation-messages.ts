import {
  buildSystemPromptWithSkills,
  type ModeContext,
  type ProviderMessage,
} from '@moxxy/sdk';

import type { Artifacts } from '../constants.js';

/**
 * Single context block instead of three consecutive assistant messages.
 * Several providers (including codex /responses) handle alternating
 * user/assistant turns much better than 3+ consecutive assistant blocks
 * — the latter was making the codex implementation phase return
 * end_turn with empty text on iteration 1, which the loop was
 * mis-reading as "story complete" and exiting silently.
 */
export function buildBmadContext(artifacts: Artifacts): string {
  return (
    `BMAD context — three prior phases produced these artifacts:\n\n` +
    `## Analyst brief\n${artifacts.analysis}\n\n` +
    `## Story list\n${artifacts.planning}\n\n` +
    `## Architect's design\n${artifacts.solutioning}`
  );
}

export function buildDevNudge(stories: ReadonlyArray<string>): string {
  const storyList = stories.map((s, i) => `  ${i + 1}. [ ] ${s}`).join('\n');
  return (
    `Developer persona. Implement the stories above now using the available ` +
    `tools. Work through them in order; flow between stories as needed. ` +
    `Do not narrate — call the tools. When all acceptance criteria are met, ` +
    `reply with one short summary line and stop.\n\n` +
    `Stories to implement:\n${storyList}`
  );
}

/**
 * Message builder for the implementation phase. Instead of replaying every
 * `assistant_message` from the log (which produces three consecutive
 * assistant turns and confuses providers like codex /responses), we
 * collapse the BMAD artifacts into a single context-bearing user message
 * before the developer nudge. The resulting shape on iteration 1 is:
 *
 *   system   = systemPrompt + skill index
 *   user[0]  = original prompt + tool_result blocks from the live log
 *   user[1]  = BMAD context (analyst brief, stories, design)
 *   user[2]  = developer nudge ("implement these now, use tools")
 *
 * On subsequent iterations only the live conversation (with whatever
 * tool calls and results the developer has produced) is replayed,
 * because the context block is already established via iteration 1.
 */
export function buildImplementationMessages(
  ctx: ModeContext,
  bmadContext: string | null,
  devNudge: string | null,
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  const systemText =
    buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list()) ?? ctx.systemPrompt;
  if (systemText) {
    messages.push({ role: 'system', content: [{ type: 'text', text: systemText }] });
  }

  // Replay the live tool-use trace: user_prompt + (assistant tool_use /
  // tool_result) chains the developer has produced since the BMAD
  // artifacts. Pure assistant_message events from the artifact phases
  // are intentionally skipped — those go into the BMAD context block
  // instead so the provider sees alternating user/assistant turns.
  let pendingAssistant:
    | { role: 'assistant'; content: Array<{ type: 'tool_use'; id: string; name: string; input: unknown }> }
    | null = null;
  const flushAssistant = (): void => {
    if (pendingAssistant) {
      messages.push(pendingAssistant);
      pendingAssistant = null;
    }
  };
  for (const e of ctx.log.slice()) {
    if (e.type === 'user_prompt') {
      flushAssistant();
      messages.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
    } else if (e.type === 'tool_call_requested') {
      if (!pendingAssistant) pendingAssistant = { role: 'assistant', content: [] };
      pendingAssistant.content.push({
        type: 'tool_use',
        id: String(e.callId),
        name: e.name,
        input: e.input,
      });
    } else if (e.type === 'tool_result') {
      flushAssistant();
      const text = e.error
        ? `[error:${e.error.kind}] ${e.error.message}`
        : typeof e.output === 'string'
          ? e.output
          : JSON.stringify(e.output ?? '');
      messages.push({
        role: 'tool_result',
        content: [{ type: 'tool_result', toolUseId: String(e.callId), content: text, isError: !e.ok }],
      });
    }
  }
  flushAssistant();

  // Inject the BMAD context + dev nudge as standalone user turns on the
  // first iteration so the model has clean alternation.
  if (bmadContext) {
    messages.push({ role: 'user', content: [{ type: 'text', text: bmadContext }] });
  }
  if (devNudge) {
    messages.push({ role: 'user', content: [{ type: 'text', text: devNudge }] });
  }
  return messages;
}
