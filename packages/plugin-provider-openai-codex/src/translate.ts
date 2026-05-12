import { zodToJsonSchema, type ProviderMessage, type ProviderRequest, type ToolDef } from '@moxxy/sdk';

/**
 * Responses-API "input" item shape. We only emit the subset codex uses:
 * - `message` items with role + a string-or-rich content
 * - `function_call` items (assistant tool invocations replayed back)
 * - `function_call_output` items (tool results)
 */
type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: ReadonlyArray<ResponsesContent> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

type ResponsesContent =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string };

interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: unknown;
  strict?: boolean;
}

export interface ResponsesBody {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesTool[];
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: 'low' | 'medium' | 'high'; summary?: 'auto' | 'detailed' };
  store?: boolean;
  stream: true;
  prompt_cache_key?: string;
  include?: string[];
}

function contentBlocksToInputText(
  role: 'user' | 'assistant',
  blocks: ProviderMessage['content'],
): ResponsesContent[] {
  const out: ResponsesContent[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      out.push(role === 'assistant' ? { type: 'output_text', text: block.text } : { type: 'input_text', text: block.text });
    } else if (block.type === 'image') {
      out.push({ type: 'input_image', image_url: `data:${block.mediaType};base64,${block.data}` });
    }
  }
  return out;
}

/**
 * Extract any system-role text from a message array. Used to hoist the
 * system prompt into the top-level `instructions` field — the Responses
 * API rejects requests with a missing/empty `instructions`, and our
 * upstream loop helpers push the system prompt in as a `role: 'system'`
 * message rather than via `ProviderRequest.system`.
 */
export function extractSystemText(
  messages: ReadonlyArray<ProviderMessage>,
  explicitSystem?: string,
): string {
  const parts: string[] = [];
  if (explicitSystem && explicitSystem.trim()) parts.push(explicitSystem);
  for (const msg of messages) {
    if (msg.role !== 'system') continue;
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

export function toResponsesInput(messages: ReadonlyArray<ProviderMessage>): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      // System prompt is hoisted to top-level `instructions` by
      // `toResponsesBody`; don't duplicate it as an input message too.
      continue;
    }
    if (msg.role === 'user') {
      const content = contentBlocksToInputText('user', msg.content);
      if (content.length > 0) out.push({ type: 'message', role: 'user', content });
      continue;
    }
    if (msg.role === 'assistant') {
      const text = msg.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (text) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          out.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
        }
      }
      continue;
    }
    if (msg.role === 'tool_result') {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          out.push({
            type: 'function_call_output',
            call_id: block.toolUseId,
            output: block.content,
          });
        }
      }
    }
  }
  return out;
}

export function toResponsesTools(tools: ReadonlyArray<ToolDef>): ResponsesTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: (t.inputJsonSchema ?? zodToJsonSchema(t.inputSchema)) as unknown,
  }));
}

export interface BuildBodyOptions {
  readonly sessionHint?: string;
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * Default `instructions` value used when the caller supplies neither
 * `req.system` nor a system-role message. The Codex backend rejects
 * requests with an empty `instructions` field (`400: Instructions are
 * required`), so we always send something — falling back to a minimal
 * agent identity matches what codex-rs does for plain `codex exec` runs.
 */
const DEFAULT_INSTRUCTIONS = 'You are a helpful coding assistant.';

export function toResponsesBody(req: ProviderRequest, opts: BuildBodyOptions = {}): ResponsesBody {
  const instructions = extractSystemText(req.messages, req.system) || DEFAULT_INSTRUCTIONS;
  const body: ResponsesBody = {
    model: req.model,
    instructions,
    input: toResponsesInput(req.messages),
    stream: true,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: opts.reasoningEffort ?? 'medium', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
  };
  if (req.tools && req.tools.length > 0) body.tools = toResponsesTools(req.tools);
  if (opts.sessionHint) body.prompt_cache_key = opts.sessionHint;
  return body;
}
