import type { ToolDef, ToolRegistry } from '@moxxy/sdk';
import type { ToolRegistry as CoreToolRegistry } from '../registries/tools.js';

export function buildFilteredToolRegistry(
  parent: CoreToolRegistry,
  allowed: Set<string>,
): ToolRegistry {
  return {
    list: (): ReadonlyArray<ToolDef> => parent.list().filter((t) => allowed.has(t.name)),
    get: (name: string): ToolDef | undefined =>
      allowed.has(name) ? parent.get(name) : undefined,
    execute: (name, input, signal, opts) => {
      if (!allowed.has(name)) {
        return Promise.reject(new Error(`Tool ${name} not allowed in this subagent`));
      }
      return parent.execute(name, input, signal, opts);
    },
  };
}
