import { decodeBase64Url, htmlToText, parseAddress } from '../util/text.ts';
import type { MailMessage, MailProvider } from './types.ts';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Supplies a fresh OAuth access token (refreshing as needed). Implemented in native/gmailAuth.ts. */
export type TokenProvider = () => Promise<string>;

export class GmailProvider implements MailProvider {
  readonly account: string;
  private getToken: TokenProvider;
  private fetchImpl: typeof fetch;

  constructor(account: string, getToken: TokenProvider, fetchImpl: typeof fetch = fetch) {
    this.account = account;
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
  }

  private async call(path: string, signal?: AbortSignal): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${API}${path}`, {
        headers: { authorization: `Bearer ${await this.getToken()}` },
        signal,
      });
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`Gmail ${res.status}: ${await res.text()}`);
    }
  }

  async searchIds(query: string, opts: { max: number; signal?: AbortSignal }): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      // Built by hand: RN's URLSearchParams polyfill is incomplete.
      let qs = `q=${encodeURIComponent(query)}&maxResults=${Math.min(500, opts.max - ids.length)}`;
      if (pageToken) qs += `&pageToken=${encodeURIComponent(pageToken)}`;
      const page = await this.call(`/messages?${qs}`, opts.signal);
      for (const m of page.messages ?? []) ids.push(m.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < opts.max);
    return ids;
  }

  async getMessage(id: string, signal?: AbortSignal): Promise<MailMessage> {
    const m = await this.call(`/messages/${id}?format=full`, signal);
    return parseGmailMessage(m, this.account);
  }
}

export function parseGmailMessage(m: any, account: string): MailMessage {
  const headers: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  const from = parseAddress(headers['from'] ?? '');
  const { plain, html } = collectBodies(m.payload);
  return {
    id: m.id,
    account,
    threadId: m.threadId,
    fromName: from.name,
    fromEmail: from.email,
    to: (headers['to'] ?? '').split(',').map((s) => parseAddress(s).email).filter(Boolean),
    subject: headers['subject'] ?? '',
    snippet: m.snippet ?? '',
    body: plain || htmlToText(html),
    labels: m.labelIds ?? [],
    date: Number(m.internalDate ?? Date.now()),
  };
}

function collectBodies(part: any, acc = { plain: '', html: '' }): { plain: string; html: string } {
  if (!part) return acc;
  const data = part.body?.data;
  if (data && part.mimeType === 'text/plain' && !acc.plain) acc.plain = decodeBase64Url(data);
  if (data && part.mimeType === 'text/html' && !acc.html) acc.html = decodeBase64Url(data);
  for (const p of part.parts ?? []) collectBodies(p, acc);
  return acc;
}
