import type { ChatMessage, LLM, ToolCall } from '../llm/types.ts';
import type { McpHub } from '../mcp/hub.ts';

export type AgentEvent =
  | { type: 'route'; route: string; args?: unknown }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; callId: string; name: string; isError: boolean; preview: string }
  | { type: 'progress'; stage: string; done: number; total: number; note?: string }
  | { type: 'artifact'; title: string; variant: string; path: string }
  | { type: 'final'; text: string };

export interface ReactOptions {
  maxSteps?: number;
  maxToolResultChars?: number;
  signal?: AbortSignal;
  emit?: (e: AgentEvent) => void;
}

/** chars/token heuristic — good enough for budgeting without a tokenizer round-trip. */
export const approxTokens = (s: string) => Math.ceil(s.length / 3.5);

/**
 * Keep the prompt within budget: shrink old tool results first, then drop the
 * oldest turns (never the system prompt or the latest user turn).
 */
export function compact(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const size = (ms: ChatMessage[]) => ms.reduce((n, m) => n + approxTokens(m.content) + 8, 0);
  const out = messages.map((m) => ({ ...m }));
  for (let i = 1; i < out.length - 2 && size(out) > budgetTokens; i++) {
    if (out[i].role === 'tool' && out[i].content.length > 400) out[i].content = out[i].content.slice(0, 400) + ' …[truncated]';
  }
  while (size(out) > budgetTokens && out.length > 3) {
    // drop the oldest non-system message, keeping assistant(tool_calls)/tool pairs together
    let j = 1;
    out.splice(j, 1);
    while (out[j]?.role === 'tool') out.splice(j, 1);
  }
  return out;
}

/** Classic ReAct over MCP tools using the model's native tool-call format. */
export async function runReact(llm: LLM, hub: McpHub, messages: ChatMessage[], opts: ReactOptions = {}): Promise<{ text: string; messages: ChatMessage[] }> {
  const maxSteps = opts.maxSteps ?? 8;
  const tools = hub.toolSpecs();
  const budget = Math.floor(llm.contextTokens * 0.7);
  let convo = [...messages];
  for (let step = 0; step < maxSteps; step++) {
    convo = compact(convo, budget);
    const res = await llm.complete({
      messages: convo,
      tools,
      maxTokens: 768,
      temperature: 0.3,
      signal: opts.signal,
      onToken: (t) => opts.emit?.({ type: 'token', text: t }),
    });
    if (!res.toolCalls.length) {
      convo.push({ role: 'assistant', content: res.text });
      opts.emit?.({ type: 'final', text: res.text });
      return { text: res.text, messages: convo };
    }
    convo.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      opts.emit?.({ type: 'tool_call', call });
      const out = await hub.call(call.name, call.arguments, opts.signal);
      const text = out.text.length > (opts.maxToolResultChars ?? 3000) ? out.text.slice(0, opts.maxToolResultChars ?? 3000) + ' …[truncated]' : out.text;
      opts.emit?.({ type: 'tool_result', callId: call.id, name: call.name, isError: out.isError, preview: text.slice(0, 200) });
      convo.push({ role: 'tool', content: text, toolCallId: call.id, name: call.name });
    }
  }
  const text = 'I hit my step limit before finishing. Here is what I have so far — try narrowing the request.';
  convo.push({ role: 'assistant', content: text });
  opts.emit?.({ type: 'final', text });
  return { text, messages: convo };
}
