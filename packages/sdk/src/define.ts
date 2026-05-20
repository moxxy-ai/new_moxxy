import type { ChannelDef } from './channel.js';
import type { CompactorDef } from './compactor.js';
import type { LoopStrategyDef } from './loop.js';
import type { PermissionRule } from './permission.js';
import type { Plugin, PluginSpec } from './plugin.js';
import type { ProviderDef } from './provider.js';
import type { SkillDef, SkillFrontmatter } from './skill.js';
import type { ToolCompactPresentation, ToolContext, ToolDef } from './tool.js';
import type { ToolIsolationSpec } from './isolation.js';
import type { TranscriberDef } from './transcriber.js';
import type { z } from 'zod';

export function definePlugin(spec: PluginSpec): Plugin {
  // Spread spec first so the defaults below can't be clobbered by an
  // explicit `version: undefined` in the spec (which violates Plugin.version
  // typed as `string`).
  return Object.freeze({
    ...spec,
    __moxxy: 'plugin' as const,
    version: spec.version ?? '0.0.0',
  });
}

/**
 * `defineTool` carries an extra generic `<S, O>` so the `handler`'s `input`
 * parameter is typed as `z.output<S>` rather than `unknown` — that's the
 * authoring-ergonomics benefit. The returned `ToolDef` widens the handler
 * to the runtime contract `(unknown, ToolContext) => unknown` because the
 * registry parses input via `inputSchema` before calling.
 */
export function defineTool<S extends z.ZodTypeAny, O = unknown>(spec: {
  name: string;
  description: string;
  inputSchema: S;
  inputJsonSchema?: unknown;
  outputSchema?: z.ZodType<O>;
  permission?: PermissionRule;
  handler: (input: z.output<S>, ctx: ToolContext) => Promise<O> | O;
  compact?: ToolCompactPresentation;
  isolation?: ToolIsolationSpec;
}): ToolDef {
  return Object.freeze({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    inputJsonSchema: spec.inputJsonSchema,
    outputSchema: spec.outputSchema,
    permission: spec.permission,
    handler: spec.handler as (input: unknown, ctx: ToolContext) => Promise<unknown> | unknown,
    compact: spec.compact,
    isolation: spec.isolation,
  });
}

// Every other `defineX` follows the same `(spec: XDef): XDef` shape: it
// freezes the spec and hands it back. The compile-time win is a clean
// "this is how you author one" signature; the runtime win is
// Object.freeze so plugin authors can't mutate published defs.

export function defineProvider(spec: ProviderDef): ProviderDef {
  return Object.freeze(spec);
}

export function defineLoopStrategy(spec: LoopStrategyDef): LoopStrategyDef {
  return Object.freeze(spec);
}

export function defineCompactor(spec: CompactorDef): CompactorDef {
  return Object.freeze(spec);
}

export function defineChannel<TStartOpts = unknown>(
  spec: ChannelDef<TStartOpts>,
): ChannelDef<TStartOpts> {
  return Object.freeze(spec);
}

export function definePermission(spec: PermissionRule): PermissionRule {
  return Object.freeze(spec);
}

export function defineSkill(spec: { frontmatter: SkillFrontmatter; body: string }): SkillDef {
  return Object.freeze(spec);
}

export function defineTranscriber(spec: TranscriberDef): TranscriberDef {
  return Object.freeze(spec);
}
