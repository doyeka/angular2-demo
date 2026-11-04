export interface MailMessage {
  id: string;
  account: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  to: string[];
  subject: string;
  snippet: string;
  /** Plain-text body (HTML stripped), truncated to a sane size at ingest. */
  body: string;
  labels: string[];
  /** epoch ms */
  date: number;
}

export interface MailProvider {
  readonly account: string;
  /** Provider-side search (e.g. Gmail `q=` syntax). Returns message ids. */
  searchIds(query: string, opts: { max: number; signal?: AbortSignal }): Promise<string[]>;
  getMessage(id: string, signal?: AbortSignal): Promise<MailMessage>;
}
