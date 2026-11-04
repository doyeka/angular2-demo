import { initLlama, type LlamaContext } from 'llama.rn';
import {
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type LLM,
  newToolCallId,
  parseHermesToolCalls,
} from '../core/llm/types';

/**
 * On-device inference via llama.rn (llama.cpp). Uses the GGUF's embedded jinja
 * chat template so tool calls use the model's native format, and llama.cpp's
 * json-schema→GBNF for constrained output.
 */
export class LlamaRnLLM implements LLM {
  readonly id: string;
  readonly contextTokens: number;
  private ctx: LlamaContext;
  /** llama.rn contexts run one completion at a time — serialize. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(ctx: LlamaContext, id: string, nCtx: number) {
    this.ctx = ctx;
    this.id = id;
    this.contextTokens = nCtx;
  }

  static async load(modelPath: string, opts: { id: string; nCtx: number; onProgress?: (p: number) => void }): Promise<LlamaRnLLM> {
    const ctx = await initLlama(
      {
        model: modelPath,
        n_ctx: opts.nCtx,
        n_batch: 512,
        n_gpu_layers: 99, // Metal on iOS; OpenCL/Vulkan where supported on Android, CPU fallback otherwise
        flash_attn_type: 'auto',
        cache_type_k: 'q8_0',
        cache_type_v: 'q8_0',
        use_mlock: false,
      },
      opts.onProgress,
    );
    return new LlamaRnLLM(ctx, opts.id, opts.nCtx);
  }

  complete(req: CompletionRequest): Promise<CompletionResult> {
    const run = () => this.run(req);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private async run(req: CompletionRequest): Promise<CompletionResult> {
    const onAbort = () => void this.ctx.stopCompletion();
    req.signal?.addEventListener('abort', onAbort);
    try {
      const res = await this.ctx.completion(
        {
          messages: req.messages.map(toOAI) as any,
          jinja: true,
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
                tool_choice: 'auto',
              }
            : {}),
          ...(req.jsonSchema ? { response_format: { type: 'json_schema', json_schema: { strict: true, schema: req.jsonSchema } } } : {}),
          n_predict: req.maxTokens ?? 768,
          temperature: req.temperature ?? 0.3,
          stop: req.stop,
        },
        (data) => req.onToken?.(data.token),
      );
      if (req.signal?.aborted) throw new Error('aborted');
      let text = res.content || res.text || '';
      let toolCalls = (res.tool_calls ?? []).map((tc) => ({
        id: tc.id ?? newToolCallId(),
        name: tc.function.name,
        arguments: safeParse(tc.function.arguments),
      }));
      if (!toolCalls.length && text.includes('<tool_call>')) ({ content: text, toolCalls } = parseHermesToolCalls(text));
      return {
        text,
        toolCalls,
        usage: { completionTokens: res.tokens_predicted, tokensPerSecond: res.timings?.predicted_per_second },
      };
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  release(): Promise<void> {
    return this.ctx.release();
  }
}

function toOAI(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })),
    };
  }
  return { role: m.role, content: m.content };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
