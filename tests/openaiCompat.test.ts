import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAICompatLLM } from '../src/core/llm/openaiCompat.ts';

let bodies: any[] = [];
let reply: any = {};
const server = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    bodies.push(JSON.parse(b));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply));
  });
});
let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('OpenAI-compatible adapter (llama-server)', () => {
  it('sends json_schema response_format and parses content', async () => {
    bodies = [];
    reply = { choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
    const llm = new OpenAICompatLLM({ baseUrl: url });
    const r = await llm.complete({ messages: [{ role: 'user', content: 'x' }], jsonSchema: { type: 'object' } });
    expect(r.text).toBe('{"a":1}');
    expect(bodies[0].response_format).toMatchObject({ type: 'json_schema', json_schema: { schema: { type: 'object' } } });
  });
  it('round-trips native tool calls and tool messages', async () => {
    bodies = [];
    reply = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mail__search', arguments: '{"text":"offer"}' } }] } }] };
    const llm = new OpenAICompatLLM({ baseUrl: url });
    const r = await llm.complete({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'mail__stats', arguments: {} }] },
        { role: 'tool', content: '{}', toolCallId: 'c0', name: 'mail__stats' },
      ],
      tools: [{ name: 'mail__search', description: 'd', parameters: { type: 'object' } }],
    });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'mail__search', arguments: { text: 'offer' } }]);
    expect(bodies[0].tools[0].function.name).toBe('mail__search');
    expect(bodies[0].messages[1].tool_calls[0].function.arguments).toBe('{}');
    expect(bodies[0].messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c0' });
  });
  it('falls back to parsing <tool_call> text', async () => {
    reply = { choices: [{ message: { content: '<tool_call>{"name":"memory__save","arguments":{"content":"likes remote"}}</tool_call>' } }] };
    const r = await new OpenAICompatLLM({ baseUrl: url }).complete({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(r.toolCalls[0]).toMatchObject({ name: 'memory__save', arguments: { content: 'likes remote' } });
  });
});
