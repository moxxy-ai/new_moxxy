/**
 * Shared moxxy logo data — consumed by the TUI's React `<Logo />` component
 * AND by the CLI's plain-string `renderLogo()` helper, so help screens,
 * the init wizard banner, and the TUI mount all show the same banner +
 * slogan during a single process.
 */

/**
 * ASCII rendition of the moxxy mark: a block-letter X drawn with `X`
 * strokes and `:` fill, flanked by `X::X` bar segments at the waist.
 * Mirrors the SVG at https://moxxy.ai/logo.svg — diamond X centered,
 * with the SVG's short outer `|` strokes rendered as `X::X` so the
 * bars carry the same fill-thickness as the X arms.
 * 10 rows × 19 columns; pure ASCII, renders identically in every
 * terminal.
 */
export const LOGO_LINES: ReadonlyArray<string> = [
  '   XXXXX        XXXXX   ',
  '    X:::X      X:::X    ',
  '     X:::X    X:::X     ',
  '      X:::X  X:::X      ',
  'X::X   X::::::::X   X::X',
  'X::X   X::::::::X   X::X',
  '      X:::X  X:::X      ',
  '     X:::X    X:::X     ',
  '    X:::X      X:::X    ',
  '   XXXXX        XXXXX   ',
];

/**
 * Catalog of rotating slogans. Pick one per process so `moxxy --help` and
 * the TUI mount stay consistent during the same invocation. Aim for ≤60
 * chars and a mild attitude.
 */
export const SLOGANS: ReadonlyArray<string> = [
  'block-by-block agentic modes',
  'every block swappable, every skill replicable',
  'skills that breed skills, plugins that hot-load',
  'the framework that builds itself',
  'modes. tools. skills. all yours.',
  'agents, assembled from interchangeable parts',
  'an event log, a loop, and a lot of plugins',
  'your agent stack, with the cover off',
  'self-improving by design, paranoid by default',
  'open-loop architecture for closed-loop agents',
];

let cachedSlogan: string | null = null;
/**
 * Returns a single slogan, cached for the lifetime of the process so every
 * caller in the same `moxxy` invocation sees the same line.
 */
export function pickSlogan(): string {
  if (cachedSlogan !== null) return cachedSlogan;
  cachedSlogan = SLOGANS[Math.floor(Math.random() * SLOGANS.length)]!;
  return cachedSlogan;
}

/**
 * Pool of concrete example prompts surfaced on the boot screen as
 * "type something like this" starters. Spans coding, automation,
 * webhooks, scheduler, memory, and skills — the moxxy capability axes —
 * so any two-pick rotation hints at the breadth of what's possible.
 */
export const EXAMPLES: ReadonlyArray<string> = [
  // Coding / repo
  'explain how this codebase fits together',
  'fix the failing tests in src/',
  'draft a PR description for my current branch',
  'review my last commit',
  'summarize what changed in the last 7 commits',
  // Automation / scheduler
  'schedule a daily summary at 9am and ping me on Telegram',
  'remind me at 8am to run standup',
  'every Friday run the dependency audit and email me the result',
  // Webhooks / integrations
  'set up a webhook for new GitHub issues and triage each one',
  'ping me on Telegram when CI fails on main',
  'alert me whenever a Stripe charge fails',
  // Memory / skills
  'remember that I prefer terse responses',
  'create a skill for my morning standup workflow',
  // Research / web
  'summarize today\'s top Hacker News stories',
  'find the docs page for moxxy webhooks and quote the key bits',
];

let cachedExamples: ReadonlyArray<string> | null = null;
/**
 * Returns `n` distinct example prompts (default 2), cached for the
 * lifetime of the process so re-renders never shuffle what the user
 * already saw. Subsequent calls return the SAME picks even with
 * different `n` — the first call wins. That keeps the boot-screen
 * suggestion list stable across React re-renders.
 */
export function pickExamples(n: number = 2): ReadonlyArray<string> {
  if (cachedExamples !== null) return cachedExamples;
  const pool = [...EXAMPLES];
  const out: string[] = [];
  for (let i = 0; i < n && pool.length > 0; i += 1) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool[idx]!);
    pool.splice(idx, 1);
  }
  cachedExamples = out;
  return cachedExamples;
}
