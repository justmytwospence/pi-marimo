// pi-bg integration, through pi's event bus (nothing happens without pi-bg).
//
// - A busy notebook is outside work pi-bg's `bg_wait` can wait on: `bg:external` with the id
//   `marimo:<file>` while a cell runs or is queued, then `done` (or `failed` with errors, or when
//   the notebook disconnects) with what the run took.
// - A long marimo-pair run is often a pi-bg job (`bg_run` of the execute-code call) that wakes the
//   agent when it ends. When every notebook of a kernel hold is driven by such a job, the hold's
//   "finished" notification is left out: the wake-up, and herdr's own done at the end of that
//   turn, already say so. pi-bg publishes its tasks as `bg:tasks` snapshots.
import { busy, holdValue } from "./core/hold.js";
import { basename } from "./core/io.js";
import { elapsed } from "./core/render.js";
import type { Followed } from "./core/watcher.js";

export interface EventBus {
  emit(channel: string, data: unknown): void;
}

/** What pi-bg's `bg:tasks` snapshot says about a task (only the fields used here). */
export interface BgTask {
  id: string;
  command: string;
  origin: string;
  status: string;
  willWake: boolean;
}

interface Run {
  id: string;
  since: number;
  label: string;
}

export class BgBridge {
  private tasks: BgTask[] = [];
  /** Held notebooks a waking pi-bg job drove at some point during the hold. */
  private covered = new Set<string>();
  private runs = new Map<string, Run>();

  constructor(
    private readonly events: EventBus | undefined,
    /** The followed notebooks a command's marimo-pair calls target, by path. */
    private readonly targeted: (command: string) => string[],
  ) {}

  onTasks(tasks: unknown): void {
    this.tasks = Array.isArray(tasks) ? (tasks as BgTask[]) : [];
  }

  /** Notebooks that a pi-bg job which will wake the agent is running cells in. */
  waking(): Set<string> {
    const out = new Set<string>();
    for (const t of this.tasks) {
      if (!t.willWake || typeof t.command !== "string") continue;
      for (const p of this.targeted(t.command)) out.add(p);
    }
    return out;
  }

  /** A hold began (or pi-bg's tasks changed during one): remember which of its notebooks are covered. */
  noteCovered(held: string[]): void {
    const waking = this.waking();
    for (const p of held) if (waking.has(p)) this.covered.add(p);
  }

  /** Whether a pi-bg wake-up reports the end of every one of these held notebooks. */
  coversAll(held: string[]): boolean {
    return held.length > 0 && held.every((p) => this.covered.has(p));
  }

  resetHold(): void {
    this.covered.clear();
  }

  /** `marimo:<file>`, or the path relative to the cwd when two followed notebooks share a name. */
  static id(f: Followed, all: Followed[], cwd: string): string {
    const name = basename(f.attachment.path);
    const shared = all.some((o) => o !== f && basename(o.attachment.path) === name);
    if (!shared) return `marimo:${name}`;
    const rel = f.attachment.path.startsWith(`${cwd}/`) ? f.attachment.path.slice(cwd.length + 1) : f.attachment.path;
    return `marimo:${rel}`;
  }

  /** Reports busy notebooks to pi-bg as outside work, and their end. */
  external(followed: Followed[], cwd: string, now = Date.now()): void {
    const seen = new Set<string>();
    for (const f of followed) {
      const path = f.attachment.path;
      seen.add(path);
      const run = this.runs.get(path);
      if (busy(f)) {
        const label = holdValue(f);
        if (run && run.label === label) continue;
        const id = run?.id ?? BgBridge.id(f, followed, cwd);
        this.runs.set(path, { id, since: run?.since ?? now, label });
        this.emit({ id, label, state: "running" });
        continue;
      }
      if (!run) continue;
      this.runs.delete(path);
      const connected = f.connection === "connected";
      const errors = connected ? f.notebook.errors().length : 0;
      const parts = [`ran ${elapsed(now - run.since)}`];
      if (errors) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
      if (!connected) parts.push("disconnected");
      this.emit({ id: run.id, label: basename(path), state: errors || !connected ? "failed" : "done", summary: parts.join(" · ") });
    }
    for (const [path, run] of this.runs) {
      if (seen.has(path)) continue;
      this.runs.delete(path);
      this.emit({ id: run.id, label: basename(path), state: "failed", summary: `ran ${elapsed(now - run.since)} · no longer followed` });
    }
  }

  /** The `bg_wait` ids of the notebooks running now. */
  runningIds(): string[] {
    return [...this.runs.values()].map((r) => r.id);
  }

  private emit(data: unknown): void {
    try {
      this.events?.emit("bg:external", data);
    } catch {
      // A failing listener must not break the watcher.
    }
  }
}
