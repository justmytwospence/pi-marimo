// pi-marimo: keeps Pi aware of the marimo notebook you are working in.
//
// - Footer: `marimo: <current file> · running <section> (12s) · 2 queued · 1 error · also <file>, <file>`
//   through ctx.ui.setStatus("marimo", ...), so it shows in Pi's own footer and
//   any footer that reads extension statuses.
// - Context: the notebooks' state, taken when you send a prompt, sits right
//   after that prompt for the whole turn. It is never stored in the session, so
//   the model sees only the current turn's copy and old copies never pile up.
// - /marimo: pin notebooks, follow every notebook under the cwd, or turn it off.
// - herdr (through pi-herdr): when a turn ends with a cell the agent started still running, the pane
//   token `marimo` says what runs until the kernel goes quiet, then a notification says it finished
//   (herdr.ts).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KernelHold } from "./core/hold.js";
import { snapshot, STATE_TAG, statusParts, statusText } from "./core/render.js";
import { nodeIo } from "./core/node-io.js";
import { pairTargets } from "./core/touch.js";
import { MarimoWatcher, type Mode, parseMode } from "./core/watcher.js";
import { HerdrHold } from "./herdr.js";

const ENTRY = "pi-marimo";
const STATUS_KEY = "marimo";
const MESSAGE_TYPE = "pi-marimo-state";

type Entry = { type?: string; customType?: string; data?: unknown };

function savedMode(entries: readonly Entry[]): Mode | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== ENTRY) continue;
    const mode = parseMode((entry.data as { mode?: unknown } | undefined)?.mode);
    if (mode) return mode;
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
  // Per notebook path: browser edits after this change number are flagged as new.
  const seen = new Map<string, number>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let lastStatus: string | undefined;
  // The state taken when the current turn's prompt was sent, and that prompt's timestamp.
  let turn: { text: string; anchor?: number } | undefined;
  // A cell the agent started that outlives its turn, shown in herdr (interactive sessions only).
  const hold = new KernelHold();
  let herdr: HerdrHold | undefined;
  pi.events?.on("herdr:ready", () => herdr?.resend());

  const statusLine = (): string | undefined => {
    if (!watcher) return undefined;
    const { connection, attachment, mode } = watcher;
    if (!attachment) return undefined;
    if (connection === "searching") {
      return mode.kind === "pinned" ? statusText({ notebook: mode.paths.map((p) => p.split("/").pop()).join(", "), connection: "not open", queued: 0, errors: 0 }) : undefined;
    }
    return statusText(statusParts(watcher.notebook, attachment, connection, Date.now(), watcher.others()));
  };

  const render = (): void => {
    pending = undefined;
    if (hold.active && watcher) void herdr?.apply(hold.update(watcher.followed(), Date.now()));
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

  /** The followed notebooks that are connected, the current one first. */
  const stateEntries = () =>
    (watcher?.followed() ?? [])
      .filter((f) => f.connection === "connected" && f.notebook.ready)
      .map((f) => ({ notebook: f.notebook, attachment: f.attachment, current: f.current, seenSeq: seen.get(f.attachment.path) ?? 0 }));

  const setMode = (mode: Mode): void => {
    pi.appendEntry(ENTRY, { mode });
    watcher?.setMode(mode);
    schedule();
  };

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    herdr = ctx.mode === "tui" ? new HerdrHold(pi.events) : undefined;
    await watcher?.stop();
    watcher = new MarimoWatcher({ io: nodeIo(), cwd: ctx.cwd, token: process.env.MARIMO_TOKEN, onChange: schedule });
    watcher.mode = savedMode(ctx.sessionManager.getBranch() as Entry[]) ?? { kind: "auto" };
    watcher.start();
  });

  pi.on("session_shutdown", async () => {
    if (pending) clearTimeout(pending);
    if (ticker) clearInterval(ticker);
    pending = ticker = undefined;
    await herdr?.apply(hold.release());
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
    const entries = stateEntries();
    turn = entries.length ? { text: snapshot(entries, { refresh: "prompt" }) } : undefined;
  });

  // The notebook this session's agent works in (through marimo-pair) becomes current for this
  // session, whatever other sessions or the browser do. Nested calls (codemode) arrive here too.
  pi.on("tool_call", (event) => {
    const targets = pairTargets(JSON.stringify(event.input ?? {}));
    if (targets.length) watcher?.touch(targets);
    return undefined;
  });

  pi.on("agent_start", () => {
    void herdr?.apply(hold.begin(Date.now()));
  });

  // The agent is done for now: a cell it started that still runs holds the pane's attention.
  pi.on("agent_settled", (_event, ctx) => {
    if (!watcher || ctx.isIdle() !== true) return;
    void herdr?.apply(hold.end(watcher.followed(), Date.now()));
  });

  // Browser edits made after this point are flagged as new in the next turn.
  pi.on("agent_end", () => {
    for (const f of watcher?.followed() ?? []) seen.set(f.attachment.path, f.notebook.seq);
  });

  pi.on("context", (event) => {
    if (!turn) return undefined;
    const block = { role: "custom", customType: MESSAGE_TYPE, content: turn.text, display: false, timestamp: 0 } as (typeof event.messages)[number];
    const placed = insertState(event.messages as Array<{ role?: string; timestamp?: number }>, block as { role?: string; timestamp?: number }, turn.anchor);
    turn.anchor = placed.anchor;
    return { messages: placed.messages as typeof event.messages };
  });

  pi.registerCommand("marimo", {
    description: "Choose the marimo notebooks Pi follows (auto, off, show)",
    getArgumentCompletions: (prefix) =>
      ["auto", "off", "show"].filter((a) => a.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!watcher) return;
      const arg = args.trim();
      if (arg === "auto") { setMode({ kind: "auto" }); ctx.ui.notify("marimo: following every notebook open under this directory", "info"); return; }
      if (arg === "off") { setMode({ kind: "off" }); ctx.ui.notify("marimo: off", "info"); return; }
      if (arg === "show") {
        const entries = stateEntries();
        ctx.ui.notify(entries.length ? snapshot(entries, { refresh: "prompt" }) : statusLine() ?? "marimo: no notebook attached", "info");
        return;
      }
      // A checklist: pick notebooks to pin one at a time, then Done.
      const open = [...new Map((await watcher.list()).map((n) => [n.path, n])).values()];
      const pinned = new Set(watcher.mode.kind === "pinned" ? watcher.mode.paths : []);
      for (const p of pinned) if (!open.some((n) => n.path === p)) open.push({ url: "", sessionId: "", path: p });
      const done = "Done";
      const auto = `Auto: every notebook open under ${ctx.cwd}`;
      const off = "Off";
      for (;;) {
        const labels = open.map((n) => `${pinned.has(n.path) ? "[x]" : "[ ]"} ${n.path}${n.url ? "" : "  (not open)"}`);
        const choice = await ctx.ui.select("Notebooks for Pi to follow (pick to toggle)", [done, ...labels, auto, off]);
        if (choice === undefined) return;
        if (choice === auto) return setMode({ kind: "auto" });
        if (choice === off) return setMode({ kind: "off" });
        if (choice === done) return setMode(pinned.size ? { kind: "pinned", paths: [...pinned] } : { kind: "auto" });
        const notebook = open[labels.indexOf(choice)];
        if (!notebook) continue;
        if (pinned.has(notebook.path)) pinned.delete(notebook.path);
        else pinned.add(notebook.path);
      }
    },
  });
}
