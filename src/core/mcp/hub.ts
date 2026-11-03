import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolSpec } from '../llm/types.ts';

export interface HubTool {
  /** `${server}__${tool}` — what the LLM sees. */
  qualifiedName: string;
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    /** True when the tool reaches beyond the device (network). Drives the approval gate. */
    openWorldHint?: boolean;
    title?: string;
  };
}

export interface ToolCallOutcome {
  isError: boolean;
  text: string;
  structured?: unknown;
}

export type ServerKind = 'in-process' | 'remote';

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface ApprovalRequest {
  tool: HubTool;
  args: Record<string, unknown>;
  reason: string;
}

/** Human-in-the-loop gate. The RN app shows a modal; tests/eval auto-decide. */
export type Approver = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** Which calls need a human: anything that leaves the device or is destructive. */
export function approvalReason(t: HubTool): string | null {
  if (t.annotations.destructiveHint) return 'This tool can modify or delete data.';
  if (t.annotations.openWorldHint) return 'This tool uses the network (data leaves the device).';
  return null;
}

interface Connection {
  name: string;
  kind: ServerKind;
  client: Client;
  tools: HubTool[];
}

/**
 * MCP client hub. Every capability the agent has — including the bundled
 * Gmail/memory/enrichment servers — goes through a real MCP Client, so remote
 * servers and in-process servers are interchangeable to the agent.
 */
export class McpHub {
  private conns = new Map<string, Connection>();
  private approver: Approver | null = null;
  private standingGrants = new Set<string>();

  private clientOptions: ConstructorParameters<typeof Client>[1];

  constructor(clientOptions: ConstructorParameters<typeof Client>[1] = {}) {
    this.clientOptions = clientOptions;
  }

  /** Bundle a server in-process via a linked in-memory transport pair. */
  async addInProcess(name: string, server: McpServer): Promise<void> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await this.connect(name, 'in-process', clientT);
  }

  /** Connect a remote MCP server (Streamable HTTP or any other Transport). */
  async addRemote(name: string, transport: Transport): Promise<void> {
    await this.connect(name, 'remote', transport);
  }

  private async connect(name: string, kind: ServerKind, transport: Transport): Promise<void> {
    if (name.includes('__')) throw new Error('server name may not contain "__"');
    await this.remove(name);
    const client = new Client({ name: 'pocket-agent', version: '0.1.0' }, this.clientOptions);
    await client.connect(transport);
    const conn: Connection = { name, kind, client, tools: [] };
    conn.tools = await this.fetchTools(conn);
    this.conns.set(name, conn);
  }

  private async fetchTools(conn: Connection): Promise<HubTool[]> {
    const out: HubTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await conn.client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        out.push({
          qualifiedName: `${conn.name}__${t.name}`,
          server: conn.name,
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema as Record<string, unknown>,
          annotations: {
            ...(t.annotations ?? {}),
            // Remote servers are network by definition, whatever they claim.
            openWorldHint: conn.kind === 'remote' ? true : t.annotations?.openWorldHint,
          },
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  setApprover(a: Approver | null): void {
    this.approver = a;
  }

  revokeGrants(): void {
    this.standingGrants.clear();
  }

  async remove(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (c) {
      await c.client.close().catch(() => {});
      this.conns.delete(name);
    }
  }

  servers(): { name: string; kind: ServerKind; toolCount: number }[] {
    return [...this.conns.values()].map((c) => ({ name: c.name, kind: c.kind, toolCount: c.tools.length }));
  }

  tools(filter?: (t: HubTool) => boolean): HubTool[] {
    const all = [...this.conns.values()].flatMap((c) => c.tools);
    return filter ? all.filter(filter) : all;
  }

  tool(qualifiedName: string): HubTool | undefined {
    return this.tools().find((t) => t.qualifiedName === qualifiedName);
  }

  toolSpecs(filter?: (t: HubTool) => boolean): ToolSpec[] {
    return this.tools(filter).map((t) => ({
      name: t.qualifiedName,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  async call(qualifiedName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallOutcome> {
    const t = this.tool(qualifiedName);
    if (!t) return { isError: true, text: `Unknown tool ${qualifiedName}` };
    const conn = this.conns.get(t.server)!;
    const reason = approvalReason(t);
    if (reason && !this.standingGrants.has(t.qualifiedName)) {
      const decision = this.approver ? await this.approver({ tool: t, args, reason }) : 'deny';
      if (decision === 'deny') {
        return { isError: true, text: `User declined ${t.qualifiedName}. Do not retry; continue without it.` };
      }
      if (decision === 'allow-always') this.standingGrants.add(t.qualifiedName);
    }
    try {
      const res: any = await conn.client.callTool({ name: t.name, arguments: args }, undefined, { signal, timeout: 10 * 60_000 });
      const text = (res.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      return { isError: !!res.isError, text, structured: res.structuredContent };
    } catch (e) {
      return { isError: true, text: `Tool error: ${(e as Error).message}` };
    }
  }

  /** Call and parse structuredContent (or JSON text). Throws on tool error — for deterministic skill code. */
  async callJSON<T>(qualifiedName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const r = await this.call(qualifiedName, args, signal);
    if (r.isError) throw new Error(r.text);
    if (r.structured !== undefined) return r.structured as T;
    return JSON.parse(r.text) as T;
  }
}
