/**
 * Read-aloud (text-to-speech) for assistant messages.
 *
 * Two things make the browser's Web Speech API sound robotic out of the
 * box, and this module fixes both:
 *
 *   1. **It reads markdown punctuation literally** — "hash hash Heading",
 *      "star star bold", "backtick code backtick", URL soup from links.
 *      {@link toSpeakableText} strips the syntax down to the prose a human
 *      would actually say, dropping code fences entirely (a fenced block
 *      reads as a short "code block" aside rather than line-by-line noise).
 *   2. **It picks whatever default voice the OS hands back**, which is
 *      often a low-quality "compact" voice. {@link pickVoice} prefers the
 *      good local voices (Samantha/Allison/Ava on macOS, the natural
 *      Google/Microsoft voices elsewhere) and tunes rate/pitch so the
 *      cadence sounds natural rather than clipped.
 *
 * Everything degrades gracefully: no `speechSynthesis` → {@link speak} is a
 * no-op and {@link isSpeechSupported} is false, so callers can hide the
 * affordance.
 */

/** Voices we explicitly prefer, best-first. macOS natural voices lead;
 *  the Google/Microsoft entries cover Chromium/Windows hosts. Matched by
 *  prefix so "Samantha (Enhanced)" / "Microsoft Aria Online" still hit. */
const PREFERRED_VOICES: ReadonlyArray<string> = [
  'Samantha',
  'Allison',
  'Ava',
  'Serena',
  'Zoe',
  'Google US English',
  'Microsoft Aria',
  'Microsoft Jenny',
  'Daniel',
  'Karen',
  'Moira',
];

let cachedVoices: SpeechSynthesisVoice[] = [];

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null;
}

/** Voice lists load asynchronously on some platforms — warm and cache
 *  them on first access and whenever the engine signals a change. */
function refreshVoices(): SpeechSynthesisVoice[] {
  const s = synth();
  if (!s) return [];
  const v = s.getVoices();
  if (v.length > 0) cachedVoices = v;
  return cachedVoices;
}

// Prime the cache at module load; `voiceschanged` fires once the engine
// has them ready (Chromium returns [] synchronously on the first call).
{
  const s = synth();
  if (s) {
    refreshVoices();
    s.addEventListener?.('voiceschanged', () => refreshVoices());
  }
}

/** Pick the best available voice: a preferred name, else any local
 *  English voice, else any English voice, else the platform default. */
export function pickVoice(): SpeechSynthesisVoice | null {
  const all = cachedVoices.length > 0 ? cachedVoices : refreshVoices();
  if (all.length === 0) return null;
  for (const name of PREFERRED_VOICES) {
    const match = all.find((v) => v.name === name || v.name.startsWith(name));
    if (match) return match;
  }
  const enLocal = all.find((v) => v.lang?.startsWith('en') && v.localService);
  if (enLocal) return enLocal;
  return all.find((v) => v.lang?.startsWith('en')) ?? all[0] ?? null;
}

/**
 * Reduce markdown to clean, speakable prose. Removes structural syntax
 * (headings, bullets, blockquotes, tables, rules), keeps the text inside
 * links/emphasis, and collapses fenced code blocks to a single spoken
 * "(code block)" rather than reading source line-by-line.
 */
export function toSpeakableText(markdown: string): string {
  const stripped = markdown
    // Fenced code → a short spoken aside, not line-by-line source.
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/~~~[\s\S]*?~~~/g, ' (code block) ')
    // Images / links → their human-readable text (the URL is dropped, never
    // spoken). Bare URLs in prose are stripped too so the engine doesn't read
    // out "h-t-t-p-s-colon-slash-slash…".
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    // Inline code + emphasis → bare content. The `_italic_` rule requires
    // both underscores so snake_case identifiers survive.
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    // Line-leading structure: headings, blockquotes, list bullets.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    // Horizontal rules + table pipes.
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
    .replace(/\|/g, ' ');

  // Split on blank lines into paragraphs; soft-wrap newlines collapse to
  // spaces. Each paragraph gets terminal punctuation so the engine pauses
  // between them — without doubling a mark the prose already ends on.
  return stripped
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((p) => (/[.!?:]$/.test(p) ? p : `${p}.`))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface SpeakOptions {
  readonly onend?: () => void;
  readonly onerror?: () => void;
}

/**
 * Speak `markdown` aloud with the best available voice. Cancels any
 * in-flight utterance first (so re-clicking stops, and a new block never
 * overlaps the previous one). Cleans the text via {@link toSpeakableText}.
 */
export function speak(markdown: string, opts: SpeakOptions = {}): void {
  const s = synth();
  if (!s) {
    opts.onerror?.();
    return;
  }
  s.cancel();
  const utter = new SpeechSynthesisUtterance(toSpeakableText(markdown));
  const voice = pickVoice();
  if (voice) {
    utter.voice = voice;
    utter.lang = voice.lang;
  }
  utter.rate = 1.0;
  utter.pitch = 1.0;
  if (opts.onend) utter.onend = () => opts.onend?.();
  utter.onerror = () => opts.onerror?.();
  s.speak(utter);
}

/** Stop any in-flight speech. Safe to call when unsupported. */
export function cancelSpeech(): void {
  synth()?.cancel();
}

/** Whether this environment can speak at all (gates the affordance). */
export function isSpeechSupported(): boolean {
  return synth() !== null;
}
