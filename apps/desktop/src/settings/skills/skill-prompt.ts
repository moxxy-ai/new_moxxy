/**
 * Prompt template for the "Generate with AI" flow — wraps the user's
 * free-text description in a skill-shaped instruction so the model emits
 * raw skill markdown (YAML frontmatter + body) and nothing else.
 */
export const SKILL_PROMPT_TEMPLATE = (description: string): string => `You are
generating a new \`moxxy\` skill file. Skills are short Markdown docs
the agent loads to gain a capability. They open with YAML frontmatter
of \`name:\` (kebab-case slug), \`description:\` (single sentence about
when to use it), and then a body describing inputs, steps, and
constraints in plain prose.

Output ONLY the raw skill markdown (no commentary, no surrounding
code fence). Aim for a focused, single-purpose skill.

USER DESCRIPTION:
${description}`.trim();
