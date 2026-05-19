import type { LLMProvider } from '@moxxy/sdk';
import { parseSkillFile } from './parse.js';

export interface DraftedSkill {
  raw: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

const DRAFT_SYSTEM_PROMPT = `You are a skill-author. Output ONLY a Markdown file with YAML frontmatter. No prose outside the Markdown. Frontmatter MUST include:
- name (kebab-case slug, <=60 chars, lowercase letters/numbers/hyphens only, starting with a letter)
- description (1 sentence, <=120 chars)
- triggers (array of 2-5 short phrases the user might say)
- allowed-tools (array of tool names, e.g. ["Read", "Edit", "Bash"])

The body is the instructions for future invocations. Keep it under 30 lines. Numbered steps preferred.`;

export async function draftSkill(
  provider: LLMProvider,
  model: string,
  intent: string,
  signal: AbortSignal,
): Promise<DraftedSkill> {
  let accumulated = '';
  for await (const event of provider.stream({
    model,
    system: DRAFT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: `User intent: ${intent}` }] }],
    maxTokens: 2000,
    signal,
  })) {
    if (event.type === 'text_delta') accumulated += event.delta;
    if (event.type === 'error') {
      throw new Error(`synthesizeSkill: provider error: ${event.message}`);
    }
  }

  const raw = extractMarkdownBlock(accumulated);
  const { frontmatter, body } = parseSkillFile(raw);
  return { raw, frontmatter: frontmatter as Record<string, unknown>, body };
}

function extractMarkdownBlock(s: string): string {
  const fence = /```(?:markdown|md)?\n([\s\S]*?)```/.exec(s);
  return fence ? fence[1]! : s;
}
