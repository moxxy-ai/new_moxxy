/**
 * Small helpers that provider plugins share. Lives in the SDK because plugins
 * are only allowed to depend on @moxxy/sdk, not core.
 */

import { classifyNetworkError } from './errors.js';

/** Canonical stop reasons emitted on `message_end` events. */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';

/**
 * Heuristic: should a provider request retry on this error? Used by stream
 * modes to attach a `retryable: boolean` flag to the `error` event so callers
 * (or the loop strategy) can decide whether to back off and try again.
 *
 * Identical implementation across plugin-provider-anthropic and -openai;
 * hoisted here so a new provider plugin can stay consistent.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // MoxxyError-classified ones carry the verdict in the code.
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (code === 'PROVIDER_RATE_LIMITED' || code === 'PROVIDER_SERVER_ERROR') return true;
    if (code === 'NETWORK_TIMEOUT' || code === 'NETWORK_UNREACHABLE') return true;
  }
  const msg = err.message.toLowerCase();
  if (msg.includes('rate_limit') || msg.includes('429') || msg.includes('overloaded')) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('network')) return true;
  return false;
}

/**
 * Build a friendly error event for `ProviderEvent` streams. Tries to classify
 * the cause as a network failure (turning Node's "fetch failed" into something
 * actionable) before falling back to the raw message. Providers' catch blocks
 * yield the result via:
 *   yield { type: 'error', ...toFriendlyError(err, { provider: this.name }) };
 */
export function toFriendlyError(
  err: unknown,
  ctx: { readonly url?: string; readonly provider?: string } = {},
): { message: string; retryable: boolean } {
  const classified = classifyNetworkError(err, ctx);
  if (classified) {
    return {
      message: classified.message + (classified.hint ? ` — ${classified.hint}` : ''),
      retryable: isRetryableError(classified),
    };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    retryable: isRetryableError(err),
  };
}

/**
 * Best-effort zod → JSON-schema conversion for provider tool definitions.
 * Most callers want the basic object/string/number/boolean/array coverage;
 * for richer schemas, plugins can layer `zod-to-json-schema`.
 *
 * The `as unknown as { ... }` casts below probe zod's `_def` internals
 * (`shape`, `type`) which aren't part of zod's public typed surface but are
 * stable enough across versions to rely on for this best-effort path.
 */
export function zodToJsonSchema(schema: unknown): unknown {
  const s = schema as { _def?: { typeName?: string }; toJSON?: () => unknown };
  // Only honor a pre-serialized schema's `toJSON` for NON-zod objects (a plain
  // JSON-schema object passed through). A real zod schema (has `_def`) MUST go
  // through the unwrap below — short-circuiting on a zod `toJSON` (some versions
  // add one) skips the ZodEffects/intersection handling and yields a
  // properties-less object schema that providers like Codex reject.
  if (!s._def && typeof s.toJSON === 'function') return s.toJSON();
  const def = s._def;
  const typeName = def?.typeName;

  // ZodEffects (`.refine`, `.transform`, `.superRefine`) is a wrapper —
  // the inner `schema` field holds the real type. Skipping the unwrap
  // leaves us with a properties-less object schema, which providers like
  // Codex's /responses validator reject ("object schema missing properties").
  if (typeName === 'ZodEffects') {
    const inner = (def as unknown as { schema: unknown }).schema;
    return zodToJsonSchema(inner);
  }
  // ZodOptional / ZodNullable / ZodDefault / ZodBranded / ZodReadonly all
  // wrap an inner schema we want to unwrap for JSON-schema purposes.
  if (
    typeName === 'ZodOptional' ||
    typeName === 'ZodNullable' ||
    typeName === 'ZodDefault' ||
    typeName === 'ZodBranded' ||
    typeName === 'ZodReadonly'
  ) {
    const inner = (def as unknown as { innerType: unknown }).innerType;
    return zodToJsonSchema(inner);
  }
  // `.and(other)` produces a ZodIntersection. The standard JSON-schema
  // representation is `allOf`, but strict validators (Codex again) want
  // each branch to be a complete object schema. Easiest path that satisfies
  // them: when both branches reduce to object schemas, merge properties
  // and required lists into one object. Fall back to `allOf` otherwise.
  if (typeName === 'ZodIntersection') {
    const intersection = def as unknown as { left: unknown; right: unknown };
    const left = zodToJsonSchema(intersection.left) as Record<string, unknown>;
    const right = zodToJsonSchema(intersection.right) as Record<string, unknown>;
    if (
      left &&
      right &&
      left.type === 'object' &&
      right.type === 'object' &&
      left.properties &&
      right.properties
    ) {
      return {
        type: 'object',
        properties: { ...(left.properties as object), ...(right.properties as object) },
        required: Array.from(
          new Set([
            ...((left.required as ReadonlyArray<string>) ?? []),
            ...((right.required as ReadonlyArray<string>) ?? []),
          ]),
        ),
      };
    }
    return { allOf: [left, right] };
  }
  if (typeName === 'ZodObject') {
    // zod's ZodObject._def has a `shape()` thunk returning the field map.
    const shape = (def as unknown as { shape: () => Record<string, unknown> }).shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      const isOptional = (value as { isOptional?: () => boolean }).isOptional?.();
      if (!isOptional) required.push(key);
    }
    return { type: 'object', properties, required };
  }
  if (typeName === 'ZodString') return { type: 'string' };
  if (typeName === 'ZodNumber') return { type: 'number' };
  if (typeName === 'ZodBoolean') return { type: 'boolean' };
  if (typeName === 'ZodEnum') {
    const values = (def as unknown as { values: ReadonlyArray<string> }).values;
    return { type: 'string', enum: [...values] };
  }
  if (typeName === 'ZodNativeEnum') {
    const values = Object.values(
      (def as unknown as { values: Record<string, string | number> }).values,
    );
    const allString = values.every((v) => typeof v === 'string');
    return { type: allString ? 'string' : 'number', enum: values };
  }
  if (typeName === 'ZodLiteral') {
    const value = (def as unknown as { value: string | number | boolean | null }).value;
    const t = value === null ? 'null' : typeof value;
    return { type: t, enum: [value] };
  }
  if (typeName === 'ZodUnion' || typeName === 'ZodDiscriminatedUnion') {
    const options = (def as unknown as { options: ReadonlyArray<unknown> }).options;
    return { anyOf: options.map((o) => zodToJsonSchema(o)) };
  }
  if (typeName === 'ZodArray') {
    // ZodArray._def.type is the element schema.
    const items = zodToJsonSchema((def as unknown as { type: unknown }).type);
    return { type: 'array', items };
  }
  // Truly unknown — fall back to a permissive "any object" but spell out
  // `properties: {}` and `additionalProperties: true` so strict validators
  // accept the schema instead of bailing on a missing `properties` field.
  return { type: 'object', properties: {}, additionalProperties: true };
}
