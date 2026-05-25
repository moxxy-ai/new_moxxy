/**
 * Parse the planning-phase output into individual story strings. Same
 * tolerance as plan-execute's parser: accepts `STORIES:` / `STORIES`
 * (optional colon) followed by numbered (`1.`, `2)`), dashed, or bulleted
 * lines. Returns the part after the marker character so `1. Foo — bar`
 * yields `"Foo — bar"`.
 */
export function parseStories(text: string): string[] {
  const lines = text.split('\n');
  const stories: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^stories\s*:?$/i.test(line)) {
      inBlock = true;
      continue;
    }
    const m = /^(?:\d+[.)]|[-*•])\s*(.+)$/.exec(line);
    if (m) {
      stories.push(m[1]!.trim());
      inBlock = true;
    } else if (inBlock && stories.length > 0 && !/^[A-Z]/.test(line)) {
      // continuation indented under previous story — skip
    }
  }
  return stories;
}
