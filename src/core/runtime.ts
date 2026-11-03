import { Agent, type PdfRenderer } from './agent/agent.ts';
import { migrate } from './db/schema.ts';
import type { Db } from './db/types.ts';
import type { LLM } from './llm/types.ts';
import { MailStore } from './mail/store.ts';
import type { MailProvider } from './mail/types.ts';
import { type Approver, McpHub } from './mcp/hub.ts';
import { createEnrichServer, type EnrichmentProvider } from './mcp/servers/enrichServer.ts';
import { createMailServer } from './mcp/servers/mailServer.ts';
import { createMemoryServer } from './mcp/servers/memoryServer.ts';
import { MemoryStore } from './memory/store.ts';
import { jobOpportunitiesSkill } from './skills/jobOpportunities/index.ts';

export interface RuntimeConfig {
  db: Db;
  llm: LLM;
  renderPdf: PdfRenderer;
  approver: Approver;
  /** Late-bound so the user can connect/disconnect mail without rebuilding the runtime. */
  mailProvider: () => MailProvider | null;
  enrichProviders?: EnrichmentProvider[];
  now?: () => number;
  clientOptions?: ConstructorParameters<typeof McpHub>[0];
}

export interface Runtime {
  agent: Agent;
  hub: McpHub;
  mail: MailStore;
  memory: MemoryStore;
}

/** Same wiring on device and in the Node eval harness. */
export async function createRuntime(cfg: RuntimeConfig): Promise<Runtime> {
  await migrate(cfg.db);
  const mail = new MailStore(cfg.db);
  const memory = new MemoryStore(cfg.db);
  const hub = new McpHub(cfg.clientOptions);
  hub.setApprover(cfg.approver);
  await hub.addInProcess('mail', createMailServer({ store: mail, provider: cfg.mailProvider, now: cfg.now }));
  await hub.addInProcess('memory', createMemoryServer(memory));
  if (cfg.enrichProviders?.length) await hub.addInProcess('enrich', createEnrichServer(cfg.enrichProviders));
  const agent = new Agent({
    llm: cfg.llm,
    hub,
    db: cfg.db,
    skills: [jobOpportunitiesSkill],
    renderPdf: cfg.renderPdf,
    selfEmail: () => cfg.mailProvider()?.account ?? null,
    now: cfg.now,
  });
  return { agent, hub, mail, memory };
}
