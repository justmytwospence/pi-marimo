// pi-marimo: keeps Pi aware of the marimo notebook you are working in.
//
// - Footer: `marimo: <file> · running <section> (12s) · 2 queued · 1 error`
//   through ctx.ui.setStatus("marimo", ...), so it shows in Pi's own footer and
//   any footer that reads extension statuses.
// - Context: the notebook's state, taken when you send a prompt, sits right
//   after that prompt for the whole turn. It is never stored in the session, so
//   the model sees only the current turn's copy and old copies never pile up.
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
 * Where this turn's state block goes: right after the prompt that started the
 * turn (the last user message when the turn's first request is built). It stays
 * there, unchanged, for every request of the turn, so the thinking the model
 * writes after it stays valid: Anthropic drops a thinking block when anything
 * before it changes. At the next prompt the old block is gone (it is never
 * stored), which drops that earlier turn's thinking once.
 */
export function insertState<M extends { role?: string; timestamp?: number }>(messages: M[], block: M, anchor: number | undefined): { messages: M[]; anchor: number | undefined } {
  let at = -1;
  if (anchor !== undefined) at = messages.findIndex((m) => m.role === "user" && m.timestamp === anchor);
  if (at < 0) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") { at = i; break; }
    anchor = at >= 0 ? messages[at]?.timestamp : undefined;
  }
  if (at < 0) return { messages: [...messages, block], anchor };
  return { messages: [...messages.slice(0, at + 1), block, ...messages.slice(at + 1)], anchor };
}

export default function piMarimo(pi: ExtensionAPI): void {
  let watcher: MarimoWatcher | undefined;
  let ctxRef: ExtensionContext | undefined;
  let seenSeq = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let lastStatus: string | undefined;
  // The state taken when the current turn's prompt was sent, and that prompt's timestamp.
  let turn: { text: string; anchor?: number } | undefined;

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
    turn = undefined;
    if (!watcher) return;
    watcher.refresh();
    await watcher.settle(2000);
    if (!watcher.attachment || watcher.connection !== "connected" || !watcher.notebook.ready) return;
    turn = { text: snapshot(watcher.notebook, watcher.attachment, { seenSeq, others: watcher.others(), refresh: "prompt" }) };
  });

  // Browser edits made after this point are flagged as new in the next turn.
  pi.on("agent_end", () => {
    if (watcher) seenSeq = watcher.notebook.seq;
  });

  pi.on("context", (event) => {
    if (!turn) return undefined;
    const block = { role: "custom", customType: MESSAGE_TYPE, content: turn.text, display: false, timestamp: 0 } as (typeof event.messages)[number];
    const placed = insertState(event.messages as Array<{ role?: string; timestamp?: number }>, block as { role?: string; timestamp?: number }, turn.anchor);
    turn.anchor = placed.anchor;
    return { messages: placed.messages as typeof event.messages };
  });

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
        ctx.ui.notify(snapshot(watcher.notebook, watcher.attachment, { seenSeq, others: watcher.others(), refresh: "prompt" }), "info");
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
