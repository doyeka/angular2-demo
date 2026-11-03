import {
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type LLM,
  newToolCallId,
  parseHermesToolCalls,
} from './types.ts';

/**
 * Adapter for OpenAI-compatible chat endpoints. Primary target is llama.cpp's
 * `llama-server --jinja`, which applies the same chat template + grammar
 * machinery llama.rn uses on-device — so eval results transfer.
 */
export class OpenAICompatLLM implements LLM {
  readonly id: string;
  readonly contextTokens: number;
  private baseUrl: string;
  private apiKey?: string;
  private model: string;

  constructor(opts: { baseUrl: string; model?: string; apiKey?: string; contextTokens?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model ?? 'local';
    this.apiKey = opts.apiKey;
    this.contextTokens = opts.contextTokens ?? 8192;
    this.id = `openai-compat:${this.model}`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages.map(toOpenAI),
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.2,
      stop: req.stop,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.jsonSchema) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'out', strict: true, schema: req.jsonSchema } };
    }
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    let text: string = msg.content ?? '';
    let toolCalls = (msg.tool_calls ?? []).map((tc: any) => ({
      id: tc.id ?? newToolCallId(),
      name: tc.function?.name,
      arguments: safeParse(tc.function?.arguments),
    }));
    if (!toolCalls.length && text.includes('<tool_call>')) {
      const parsed = parseHermesToolCalls(text);
      text = parsed.content;
      toolCalls = parsed.toolCalls;
    }
    req.onToken?.(text);
    return {
      text,
      toolCalls,
      usage: { promptTokens: json.usage?.prompt_tokens, completionTokens: json.usage?.completion_tokens },
    };
  }
}

function toOpenAI(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return (s as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
