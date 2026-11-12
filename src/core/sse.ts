// A read-only (kiosk) subscription to a marimo session's message stream.
//
// Two framings exist. Released marimo (0.25.x) sends each kernel message as a plain `message` event
// `{op, data}`. marimo main sends host events: `event: marimo` carries `{marimo: {op, ...fields}}`,
// and the notebook's cells and order arrive as `cell` and `document` events before `kernel-ready`,
// which no longer lists them. SessionDecoder turns both into `{op, data}` messages.
//
// marimo serves the same kernel messages over /ws and /sse. A kiosk consumer
// is never the session's main consumer: it cannot edit or run code and does
// not take the notebook over from the browser. Connecting replays the
// session's current state (kernel-ready, then every cell's last messages), so
// a fresh NotebookState is complete after the replay.

import type { Cancellable, Io } from "./io.js";
import { authHeaders } from "./registry.js";

export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

/** Incremental parser for a text/event-stream body. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const events: SseEvent[] = [];
    let end = this.buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event: string | undefined;
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "id") id = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) events.push({ event, ...(id !== undefined ? { id } : {}), data: data.join("\n") });
      end = this.buffer.indexOf("\n\n");
    }
    return events;
  }
}

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Decodes one session stream's events, in either framing, into kernel messages. */
export class SessionDecoder {
  private cells = new Map<string, Record<string, unknown>>();
  private order: string[] = [];

  decode(event: SseEvent): Array<{ op: string; data: unknown }> {
    let parsed: Record<string, unknown>;
    try { parsed = rec(JSON.parse(event.data)); } catch { return []; }
    switch (event.event) {
      case undefined:
      case "message":
        return typeof parsed.op === "string" ? [{ op: parsed.op, data: parsed.data }] : [];
      case "marimo": {
        const inner = rec(parsed.marimo);
        const op = inner.op;
        if (typeof op !== "string") return [];
        if (op === "kernel-ready" && !Array.isArray(inner.cell_ids)) {
          const ids = this.order.filter((id) => this.cells.has(id));
          const cells = ids.map((id) => this.cells.get(id)!);
          return [{ op, data: { ...inner, cell_ids: ids, codes: cells.map((c) => (typeof c.code === "string" ? c.code : "")), names: cells.map((c) => (typeof c.name === "string" ? c.name : "_")), configs: cells.map((c) => rec(c.config)) } }];
        }
        return [{ op, data: inner }];
      }
      case "cell": {
        const cell = rec(parsed.cell);
        if (typeof cell.id === "string") this.cells.set(cell.id, cell);
        return [];
      }
      case "cell.removed":
        if (typeof parsed.id === "string") this.cells.delete(parsed.id);
        return [];
      case "document": {
        const order = rec(parsed.document).order;
        if (Array.isArray(order)) this.order = order.filter((id): id is string => typeof id === "string");
        return [];
      }
      default:
        return [];
    }
  }
}

export interface StreamResult {
  /** "closed": the server ended the stream with a close event. "ended": the stream dropped. */
  kind: "closed" | "ended" | "http-error";
  code?: number;
  reason?: string;
}

export interface StreamOptions {
  io: Io;
  url: string;
  sessionId: string;
  file?: string;
  token?: string;
  onMessage: (op: string, data: unknown) => void;
}

export function streamSession(options: StreamOptions): Cancellable<StreamResult> {
  const query: Record<string, string> = { session_id: options.sessionId, kiosk: "true" };
  if (options.file) query.file = options.file;
  if (options.token) query.access_token = options.token;
  const params = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const parser = new SseParser();
  const decoder = new SessionDecoder();
  let closed: StreamResult | undefined;
  const stream = options.io.stream(
    `${options.url}/sse?${params}`,
    { Accept: "text/event-stream", ...authHeaders(options.token) },
    (text) => {
      if (closed) return;
      for (const event of parser.push(text)) {
        if (event.event === "close") {
          try {
            const body = JSON.parse(event.data) as { code?: number; reason?: string };
            closed = { kind: "closed", code: body.code, reason: body.reason };
          } catch {
            closed = { kind: "closed" };
          }
          stream.cancel();
          return;
        }
        for (const m of decoder.decode(event)) options.onMessage(m.op, m.data);
      }
    },
  );
  const done = stream.done.then((end): StreamResult => closed ?? (end.ok ? { kind: "ended" } : { kind: "http-error", code: end.status }));
  return { done, cancel: stream.cancel };
}
