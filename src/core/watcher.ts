// Keeps one notebook's live state current: finds the notebook, subscribes to
// its session as a kiosk consumer, follows it across page reloads (which change
// the session id) and server restarts, and reports every change.

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { NotebookState } from "./notebook.js";
import { type Fetch, findNotebooks, type NotebookSession } from "./registry.js";
import type { Attachment } from "./render.js";
import { streamSession } from "./sse.js";

export type Mode =
  | { kind: "auto" }
  | { kind: "pinned"; path: string; url?: string }
  | { kind: "off" };

export type Connection = "idle" | "searching" | "ambiguous" | "connecting" | "connected" | "disconnected";

export interface WatcherOptions {
  cwd: string;
  token?: string;
  extraUrls?: string[];
  pollMs?: number;
  fetch?: Fetch;
  registryDir?: string;
  onChange: () => void;
}

function real(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

export function samePath(a: string, b: string): boolean {
  return real(a) === real(b);
}

/** Symlinks resolved, so /tmp and /private/tmp (macOS) match. */
export function within(path: string, dir: string): boolean {
  const rel = relative(real(dir), real(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export class MarimoWatcher {
  readonly notebook = new NotebookState();
  mode: Mode = { kind: "auto" };
  connection: Connection = "idle";
  attachment?: Attachment;
  /** Notebooks found in auto mode when more than one matched. */
  candidates: NotebookSession[] = [];
  /** Whether browser edits reach us (false when connected by the browser's own session id). */
  seesBrowserEdits = false;
  private readonly consumerId = `pi-marimo-${Math.random().toString(36).slice(2, 10)}`;
  private stopped = true;
  private scanned = false;
  private wake?: AbortController;
  private loop?: Promise<void>;

  constructor(private readonly options: WatcherOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.abort();
    await this.loop?.catch(() => undefined);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.wake?.abort();
  }

  /** Wait (up to ms) for the first scan and any connection in progress, so a first request has the state. */
  async settle(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!this.stopped && (!this.scanned || this.connection === "connecting") && Date.now() < end) {
      await new Promise((done) => setTimeout(done, 50));
    }
  }

  /** Rescan now instead of at the next poll. */
  refresh(): void {
    if (this.connection !== "connected" && this.connection !== "connecting") this.wake?.abort();
  }

  async list(): Promise<NotebookSession[]> {
    return findNotebooks({ token: this.options.token, fetch: this.options.fetch, extraUrls: this.options.extraUrls, dir: this.options.registryDir });
  }

  private set(connection: Connection, attachment?: Attachment): void {
    const changed = connection !== this.connection || attachment?.sessionId !== this.attachment?.sessionId || attachment?.path !== this.attachment?.path;
    this.connection = connection;
    this.attachment = attachment;
    if (changed) this.options.onChange();
  }

  private async resolveTarget(): Promise<(NotebookSession & { shared: boolean }) | undefined> {
    const mode = this.mode;
    if (mode.kind === "off") return undefined;
    const sessions = await this.list();
    const withShared = (target: NotebookSession | undefined) => target && {
      ...target,
      shared: sessions.filter((s) => s.url === target.url && samePath(s.path, target.path)).length > 1,
    };
    if (mode.kind === "pinned") {
      // Several sessions can hold one file (a closed tab's session lingers);
      // marimo lists them oldest first, so prefer the newest.
      const matches = sessions.filter((s) => samePath(s.path, mode.path)).reverse();
      return withShared(matches.find((s) => s.url === mode.url) ?? matches[0]);
    }
    const local = sessions.filter((s) => within(s.path, this.options.cwd));
    // One entry per file, the newest session winning (see above).
    const unique = [...new Map(local.map((s) => [real(s.path), s])).values()];
    this.candidates = unique.length > 1 ? unique : [];
    return withShared(unique.length === 1 ? unique[0] : undefined);
  }

  private async pause(ms: number): Promise<void> {
    const wake = new AbortController();
    this.wake = wake;
    await new Promise<void>((done) => {
      const timer = setTimeout(done, ms);
      wake.signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
    });
  }

  private async run(): Promise<void> {
    const pollMs = this.options.pollMs ?? 5000;
    while (!this.stopped) {
      if (this.mode.kind === "off") {
        this.notebook.reset();
        this.set("idle");
        await this.pause(60_000);
        continue;
      }
      const target = await this.resolveTarget().catch(() => undefined);
      if (this.stopped) break;
      if (!target) this.scanned = true;
      if (!target) {
        this.notebook.reset();
        const pinned = this.mode.kind === "pinned" ? this.mode : undefined;
        this.set(this.candidates.length ? "ambiguous" : "searching", pinned ? { url: pinned.url ?? "", sessionId: "", path: pinned.path } : undefined);
        await this.pause(pollMs);
        continue;
      }
      const attachment = { url: target.url, sessionId: target.sessionId, path: target.path };
      this.seesBrowserEdits = !target.shared;
      this.notebook.reset();
      this.set("connecting", attachment);
      const controller = new AbortController();
      this.wake = controller;
      let dropped = false;
      try {
        const result = await streamSession({
          url: target.url,
          // marimo names a consumer after the session id it connected with and
          // does not echo a browser's own edits back to that id. Connecting
          // under our own id (marimo then finds the session by file) receives
          // them. That lookup takes the oldest session for the file, so when
          // several hold it, connect by the exact id and miss browser edits.
          sessionId: target.shared ? target.sessionId : this.consumerId,
          file: target.path,
          token: this.options.token,
          fetch: this.options.fetch,
          signal: controller.signal,
          onMessage: (op, data) => {
            const changed = this.notebook.apply(op, data);
            if (op === "kernel-ready") { this.scanned = true; this.set("connected", attachment); }
            if (changed) this.options.onChange();
          },
        });
        dropped = result.kind === "ended";
      } catch {
        // Aborted, refused or unreachable: rescan below.
      }
      this.scanned = true;
      if (this.stopped) break;
      this.set("disconnected", attachment);
      // A dropped stream reconnects quickly; a refused one waits for the next poll.
      if (!controller.signal.aborted) await this.pause(dropped ? 1000 : pollMs);
    }
    this.set("idle");
  }
}
