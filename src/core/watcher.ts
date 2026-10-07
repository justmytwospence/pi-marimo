// Keeps the live state of the notebooks you work in current. It finds them,
// subscribes to each one's session as a kiosk consumer, follows them across
// page reloads (which change the session id) and server restarts, and reports
// every change. One of them is current: the pinned one, or in auto mode the
// one used most recently (a cell run or an edit).

import { type Cancellable, type Io, normalize, within } from "./io.js";
import { NotebookState } from "./notebook.js";
import { findNotebooks, type NotebookSession } from "./registry.js";
import type { Attachment } from "./render.js";
import { streamSession } from "./sse.js";

export type Mode =
  | { kind: "auto" }
  | { kind: "pinned"; path: string; url?: string }
  | { kind: "off" };

export type Connection = "idle" | "searching" | "connecting" | "connected" | "disconnected";

export interface WatcherOptions {
  io: Io;
  cwd: string;
  token?: string;
  extraUrls?: string[];
  pollMs?: number;
  /** Most notebooks followed at once in auto mode. */
  maxNotebooks?: number;
  onChange: () => void;
}

type Target = NotebookSession & { real: string; shared: boolean };

const consumerId = (): string => `pi-marimo-${Math.random().toString(36).slice(2, 10)}`;

/** One notebook's subscription, reconnecting until stopped. */
class Follower {
  readonly notebook = new NotebookState();
  connection: Connection = "connecting";
  /** Whether browser edits reach us (false when connected by the browser's own session id). */
  seesBrowserEdits = false;
  private stopped = false;
  private current?: Cancellable<unknown>;
  private sleep?: Cancellable<void>;
  private readonly id = consumerId();
  readonly loop: Promise<void>;

  constructor(public target: Target, private readonly options: WatcherOptions, private readonly changed: () => void) {
    this.loop = this.run();
  }

  get attachment(): Attachment {
    return { url: this.target.url, sessionId: this.target.sessionId, path: this.target.path };
  }

  /** Point at a new session for the same file (a page reload) and reconnect. */
  retarget(target: Target): void {
    if (target.sessionId === this.target.sessionId && target.shared === this.target.shared) return;
    this.target = target;
    this.current?.cancel();
    this.sleep?.cancel();
  }

  stop(): void {
    this.stopped = true;
    this.current?.cancel();
    this.sleep?.cancel();
  }

  private set(connection: Connection): void {
    if (connection === this.connection) return;
    this.connection = connection;
    this.changed();
  }

  private async run(): Promise<void> {
    const pollMs = this.options.pollMs ?? 5000;
    while (!this.stopped) {
      const target = this.target;
      this.seesBrowserEdits = !target.shared;
      this.notebook.reset();
      this.set("connecting");
      const stream = streamSession({
        io: this.options.io,
        url: target.url,
        // marimo names a consumer after the session id it connected with and
        // does not echo a browser's own edits back to that id. Connecting
        // under our own id (marimo then finds the session by file) receives
        // them. That lookup takes the oldest session for the file, so when
        // several hold it, connect by the exact id and miss browser edits.
        sessionId: target.shared ? target.sessionId : this.id,
        file: target.path,
        token: this.options.token,
        onMessage: (op, data) => {
          const changed = this.notebook.apply(op, data);
          if (op === "kernel-ready") this.set("connected");
          if (changed) this.changed();
        },
      });
      this.current = stream;
      const result = await stream.done.catch(() => ({ kind: "http-error" as const }));
      if (this.stopped) break;
      this.set("disconnected");
      if (target !== this.target) continue;
      // A dropped stream reconnects quickly; a refused one waits for the next poll.
      this.sleep = this.options.io.sleep(result.kind === "ended" ? 1000 : pollMs);
      await this.sleep.done;
    }
  }
}

export class MarimoWatcher {
  mode: Mode = { kind: "auto" };
  private followers = new Map<string, Follower>();
  private stopped = true;
  private scanned = false;
  private wake?: () => void;
  private loop?: Promise<void>;
  private realCwd?: string;
  private readonly realPaths = new Map<string, string>();
  private readonly empty = new NotebookState();

  constructor(private readonly options: WatcherOptions) {}

  /** The current notebook: the pinned one, or the one used most recently. */
  private get active(): Follower | undefined {
    let best: Follower | undefined;
    for (const f of this.followers.values()) {
      if (!best) { best = f; continue; }
      const rank = (x: Follower) => [x.connection === "connected" ? 1 : 0, x.notebook.running() ? 1 : 0, x.notebook.lastActivity];
      const [a, b] = [rank(f), rank(best)];
      if (a[0]! > b[0]! || (a[0] === b[0] && (a[1]! > b[1]! || (a[1] === b[1] && a[2]! > b[2]!)))) best = f;
    }
    return best;
  }

