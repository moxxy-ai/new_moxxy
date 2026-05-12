/**
 * Small helpers that provider plugins share. Lives in the SDK because plugins
 * are only allowed to depend on @moxxy/sdk, not core.
 */

/** Canonical stop reasons emitted on `message_end` events. */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';

/**
 * Heuristic: should a provider request retry on this error? Used by stream
 * loops to attach a `retryable: boolean` flag to the `error` event so callers
 * (or the loop strategy) can decide whether to back off and try again.
 *
 * Identical implementation across plugin-provider-anthropic and -openai;
 * hoisted here so a new provider plugin can stay consistent.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (msg.includes('rate_limit') || msg.includes('429') || msg.includes('overloaded')) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('network')) return true;
  return false;
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
  if (typeof s.toJSON === 'function') return s.toJSON();
  const def = s._def;
  const typeName = def?.typeName;
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
  if (typeName === 'ZodArray') {
    // ZodArray._def.type is the element schema.
    const items = zodToJsonSchema((def as unknown as { type: unknown }).type);
    return { type: 'array', items };
  }
  return { type: 'object' };
}
