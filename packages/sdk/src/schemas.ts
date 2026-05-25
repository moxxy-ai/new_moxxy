import { z } from 'zod';
import { PLUGIN_KINDS } from './plugin-kind.js';

const pluginKindSchema = z.enum(PLUGIN_KINDS);

export const requirementSchema = z.object({
  kind: z.enum([
    'plugin',
    'provider',
    'tool',
    'transcriber',
    'mode',
    'compactor',
    'channel',
    'agent',
    'command',
    'runtime',
  ]),
  name: z.string().min(1),
  state: z.enum(['registered', 'active', 'ready']).optional(),
  version: z.string().min(1).optional(),
  optional: z.boolean().optional(),
  reason: z.string().min(1).optional(),
  hint: z.string().min(1).optional(),
});

/**
 * Optional schedule block on a skill. When present, the scheduler
 * plugin (if installed) automatically registers a recurring or one-shot
 * trigger that runs the skill body as a prompt. Either `cron` or
 * `runAt` must be set; supplying both is rejected by the scheduler.
 */
export const skillScheduleSchema = z
  .object({
    cron: z.string().min(1).optional(),
    runAt: z
      .union([z.number().int(), z.string().min(1)])
      .optional(),
    timeZone: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => !!v.cron || v.runAt !== undefined, {
    message: 'schedule needs either `cron` or `runAt`',
  });

export const skillFrontmatterSchema = z.object({
  name: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be slug-like'),
  description: z.string().min(1).max(240),
  triggers: z.array(z.string().min(1)).optional(),
  'allowed-tools': z.array(z.string().min(1)).optional(),
  version: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  /** Opt the skill into automatic recurring/one-shot execution. */
  schedule: skillScheduleSchema.optional(),
});

export const pluginManifestSchema = z.object({
  entry: z.string().min(1),
  kind: z
    .union([pluginKindSchema, z.array(pluginKindSchema)])
    .optional(),
  port: z.number().int().min(1).max(65535).optional(),
  skills: z.string().optional(),
});

/**
 * Shape of a package's `moxxy` field in package.json.
 *
 * - `plugin` — the per-package plugin manifest (`entry`, `kind`, `skills`).
 *   When omitted the package is not treated as a moxxy plugin.
 * - `requirements` — declarative prerequisites that gate plugin
 *   registration and drive load-order toposort. This is the SINGLE place
 *   requirements may be authored; per-tool/per-transcriber/per-anything
 *   runtime declarations were removed in favor of static analysis.
 */
export const moxxyPackageSchema = z.object({
  plugin: pluginManifestSchema.optional(),
  requirements: z.array(requirementSchema).optional(),
});

export type SkillFrontmatterInput = z.infer<typeof skillFrontmatterSchema>;
export type PluginManifestInput = z.infer<typeof pluginManifestSchema>;
export type MoxxyPackageInput = z.infer<typeof moxxyPackageSchema>;
