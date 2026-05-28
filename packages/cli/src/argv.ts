export interface ParsedArgv {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgv(argv: ReadonlyArray<string>): ParsedArgv {
  const result: ParsedArgv = { command: '', flags: {}, positional: [] };
  if (argv.length === 0) {
    result.command = 'tui';
    return result;
  }
  let i = 0;
  const first = argv[0]!;
  const looksLikeCommand = !first.startsWith('-');
  if (looksLikeCommand) {
    result.command = first;
    i = 1;
  }

  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        result.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          result.flags[key] = next;
          i++;
        } else {
          result.flags[key] = true;
        }
      }
    } else if (a.startsWith('-')) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        result.flags[key] = next;
        i++;
      } else {
        result.flags[key] = true;
      }
    } else {
      result.positional.push(a);
    }
  }

  if (!result.command) {
    if ('p' in result.flags || 'prompt' in result.flags) result.command = 'prompt';
    else if ('help' in result.flags || 'h' in result.flags) result.command = 'help';
    else if ('version' in result.flags || 'v' in result.flags) result.command = 'version';
    else result.command = 'tui';
  }
  return result;
}
