/**
 * Parse the planner's output into individual step strings. Accepts
 * `PLAN:` / `PLAN` (optional colon) followed by numbered (`1.`, `2)`),
 * dashed, or bulleted lines. Returns the part after the marker, so
 * `1. Foo` yields `"Foo"`.
 */
export function parsePlan(text: string): string[] {
  const lines = text.split('\n');
  const steps: string[] = [];
  let inPlan = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^plan\s*:?$/i.test(line)) {
      inPlan = true;
      continue;
    }
    const m = /^(?:\d+[.)]|[-*•])\s*(.+)$/.exec(line);
    if (m) {
      steps.push(m[1]!.trim());
      inPlan = true;
    } else if (inPlan && steps.length > 0 && !/^[A-Z]/.test(line)) {
      // continuation indented under previous step — skip
    }
  }
  return steps;
}
