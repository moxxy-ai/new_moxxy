/**
 * Shared moxxy logo data — consumed by the TUI's React `<Logo />` component
 * AND by the CLI's plain-string `renderLogo()` helper, so help screens,
 * the init wizard banner, and the TUI mount all show the same banner +
 * slogan during a single process.
 */

/**
 * The moxxy mascot, rendered as grayscale ASCII art. Drawn dim-gray
 * everywhere it appears (boot screen, TUI header, `--help`/`--version`,
 * init wizard) so the picture reads as quiet chrome in any terminal theme.
 *
 * Rows are stored right-trimmed; `LOGO_LINES` pads every row to the widest
 * one (`LOGO_WIDTH`) so per-row centering keeps the columns aligned. The art
 * needs a wide terminal to look right — see `LOGO_MIN_WIDTH` and
 * `selectLogo`, which fall back to the `MOXXY` wordmark on narrow ones.
 */
const LOGO_ART_RAW: ReadonlyArray<string> = [
  "                                            mw#dddddd#d",
  "                       ZMMd#MMMMMmhM*    p&X?<-}__-_>^>Mh",
  "                     W%j~^,tnx|)?.  -]Q*#%^+}t+fLu|{-<,^fOou",
  "                 Q#b{+|Yn|((1{?--+>-_<~,!.;!i,[[uz1,i?--_-I\\8$",
  "               WB|!}tOmmL/1]]??_+;,;;;<il` ^',l>I^-un[??-_!l>*k",
  "        p&8bxawl~[)tzZmOJ({_~>!!>~~++:,:,,,.^`.`.:l_]}+,^..`\"^r&O",
  "        W{18u<}?](|?~<?{]<l`':+++++l,:i:^^.,::;l!.`,\"'i[/)-!!''+&h",
  "        8(]|]_+~i<|f)->;:1/\\{?????---l`,'\">]}\\[-+l; \":~]>?<_~;I.x&J",
  "         d%J <tu\\[-!l?XQz/}]]????-~-I^ `l+1/x-+-~I:I,ld%ni-~Il:~.aJ",
  "        b&+{Y/]->>(/vCjcQUt)[(}?>-;\".,!-?_ii1-+!;l;,:,,+`,,l::Ii^hJ",
  "       &b?L\\-+!~]])/tu0000C|_{(|-:^ ' ^_|tz0r:,::,^'  lu \",\"^,!}\"aJ",
  " zx   8;}|_+!_???]]?1///{<]QO01;, 1|nj/ \"_f|[?~^\",,,,^>u ^\"\".,<}UM",
  "bk~CQL(Y-Il-?_-?????_~<_/cr[iI: <fCb*hpJ_`^`;li!!:`'. {U>'\"i'}x>W*",
  " a*,{t/<,]?_~?????<<---+l;;>.^||Lp*#*#hqmu'l<,.'\"\"\"`.l%v?'^`}iq#",
  "  wb&B!+1->>???_>_-<!;Ii!.;1\\rZq\\,^``''lCwQ-':;;``+UJrIf_,` :Wp",
  "   QMJL|_l+???i++!;><::?(|xOqqq.iUqqqqqqJ0wU\\'`'lO#t`+Yt;`^\"laaO",
  "   Q#\\c~^_-?<<i;i}`     ~wqqqqqqqU;''l[wzwwUx+^>a@1<WaJbx\\ \"\":`b*",
  "  {MIw< <-->l;++ +_tfzOwqqqqqqqq:iu}1    +mUniIjBJ<@Mp]_Y</ (]-]*",
  "  )M>x.l+_lI>).  1_).   :qqqqqqqX&\"vt  ,OmZLn`;\";`J8Lp`'Y]z.[kWax",
  "  {#,j )<!I!? .  !. |Z\"BJ!qqqqqq@@(:`:_wwbw0u',(.'vdYr'ld?C:[k",
  "  x*W+^n+!;~ ``.')YXk8'  iqqqqqqqB&uJmwqo%8Ln''Ic`;1c*<*)fl 8k",
  "    mbr^U>;; ^^'^1dwqMp!1mqqqqqqqqqqqmoqdwmYn] 'l; !-tkLv<.ha",
  "     qb!:n!:'`\" IlMwqqqqqqqqqwLJU?qqqZpqapdUnu_ '::'\"(n]:`h0",
  "      zYW+c<:.``^,8mqqqqq0.qWM0(^0wqqZpwphmYxvfui :~<\"\">#kz",
  "         Mu^+I`.' qqwqqqqqq}\"-~{wqqqwwqwwZ0vxnuC?.~n8*a",
  "          Z8\"~;^'.\"%OwwqqqqqqqqqqqwmQnrft/\\juQXI^&#Q",
  "        qpXM[i<`'YM(>/j/jt\\((1{}[]?-]?_<;^.  |z*#",
  "        h>`\"1i'\";*dpwBBB< >   '!]-:` 'pI .l t!&",
  "        aMu:.`'/Mk    aw-ncjYCYYYXczr|_!!>(UQ;&",
  "          zddkdq      x*o,I?pd&BB*aqxf,+i!,,w8w",
  "                        xq*aOCXvxrrxuzU0*#*kQ",
];

