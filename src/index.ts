// pi-marimo: keeps Pi aware of the marimo notebook you are working in.
//
// - Footer: `marimo: <file> · running <section> (12s) · 2 queued · 1 error`
//   through ctx.ui.setStatus("marimo", ...), so it shows in Pi's own footer and
//   any footer that reads extension statuses.
// - Context: before every model request, the notebook's current state is
//   appended as the last message. It is never stored in the session, so the
//   model only ever sees the latest copy and old copies never pile up.
// - /marimo: pick the notebook, follow notebooks under the cwd, or turn it off.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { snapshot, STATE_TAG, statusParts, statusText } from "./core/render.js";
import { nodeIo } from "./core/node-io.js";
import { MarimoWatcher, type Mode } from "./core/watcher.js";

const ENTRY = "pi-marimo";
const STATUS_KEY = "marimo";
const MESSAGE_TYPE = "pi-marimo-state";

type Entry = { type?: string; customType?: string; data?: unknown };

function savedMode(entries: readonly Entry[]): Mode | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== ENTRY) continue;
    const mode = (entry.data as { mode?: Mode } | undefined)?.mode;
    if (mode && (mode.kind === "auto" || mode.kind === "off" || (mode.kind === "pinned" && typeof mode.path === "string"))) return mode;
  }
  return undefined;
}

/**
 * Anthropic caches a prompt only up to its marked breakpoints, and Pi marks the
 * last message, which is the state block. That block is replaced on the next
 * request, so a cache entry ending in it is never read again, and the
 * conversation before it would be re-read uncached every time. Moving the
 * breakpoint to the block just before the state block caches the conversation
 * instead; only the small state block is processed fresh. Pi already uses all
 * four breakpoints Anthropic allows, so the mark is moved, not added.
 */
export function moveStateBreakpoint(payload: unknown): unknown {
  const body = payload as { messages?: Array<{ role?: string; content?: unknown }> } | undefined;
  const messages = body?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = messages[m]?.content;
    if (!Array.isArray(content)) continue;
    const b = content.findIndex((block) => typeof block?.text === "string" && block.text.startsWith(`<${STATE_TAG}`));
    if (b < 0) continue;
    let target: Record<string, unknown> | undefined;
    if (b > 0) target = content[b - 1];
    else {
      const previous = messages[m - 1]?.content;
      if (Array.isArray(previous) && previous.length) target = previous[previous.length - 1];
    }
    const state = content[b] as { cache_control?: unknown };
    const cacheable = ["text", "image", "tool_result", "document", "tool_use"];
    if (!state.cache_control || !target || !cacheable.includes(String(target.type))) return undefined;
    target.cache_control ??= state.cache_control;
    delete state.cache_control;
    return payload;
  }
  return undefined;
}

export default function piMarimo(pi: ExtensionAPI): void {
  let watcher: MarimoWatcher | undefined;
  let ctxRef: ExtensionContext | undefined;
  let seenSeq = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let lastStatus: string | undefined;

  const statusLine = (): string | undefined => {
    if (!watcher) return undefined;
    const { connection, attachment, mode } = watcher;
    if (!attachment) return undefined;
    if (connection === "searching") return mode.kind === "pinned" ? statusText({ notebook: attachment.path.split("/").pop()!, connection: "not open", queued: 0, errors: 0 }) : undefined;
    return statusText(statusParts(watcher.notebook, attachment, connection, Date.now(), watcher.others().length));
  };

  const render = (): void => {
    pending = undefined;
    const text = statusLine();
    if (text !== lastStatus) {
      lastStatus = text;
      ctxRef?.ui.setStatus(STATUS_KEY, text);
    }
    // Tick the elapsed time while a cell runs.
    const running = watcher?.connection === "connected" && watcher.notebook.running();
    if (running && !ticker) ticker = setInterval(render, 1000);
    if (!running && ticker) { clearInterval(ticker); ticker = undefined; }
  };

  const schedule = (): void => {
    pending ??= setTimeout(render, 150);
  };

  const setMode = (mode: Mode): void => {
    pi.appendEntry(ENTRY, { mode });
    watcher?.setMode(mode);
    schedule();
  };

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    await watcher?.stop();
    watcher = new MarimoWatcher({ io: nodeIo(), cwd: ctx.cwd, token: process.env.MARIMO_TOKEN, onChange: schedule });
    watcher.mode = savedMode(ctx.sessionManager.getBranch() as Entry[]) ?? { kind: "auto" };
    watcher.start();
  });

  pi.on("session_shutdown", async () => {
    if (pending) clearTimeout(pending);
    if (ticker) clearInterval(ticker);
    pending = ticker = undefined;
    await watcher?.stop();
    watcher = undefined;
    ctxRef?.ui.setStatus(STATUS_KEY, undefined);
    lastStatus = undefined;
  });

  pi.on("before_agent_start", async () => {
    watcher?.refresh();
    await watcher?.settle(2000);
  });

  // Browser edits made after this point are flagged as new in the next turn.
  pi.on("agent_end", () => {
    if (watcher) seenSeq = watcher.notebook.seq;
  });

  pi.on("context", (event) => {
    if (!watcher?.attachment || watcher.connection !== "connected" || !watcher.notebook.ready) return undefined;
    const text = snapshot(watcher.notebook, watcher.attachment, { seenSeq, others: watcher.others() });
    return {
      messages: [
        ...event.messages,
        { role: "custom", customType: MESSAGE_TYPE, content: text, display: false, timestamp: Date.now() },
      ],
    };
  });

  pi.on("before_provider_request", (event) => moveStateBreakpoint(event.payload));

  pi.registerCommand("marimo", {
    description: "Choose the marimo notebook Pi follows (auto, off, show)",
    getArgumentCompletions: (prefix) =>
      ["auto", "off", "show"].filter((a) => a.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!watcher) return;
      const arg = args.trim();
      if (arg === "auto") { setMode({ kind: "auto" }); ctx.ui.notify("marimo: following the notebook used most recently under this directory", "info"); return; }
      if (arg === "off") { setMode({ kind: "off" }); ctx.ui.notify("marimo: off", "info"); return; }
      if (arg === "show") {
        if (!watcher.attachment || watcher.connection !== "connected") { ctx.ui.notify(statusLine() ?? "marimo: no notebook attached", "info"); return; }
        ctx.ui.notify(snapshot(watcher.notebook, watcher.attachment, { seenSeq, others: watcher.others() }), "info");
        return;
      }
      const notebooks = await watcher.list();
      const auto = `Auto: the notebook used most recently under ${ctx.cwd}`;
      const off = "Off";
      const labels = notebooks.map((n) => `${n.path}  (${n.url})`);
      const choice = await ctx.ui.select("Notebook for Pi to follow", [...labels, auto, off]);
      if (choice === undefined) return;
      if (choice === auto) setMode({ kind: "auto" });
      else if (choice === off) setMode({ kind: "off" });
      else {
        const notebook = notebooks[labels.indexOf(choice)];
        if (notebook) setMode({ kind: "pinned", path: notebook.path, url: notebook.url });
      }
    },
  });
}
