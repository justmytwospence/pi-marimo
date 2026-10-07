// Keeps one notebook's live state current: finds the notebook, subscribes to
// its session as a kiosk consumer, follows it across page reloads (which change
// the session id) and server restarts, and reports every change.

import { type Io, normalize, within } from "./io.js";
import { NotebookState } from "./notebook.js";
import { findNotebooks, type NotebookSession } from "./registry.js";
import type { Attachment } from "./render.js";
import { streamSession } from "./sse.js";

export type Mode =
  | { kind: "auto" }
  | { kind: "pinned"; path: string; url?: string }
  | { kind: "off" };

export type Connection = "idle" | "searching" | "ambiguous" | "connecting" | "connected" | "disconnected";

export interface WatcherOptions {
  io: Io;
  cwd: string;
  token?: string;
  extraUrls?: string[];
  pollMs?: number;
  onChange: () => void;
}

type Target = NotebookSession & { shared: boolean };

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
  private wake?: () => void;
  private loop?: Promise<void>;
  private realCwd?: string;
  private readonly realPaths = new Map<string, string>();

  constructor(private readonly options: WatcherOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop?.catch(() => undefined);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.wake?.();
  }

  /** Wait (up to ms) for the first scan and any connection in progress, so a first request has the state. */
  async settle(ms: number): Promise<void> {
    for (let waited = 0; !this.stopped && (!this.scanned || this.connection === "connecting") && waited < ms; waited += 50) {
      await this.options.io.sleep(50).done;
    }
  }

  /** Rescan now instead of at the next poll. */
  refresh(): void {
    if (this.connection !== "connected" && this.connection !== "connecting") this.wake?.();
  }

  async list(): Promise<NotebookSession[]> {
    return findNotebooks(this.options.io, { token: this.options.token, extraUrls: this.options.extraUrls });
  }

  private async real(path: string): Promise<string> {
    const absolute = normalize(path, this.options.cwd);
    let real = this.realPaths.get(absolute);
    if (real === undefined) {
      real = normalize(await this.options.io.realpath(absolute));
      this.realPaths.set(absolute, real);
    }
    return real;
  }

  private set(connection: Connection, attachment?: Attachment): void {
    const changed = connection !== this.connection || attachment?.sessionId !== this.attachment?.sessionId || attachment?.path !== this.attachment?.path;
    this.connection = connection;
    this.attachment = attachment;
    if (changed) this.options.onChange();
  }

  private async resolveTarget(): Promise<Target | undefined> {
    const mode = this.mode;
    if (mode.kind === "off") return undefined;
    const sessions = await this.list();
    // marimo reports real paths; resolve ours the same way (macOS /tmp is /private/tmp).
    const real = new Map<NotebookSession, string>();
    for (const s of sessions) real.set(s, await this.real(s.path));
    const shared = (target: NotebookSession | undefined): Target | undefined => target && {
      ...target,
      shared: sessions.filter((s) => s.url === target.url && real.get(s) === real.get(target)).length > 1,
    };
    // Several sessions can hold one file (a closed tab's session lingers);
    // marimo lists them oldest first, so the newest wins.
    if (mode.kind === "pinned") {
      const path = await this.real(mode.path);
      const matches = sessions.filter((s) => real.get(s) === path).reverse();
      return shared(matches.find((s) => s.url === mode.url) ?? matches[0]);
    }
    this.realCwd ??= await this.real(this.options.cwd);
    const local = sessions.filter((s) => within(real.get(s)!, this.realCwd!));
    const unique = [...new Map(local.map((s) => [real.get(s)!, s])).values()];
    this.candidates = unique.length > 1 ? unique : [];
    return shared(unique.length === 1 ? unique[0] : undefined);
  }

  private async pause(ms: number): Promise<void> {
    const sleep = this.options.io.sleep(ms);
    this.wake = sleep.cancel;
    await sleep.done;
  }

  private async run(): Promise<void> {
    const pollMs = this.options.pollMs ?? 5000;
    while (!this.stopped) {
      if (this.mode.kind === "off") {
        this.notebook.reset();
        this.scanned = true;
        this.set("idle");
        await this.pause(60_000);
        continue;
      }
      const target = await this.resolveTarget().catch(() => undefined);
      if (this.stopped) break;
      if (!target) {
        this.scanned = true;
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
      let cancelled = false;
      const stream = streamSession({
        io: this.options.io,
        url: target.url,
        // marimo names a consumer after the session id it connected with and
        // does not echo a browser's own edits back to that id. Connecting
        // under our own id (marimo then finds the session by file) receives
        // them. That lookup takes the oldest session for the file, so when
        // several hold it, connect by the exact id and miss browser edits.
        sessionId: target.shared ? target.sessionId : this.consumerId,
        file: target.path,
        token: this.options.token,
        onMessage: (op, data) => {
          const changed = this.notebook.apply(op, data);
          if (op === "kernel-ready") { this.scanned = true; this.set("connected", attachment); }
          if (changed) this.options.onChange();
        },
      });
      this.wake = () => { cancelled = true; stream.cancel(); };
      const result = await stream.done.catch(() => ({ kind: "http-error" as const }));
      this.scanned = true;
      if (this.stopped) break;
      this.set("disconnected", attachment);
      // A dropped stream reconnects quickly; a refused one waits for the next poll.
      if (!cancelled) await this.pause(result.kind === "ended" ? 1000 : pollMs);
    }
    this.set("idle");
  }
}