/** Widest mascot row; every `LOGO_LINES` row is padded to this. */
export const LOGO_WIDTH = LOGO_ART_RAW.reduce((m, l) => Math.max(m, l.length), 0);

/**
 * The mascot, every row padded to `LOGO_WIDTH`. Equal-width rows mean a
 * per-row center pad shifts the whole picture as one block instead of
 * ragged-centering each line and shearing the art.
 */
export const LOGO_LINES: ReadonlyArray<string> = LOGO_ART_RAW.map((l) => l.padEnd(LOGO_WIDTH));

/**
 * Block-letter `MOXXY` wordmark shown when the terminal is too narrow for the
 * mascot (see `selectLogo`). Stored right-trimmed; `WORDMARK_LINES` pads to
 * `WORDMARK_WIDTH`.
 */
const WORDMARK_RAW: ReadonlyArray<string> = [
  'M   M   OOO   X   X  X   X  Y   Y',
  'MM MM  O   O   X X    X X    Y Y',
  'M M M  O   O    X      X      Y',
  'M   M  O   O   X X    X X     Y',
  'M   M   OOO   X   X  X   X    Y',
];

/** Widest wordmark row; every `WORDMARK_LINES` row is padded to this. */
export const WORDMARK_WIDTH = WORDMARK_RAW.reduce((m, l) => Math.max(m, l.length), 0);

/** The `MOXXY` wordmark, every row padded to `WORDMARK_WIDTH`. */
export const WORDMARK_LINES: ReadonlyArray<string> = WORDMARK_RAW.map((l) =>
  l.padEnd(WORDMARK_WIDTH),
);

/** Below this terminal width the mascot is dropped for the `MOXXY` wordmark. */
export const LOGO_MIN_WIDTH = 80;
/** Below this terminal width the wordmark is dropped for a one-line text mark. */
export const WORDMARK_MIN_WIDTH = 40;

export interface LogoSelection {
  /** Which rendition fits: the full mascot, the `MOXXY` wordmark, or plain text. */
  readonly kind: 'art' | 'wordmark' | 'text';
  /** Equal-width rows to render (a single row for `text`). */
  readonly lines: ReadonlyArray<string>;
}

/**
 * Pick the widest moxxy mark that fits `width`. The mascot only looks right on
 * a wide terminal, so narrower ones step down to the `MOXXY` wordmark, then to
 * a one-line `moxxy` text mark. Shared by the TUI components and the CLI's
 * plain-string `renderLogo()` so every surface steps down identically.
 */
export function selectLogo(width: number): LogoSelection {
  if (width >= LOGO_MIN_WIDTH) return { kind: 'art', lines: LOGO_LINES };
  if (width >= WORDMARK_MIN_WIDTH) return { kind: 'wordmark', lines: WORDMARK_LINES };
  return { kind: 'text', lines: ['moxxy'] };
}

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