  get notebook(): NotebookState {
    return this.active?.notebook ?? this.empty;
  }

  get attachment(): Attachment | undefined {
    const active = this.active;
    if (active) return active.attachment;
    return this.mode.kind === "pinned" ? { url: this.mode.url ?? "", sessionId: "", path: this.mode.path } : undefined;
  }

  get connection(): Connection {
    const active = this.active;
    if (active) return active.connection;
    return this.mode.kind === "off" ? "idle" : "searching";
  }

  get seesBrowserEdits(): boolean {
    return this.active?.seesBrowserEdits ?? false;
  }

  /** The other notebooks followed besides the current one. */
  others(): Attachment[] {
    const active = this.active;
    return [...this.followers.values()].filter((f) => f !== active).map((f) => f.attachment);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  /** Stop, waiting at most a second for streams to close (a host may only end one at its next chunk). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    const loops = [...this.followers.values()].map((f) => { f.stop(); return f.loop; });
    this.followers.clear();
    await Promise.race([Promise.all([this.loop, ...loops]).catch(() => undefined), this.options.io.sleep(1000).done]);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.scanned = false;
    this.wake?.();
  }

  /** Wait (up to ms) for the first scan and any connection in progress, so a first request has the state. */
  async settle(ms: number): Promise<void> {
    const busy = () => !this.scanned || [...this.followers.values()].some((f) => f.connection === "connecting");
    for (let waited = 0; !this.stopped && busy() && waited < ms; waited += 50) {
      await this.options.io.sleep(50).done;
    }
  }

  /** Rescan now instead of at the next poll. */
  refresh(): void {
    this.wake?.();
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

  /** The notebooks to follow now, keyed by server and file. */
  private async targets(): Promise<Map<string, Target>> {
    const mode = this.mode;
    const out = new Map<string, Target>();
    if (mode.kind === "off") return out;
    const sessions = await this.list();
    const real = new Map<NotebookSession, string>();
    for (const s of sessions) real.set(s, await this.real(s.path));
    // Several sessions can hold one file (a closed tab's session lingers);
    // marimo lists them oldest first, so the newest wins.
    const add = (s: NotebookSession): void => {
      const path = real.get(s)!;
      const shared = sessions.filter((o) => o.url === s.url && real.get(o) === path).length > 1;
      out.set(`${s.url} ${path}`, { ...s, real: path, shared });
    };
    if (mode.kind === "pinned") {
      const path = await this.real(mode.path);
      const matches = sessions.filter((s) => real.get(s) === path);
      const chosen = matches.filter((s) => s.url === mode.url).pop() ?? matches.pop();
      if (chosen) add(chosen);
      return out;
    }
    this.realCwd ??= await this.real(this.options.cwd);
    const cwd = this.realCwd;
    // Under the cwd, but not in a hidden directory there (.worktrees, .claude/worktrees: other checkouts).
    const local = sessions.filter((s) => {
      const path = real.get(s)!;
      return within(path, cwd) && !path.slice(cwd.length).split("/").slice(0, -1).some((part) => part.startsWith("."));
    });
    for (const s of local) add(s);
    const max = this.options.maxNotebooks ?? 8;
    return new Map([...out].slice(0, max));
  }

  private reconcile(targets: Map<string, Target>): void {
    let changed = false;
    for (const [key, follower] of this.followers) {
      if (targets.has(key)) continue;
      follower.stop();
      this.followers.delete(key);
      changed = true;
    }
    for (const [key, target] of targets) {
      const follower = this.followers.get(key);
      if (follower) follower.retarget(target);
      else {
        this.followers.set(key, new Follower(target, this.options, () => this.options.onChange()));
        changed = true;
      }
    }
    if (changed) this.options.onChange();
  }

  private async run(): Promise<void> {
    const pollMs = this.options.pollMs ?? 5000;
    while (!this.stopped) {
      const targets = await this.targets().catch(() => undefined);
      if (this.stopped) break;
      if (targets) this.reconcile(targets);
      if (!this.scanned) { this.scanned = true; this.options.onChange(); }
      const sleep = this.options.io.sleep(this.mode.kind === "off" ? 60_000 : pollMs);
      this.wake = sleep.cancel;
      await sleep.done;
    }
  }
}
