import type { CompletionRequest, CompletionResult, LLM } from './types.ts';

export type ScriptHandler = (req: CompletionRequest, callIndex: number) => CompletionResult | string;

/**
 * Deterministic LLM for tests and the eval harness's `oracle` mode.
 * The handler sees the full request (messages, tools, schema) and returns a result.
 */
export class ScriptedLLM implements LLM {
  readonly id: string;
  readonly contextTokens = 32768;
  calls: CompletionRequest[] = [];

  private handler: ScriptHandler;

  constructor(handler: ScriptHandler, id = 'scripted') {
    this.handler = handler;
    this.id = id;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    const out = this.handler(req, this.calls.length - 1);
    const res = typeof out === 'string' ? { text: out, toolCalls: [] } : out;
    req.onToken?.(res.text);
    return res;
  }
}
