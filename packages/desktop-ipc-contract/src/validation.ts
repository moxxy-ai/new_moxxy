/**
 * Runtime validation for the IPC boundary. Compile-time types don't
 * protect the main process from a compromised/XSS'd renderer, so the
 * security-sensitive handlers (anything that touches the filesystem, a
 * child process, the vault, or `shell.openExternal`) get a Zod schema
 * checked before the handler body runs.
 *
 * Only the dangerous commands are listed — no-arg or
 * already-defended-in-depth commands are intentionally absent.
 */

import { z } from 'zod';
import type { IpcCommandName } from './index.js';

/** Mirror of the main-process provider-name guard: a strict slug so a
 *  provider name can't inject a CLI flag or traverse the vault keyspace. */
const providerName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'invalid provider name');

const httpUrl = z
  .string()
  .refine((s) => {
    try {
      const p = new URL(s).protocol;
      return p === 'http:' || p === 'https:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

/** Skill names map to files under ~/.moxxy/skills — forbid traversal and
 *  absolute paths, allow nested folders. */
const skillName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, 'invalid skill name')
  .refine((s) => !s.includes('..'), 'skill name may not contain ".."');

/** Vault key — letters/digits then letters/digits/dot/underscore/slash/hyphen
 *  (slashes allow namespaced keys like `oauth/openai-codex/refresh_token`),
 *  no `..` traversal. */
const vaultKeyName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid vault key name')
  .refine((s) => !s.includes('..'), 'vault key name may not contain ".."');

const optionalWorkspace = z.string().min(1).max(256).optional();
/** ~30 MB of base64 — generous for a voice clip, bounded so a renderer
 *  can't OOM the main process with one transcribe call. */
const MAX_AUDIO_BASE64 = 40_000_000;

export const ipcInputSchemas: Partial<Record<IpcCommandName, z.ZodTypeAny>> = {
  // No-arg, but spawns a child process (npm install) — pin the payload to
  // "nothing" so a hostile renderer can't smuggle args across.
  'app.cliInfo': z.undefined(),
  'app.updateCli': z.undefined(),
  'onboarding.openExternal': z.object({ url: httpUrl }),
  'onboarding.saveProviderKey': z.object({
    provider: providerName,
    secret: z.string().min(1).max(8192),
  }),
  'onboarding.providerAuthKind': z.object({ provider: providerName }),
  'onboarding.runProviderLogin': z.object({ provider: providerName }),
  'session.transcribe': z.object({
    audioBase64: z.string().max(MAX_AUDIO_BASE64),
    mimeType: z.string().max(128).optional(),
  }),
  'session.setProvider': z.object({ workspaceId: optionalWorkspace, provider: providerName }),
  'session.setMode': z.object({ workspaceId: optionalWorkspace, mode: z.string().min(1).max(64) }),
  'workspace.listDir': z.object({
    workspaceId: z.string().min(1).max(256),
    path: z.string().max(4096).optional(),
  }),
  'settings.fetchProviderModels': z.object({ provider: providerName }),
  'settings.writeSkill': z.object({ name: skillName, body: z.string().max(1_000_000) }),
  'settings.readSkill': z.object({ name: skillName }),
  'settings.deleteSkill': z.object({ name: skillName }),
  'desks.create': z.object({ name: z.string().min(1).max(200), cwd: z.string().min(1).max(4096) }),
  // Whitelist the fields a renderer may write — `version` is managed by
  // the main process; unknown keys are rejected (.strict()).
  'prefs.update': z
    .object({
      onboardingComplete: z.boolean().optional(),
      clerkUserId: z.string().max(256).nullable().optional(),
      clerkDisplayName: z.string().max(256).nullable().optional(),
      signedInAt: z.number().nullable().optional(),
    })
    .strict(),
  'chat.append': z.object({
    workspaceId: z.string().min(1).max(256),
    events: z.array(z.unknown()).max(10_000),
  }),
  'chat.loadSegment': z.object({
    workspaceId: z.string().min(1).max(256),
    before: z.number().int().nonnegative().nullable(),
    limit: z.number().int().positive().max(1000),
  }),
  'chat.clearLog': z.object({ workspaceId: z.string().min(1).max(256) }),
  // Vault writes are security-sensitive: lock the key name to a safe slug
  // (letters/digits + . _ / - , no traversal) and bound the secret size.
  'settings.vaultSet': z.object({
    name: vaultKeyName,
    value: z.string().min(1).max(32_768),
  }),
  'settings.vaultDelete': z.object({ name: vaultKeyName }),
  // Permission/approval reply — security-sensitive (it decides a tool call),
  // so the shape is locked down: a known requestId + a strict response.
  'ask.respond': z
    .object({
      requestId: z.string().min(1).max(128),
      response: z
        .object({
          mode: z.enum(['allow', 'allow_session', 'allow_always', 'deny']).optional(),
          optionId: z.string().max(128).optional(),
          text: z.string().max(10_000).optional(),
        })
        .strict(),
    })
    .strict(),
};

/**
 * Validate a command's first argument against its schema (if any).
 * Throws on mismatch so the handler never runs with hostile input.
 */
export function validateIpcInput(command: IpcCommandName, arg: unknown): void {
  const schema = ipcInputSchemas[command];
  if (!schema) return;
  const result = schema.safeParse(arg);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '·'}: ${i.message}`).join('; ');
    throw new Error(`invalid IPC payload for "${command}": ${detail}`);
  }
}
