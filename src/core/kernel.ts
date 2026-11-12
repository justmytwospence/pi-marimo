// Interrupting and running cells in a notebook's kernel, and setting its widgets, as the browser's
// buttons and controls do: POST /api/kernel/interrupt, /run, /set_ui_element_value and
// /set_model_value for the session. marimo checks a server token on every API call (it is in the
// page marimo serves, `data-token="..."`) besides the access token of a protected server.
import { randomUUID } from "node:crypto";
import { type HostRecord, findHost } from "./hosts.js";
import { authHeaders } from "./registry.js";
import { htmlToText } from "./output.js";
import { SseParser } from "./sse.js";

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** A notebook session on a server; `notebookId` (marimo main) lets run and interrupt use the host API. */
export interface KernelTarget { url: string; sessionId: string; notebookId?: string }
type HostLookup = (url: string) => Promise<HostRecord | undefined>;

const serverTokens = new Map<string, string>();

async function serverToken(url: string, auth: Record<string, string>, fetchImpl: Fetch, fresh: boolean): Promise<string> {
  const known = serverTokens.get(url);
  if (known !== undefined && !fresh) return known;
  // Never left waiting on a server that does not answer.
  const page = await fetchImpl(`${url}/`, { headers: auth, signal: AbortSignal.timeout(5_000) });
  const found = /data-token="([^"]*)"/u.exec(await page.text())?.[1] ?? "";
  serverTokens.set(url, found);
  return found;
}

/** The headers a kernel endpoint needs for the session: the access token, the session id and the server token (`fresh` refetches it). */
export async function kernelHeaders(target: { url: string; sessionId: string }, token?: string, fetchImpl: Fetch = fetch as unknown as Fetch, fresh = false): Promise<Record<string, string>> {
  const auth = authHeaders(token);
  return { ...auth, "Content-Type": "application/json", "Marimo-Session-Id": target.sessionId, "Marimo-Server-Token": await serverToken(target.url, auth, fetchImpl, fresh) };
}

/** POSTs a JSON body to one of the kernel's endpoints for the session, with marimo's token headers. */
export async function kernelPost(target: { url: string; sessionId: string }, endpoint: string, body: unknown, token?: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  const post = async (fresh: boolean) =>
    fetchImpl(`${target.url}/api/kernel/${endpoint}`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: await kernelHeaders(target, token, fetchImpl, fresh),
      body: JSON.stringify(body),
    });
  let res = await post(false);
  // A restarted server has a new token.
  if (res.status === 401 || res.status === 403) res = await post(true);
  if (!res.ok) throw new Error(`marimo answered ${res.status}`);
}

/** POSTs to marimo's host API (bearer token, idempotency key); never retried. */
export async function hostPost(host: HostRecord, path: string, body: unknown, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  const res = await fetchImpl(`${host.url}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${host.token}`, "Idempotency-Key": randomUUID(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`marimo answered ${res.status}`);
}

/** Stops whatever the session's kernel runs (the running cell; the queue behind it is dropped). */
export async function interruptKernel(target: KernelTarget, token?: string, fetchImpl: Fetch = fetch as unknown as Fetch, hosts: HostLookup = findHost): Promise<void> {
  const host = target.notebookId ? await hosts(target.url) : undefined;
  if (host) return hostPost(host, `/notebooks/${encodeURIComponent(target.notebookId!)}/runtime/interrupt`, undefined, fetchImpl);
  return kernelPost(target, "interrupt", {}, token, fetchImpl);
}

/** Runs cells as the browser's run button does (marimo main: the host API runs them by id). */
export async function runCells(target: KernelTarget, cells: Array<{ id: string; code: string }>, token?: string, fetchImpl: Fetch = fetch as unknown as Fetch, hosts: HostLookup = findHost): Promise<void> {
  const host = target.notebookId ? await hosts(target.url) : undefined;
  if (host) return hostPost(host, `/notebooks/${encodeURIComponent(target.notebookId!)}/runtime/runs`, { cells: cells.map((c) => ({ id: c.id })) }, fetchImpl);
  return kernelPost(target, "run", { cellIds: cells.map((c) => c.id), codes: cells.map((c) => c.code) }, token, fetchImpl);
}

/** Sets widgets (by object id) as moving them in the browser does; the cells that read them rerun. */
export function setUiValues(target: { url: string; sessionId: string }, objectIds: string[], values: unknown[], token?: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  return kernelPost(target, "set_ui_element_value", { objectIds, values }, token, fetchImpl);
}

/** Sends an anywidget a custom message (marimo-lens's commands travel this way); buffers are base64. */
export function setModelValue(target: { url: string; sessionId: string }, modelId: string, content: unknown, buffers: string[], token?: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  return kernelPost(target, "set_model_value", { modelId, message: { method: "custom", content }, buffers }, token, fetchImpl);
}

// --- scratchpad ---------------------------------------------------------------------------------
// Python run in a notebook's kernel without touching its cells: marimo's scratchpad, through the same
// endpoint `marimo pair execute` uses (POST /api/kernel/execute). Cancelling the request interrupts the kernel.

export interface ScratchEvent {
  stream: "stdout" | "stderr";
  text: string;
}

export interface ScratchResult {
  success: boolean;
  output?: { mimetype: string; data: string };
}

type StreamFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array> | null; text(): Promise<string> }>;

export async function runScratch(target: { url: string; sessionId: string }, code: string, token: string | undefined, onEvent: (e: ScratchEvent) => void, signal?: AbortSignal, fetchImpl: StreamFetch = fetch as unknown as StreamFetch): Promise<ScratchResult> {
  const post = async (fresh: boolean) =>
    fetchImpl(`${target.url}/api/kernel/execute`, {
      method: "POST",
      headers: { ...(await kernelHeaders(target, token, fetchImpl as never, fresh)), Accept: "text/event-stream" },
      body: JSON.stringify({ code }),
      ...(signal ? { signal } : {}),
    });
  let res = await post(false);
  // A restarted server has a new token.
  if (res.status === 401 || res.status === 403) res = await post(true);
  if (!res.ok || !res.body) throw new Error(`marimo answered ${res.status}`);
  const parser = new SseParser();
  const decoder = new TextDecoder();
  let result: ScratchResult | undefined;
  const handle = (text: string) => {
    for (const event of parser.push(text)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.event === "stdout" || event.event === "stderr") {
        const raw = typeof data.data === "string" ? data.data : "";
        const plain = event.event === "stderr" && raw.trimStart().startsWith("<") ? htmlToText(raw) : raw;
        const lines = plain.split("\n");
        if (lines.at(-1) === "") lines.pop();
        for (const line of lines) onEvent({ stream: event.event, text: line });
      } else if (event.event === "done") {
        const output = data.output as { mimetype?: unknown; data?: unknown } | undefined;
        result = {
          success: data.success === true,
          ...(output && typeof output.mimetype === "string" && typeof output.data === "string" ? { output: { mimetype: output.mimetype, data: output.data } } : {}),
        };
      }
    }
  };
  for await (const chunk of res.body) handle(decoder.decode(chunk, { stream: true }));
  handle(decoder.decode());
  return result ?? { success: false };
}
