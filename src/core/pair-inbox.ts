// Pi as a marimo pair agent. On a host-capable marimo (main), opening a notebook's host event stream with
// `Marimo-Attachment-Kind: agent` makes marimo show the agent attached (its editor footer says "Pi"), and
// lets the notebook send it messages (`marimo.pair.agent-message` custom events, what `marimo pair connect`
// forwards to other agents). One stream per notebook this session uses; the same request marimo's own
// forwarder makes. Servers without a host record are left alone. If the user detaches Pi in marimo, it
// stays detached until `reattach()`.
import { randomUUID } from "node:crypto";
import { findHost as defaultFindHost } from "./hosts.js";
import { SseParser } from "./sse.js";

export const AGENT_MESSAGE_TYPE = "marimo.pair.agent-message";

export interface InboxTarget { serverUrl: string; notebookId: string; path: string }
export interface InboxMessage { serverUrl: string; path: string; notebookId: string; text: string }

export interface PairInboxOptions {
  onMessage(message: InboxMessage): void;
  onTrouble?(target: InboxTarget, error: Error): void;
  /** Told once when the user detaches Pi in marimo. */
  onDetached?(target: InboxTarget): void;
  identity?: string;
  name?: string;
  fetchImpl?: typeof fetch;
  findHost?: typeof defaultFindHost;
  backoff?: { initialMs: number; maxMs: number };
}

interface Entry { abort: AbortController; done: boolean }

const keyOf = (t: Pick<InboxTarget, "serverUrl" | "notebookId">): string => `${t.serverUrl}\0${t.notebookId}`;

export class PairInbox {
  private readonly streams = new Map<string, Entry>();
  private readonly detached = new Set<string>();
  private readonly attached = new Set<string>();
  private readonly identity: string;

  constructor(private readonly options: PairInboxOptions) {
    this.identity = options.identity ?? `pi-marimo-${randomUUID()}`;
  }

  /** Opens a stream for each listed notebook and closes the ones no longer listed. */
  sync(targets: InboxTarget[]): void {
    const want = new Map(targets.map((t) => [keyOf(t), t]));
    for (const [key, entry] of this.streams) {
      if (want.has(key)) continue;
      entry.abort.abort();
      this.streams.delete(key);
      this.attached.delete(key);
    }
    for (const key of this.detached) if (!want.has(key)) this.detached.delete(key);
    for (const [key, target] of want) {
      if (this.streams.has(key) || this.detached.has(key)) continue;
      const entry: Entry = { abort: new AbortController(), done: false };
      this.streams.set(key, entry);
      void this.run(key, target, entry);
    }
  }

  /** Lets notebooks the user detached Pi from (and ones that were not host-capable) be tried again by the next `sync`. */
  reattach(): void {
    this.detached.clear();
    for (const [key, entry] of this.streams) if (entry.done) this.streams.delete(key);
  }

  attachedKeys(): string[] { return [...this.attached]; }

  /** Closes every stream; a later `sync` opens them again (Pi reuses the extension across sessions). */
  dispose(): void {
    for (const entry of this.streams.values()) entry.abort.abort();
    this.streams.clear();
    this.attached.clear();
  }

  private async run(key: string, target: InboxTarget, entry: Entry): Promise<void> {
    const backoff = this.options.backoff ?? { initialMs: 500, maxMs: 30_000 };
    const find = this.options.findHost ?? defaultFindHost;
    const doFetch = this.options.fetchImpl ?? fetch;
    const signal = entry.abort.signal;
    let delay = backoff.initialMs;
    let failures = 0;
    let cursor: string | undefined;
    let attachmentId: string | undefined;
    while (!signal.aborted) {
      const host = await find(target.serverUrl);
      if (!host) { entry.done = true; return; }
      try {
        const res = await doFetch(`${host.url}/notebooks/${encodeURIComponent(target.notebookId)}/events?types=custom,attachment`, {
          signal,
          headers: {
            Authorization: `Bearer ${host.token}`,
            Accept: "text/event-stream",
            "Marimo-Attachment-Identity": this.identity,
            "Marimo-Attachment-Kind": "agent",
            "Marimo-Attachment-Name": this.options.name ?? "Pi",
            ...(cursor ? { "Last-Event-ID": cursor } : {}),
          },
        });
        if (res.status === 404) { entry.done = true; return; }
        if (!res.ok || !res.body) throw new Error(`marimo answered ${res.status}`);
        const parser = new SseParser();
        const decoder = new TextDecoder();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
            if (event.id) cursor = event.id;
            let data: Record<string, any>;
            try { data = JSON.parse(event.data) as Record<string, any>; } catch { continue; }
            if (event.event === "attachment") {
              const a = data.attachment;
              if (a?.identity === this.identity && a?.kind === "agent") {
                attachmentId = typeof a.id === "string" ? a.id : attachmentId;
                this.attached.add(key);
                failures = 0;
                delay = backoff.initialMs;
              }
            } else if (event.event === "attachment.removed") {
              if (attachmentId !== undefined && data.id === attachmentId) {
                this.attached.delete(key);
                this.detached.add(key);
                this.streams.delete(key);
                entry.abort.abort();
                this.options.onDetached?.(target);
                return;
              }
            } else if (event.event === "custom") {
              const payload = data.custom;
              if (payload?.type === AGENT_MESSAGE_TYPE) {
                this.options.onMessage({ ...target, text: typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data) });
              }
            } else if (event.event === "reset") cursor = undefined;
          }
        }
        throw new Error("the notebook stream ended");
      } catch (e) {
        if (signal.aborted) return;
        this.attached.delete(key);
        failures++;
        if (failures === 3) this.options.onTrouble?.(target, e instanceof Error ? e : new Error(String(e)));
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      delay = Math.min(delay * 2, backoff.maxMs);
    }
  }
}
