/**
 * Runtime-agnostic LLM contract.
 *
 * Adapters:
 *  - native/llamaRnLLM.ts   (on-device, llama.rn / llama.cpp)
 *  - core/llm/openaiCompat.ts (llama-server or any OpenAI-compatible endpoint; used by the eval harness)
 *  - core/llm/scripted.ts   (deterministic stand-in for tests)
 *
 * The agent never formats prompts itself: adapters apply the model's own chat
 * template (jinja) so tool-calling uses the format the model was trained on.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. */
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  /** For role === 'tool'. */
  toolCallId?: string;
  name?: string;
}

/** JSON Schema subset — passed straight to llama.cpp's json-schema-to-grammar. */
export type JSONSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Constrain the output to this schema (grammar-constrained decoding). Mutually exclusive with tools. */
  jsonSchema?: JSONSchema;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number; tokensPerSecond?: number };
}

export interface LLM {
  readonly id: string;
  /** Context window the adapter was loaded with; used for budgeting. */
  readonly contextTokens: number;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Convenience: constrained JSON completion with parse + one repair retry. */
export async function completeJSON<T>(
  llm: LLM,
  messages: ChatMessage[],
  schema: JSONSchema,
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm.complete({
      messages,
      jsonSchema: schema,
      maxTokens: opts.maxTokens ?? 512,
      temperature: 0,
      signal: opts.signal,
    });
    try {
      return JSON.parse(extractJSON(res.text)) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`LLM returned invalid JSON: ${String(lastErr)}`);
}

/** Tolerate code fences / leading prose from adapters that don't grammar-constrain. */
export function extractJSON(text: string): string {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return t;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

let callCounter = 0;
export function newToolCallId(): string {
  callCounter += 1;
  return `call_${Date.now().toString(36)}_${callCounter}`;
}

/**
 * Fallback parser for Hermes/Qwen-style `<tool_call>{...}</tool_call>` blocks,
 * for runtimes that return raw text instead of parsed tool calls.
 */
export function parseHermesToolCalls(text: string): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj.name === 'string') {
        const args = typeof obj.arguments === 'string' ? JSON.parse(obj.arguments) : obj.arguments ?? {};
        toolCalls.push({ id: newToolCallId(), name: obj.name, arguments: args });
      }
    } catch {
      /* ignore malformed block; the loop will surface "no tool call" to the model */
    }
  }
  return { content: text.replace(re, '').trim(), toolCalls };
}
