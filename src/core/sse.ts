// A read-only (kiosk) subscription to a marimo session's message stream.
//
// marimo serves the same kernel messages over /ws and /sse. A kiosk consumer
// is never the session's main consumer: it cannot edit or run code and does
// not take the notebook over from the browser. Connecting replays the
// session's current state (kernel-ready, then every cell's last messages), so
// a fresh NotebookState is complete after the replay.

import { authHeaders, type Fetch } from "./registry.js";

export interface SseEvent {
  event?: string;
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
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) events.push({ event, data: data.join("\n") });
      end = this.buffer.indexOf("\n\n");
    }
    return events;
  }
}

export interface StreamResult {
  /** "closed": the server ended the stream with a close event. "ended": the stream dropped. */
  kind: "closed" | "ended" | "http-error";
  code?: number;
  reason?: string;
}

export interface StreamOptions {
  url: string;
  sessionId: string;
  file?: string;
  token?: string;
  signal: AbortSignal;
  fetch?: Fetch;
  onOpen?: () => void;
  onMessage: (op: string, data: unknown) => void;
}

export async function streamSession(options: StreamOptions): Promise<StreamResult> {
  const params = new URLSearchParams({ session_id: options.sessionId, kiosk: "true" });
  if (options.file) params.set("file", options.file);
  if (options.token) params.set("access_token", options.token);
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`${options.url}/sse?${params}`, {
    headers: { Accept: "text/event-stream", ...authHeaders(options.token) },
    signal: options.signal,
  });
  if (!response.ok || !response.body) return { kind: "http-error", code: response.status };
  options.onOpen?.();
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { kind: "ended" };
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (event.event === "close") {
          try {
            const body = JSON.parse(event.data) as { code?: number; reason?: string };
            return { kind: "closed", code: body.code, reason: body.reason };
          } catch {
            return { kind: "closed" };
          }
        }
        if (event.event && event.event !== "message") continue;
        let message: { op?: unknown; data?: unknown };
        try {
          message = JSON.parse(event.data);
        } catch {
          continue;
        }
        if (typeof message.op === "string") options.onMessage(message.op, message.data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
