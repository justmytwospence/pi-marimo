// Official CLI clients belong to the process, not a tool call, chat turn or UI.
// Aborting a wait must never close a client: that can interrupt scratch Python.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { ExecutionWaveObserver, type WaveSnapshot } from "./execution-observer.js";
import { sameServer } from "./touch.js";

export interface ExecutionTarget { url: string; path: string; canonicalPath: string; sessionId: string }
export interface ExecutionOwner { sessionId: string; anchorId: string }
export type ExecutionState = "starting" | "running" | "reconnecting" | "succeeded" | "failed" | "interrupted" | "unknown";
export interface ExecutionRecord {
  version: 1;
  id: string;
  owner: ExecutionOwner;
  target: ExecutionTarget;
  kind: "execute" | "watch";
  label: string;
  state: ExecutionState;
  startedAt: number;
  endedAt?: number;
  notification: "explicit" | "automatic" | "none";
  delivery: "pending" | "queued" | "delivered" | "suppressed";
  /** Only detached records may be queued for a follow-up. Persist this on detach. */
  detached: boolean;
  exitCode?: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  stdoutOmittedBytes: number;
  stderrOmittedBytes: number;
  summary?: string;
  /** Independent notebook evidence, not the native request's result. */
  errors: string[];
  blocked: string[];
}
export interface ExecutionActivity {
  running: boolean;
  startedAt?: number;
  detail: string[];
  failed?: boolean;
  endedAt?: number;
  summary?: string;
}
export interface ExecutionStartSpec {
  id: string;
  owner: ExecutionOwner;
  target: ExecutionTarget;
  code: string;
  label: string;
  command: string[];
  cwd: string;
  subscribed: boolean;
  /** Recheck captured session identity and document busy state immediately before dispatch. */
  isCurrent?: () => boolean;
}
export interface ExecutionWatchSpec {
  id: string;
  owner: ExecutionOwner;
  target: ExecutionTarget;
  seedBusyCells: string[];
  subscribed: boolean;
}
export interface WaveObserver {
  start(): void;
  stop(): void;
  snapshot(): WaveSnapshot;
}
export type ExecutionObserverOptions = ConstructorParameters<typeof ExecutionWaveObserver>[0];
export interface ExecutionHostOptions {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => number;
  id?: () => string;
  observerFactory?: (options: ExecutionObserverOptions) => WaveObserver;
  /** Injected spawns default to child.kill, so fake PIDs are never signalled by
   * process.kill. Real injected runners may opt into group cleanup with this
   * hook; pid is the positive leader PID (default runner signals -pid). */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export function isExecutionTerminal(state: ExecutionState): boolean {
  return state !== "starting" && state !== "running" && state !== "reconnecting";
}
/** Exact observer target. Native exclusivity deliberately ignores the captured session ID. */
export function executionTargetKey(target: ExecutionTarget): string {
  return JSON.stringify([serverKey(target.url), target.canonicalPath, target.sessionId]);
}
function serverKey(url: string): string {
  return url.replace(/\/+$/, "").replace("://localhost", "://127.0.0.1").replace("://[::1]", "://127.0.0.1");
}
function sameNotebook(a: ExecutionTarget, b: ExecutionTarget): boolean {
  return sameServer(a.url, b.url) && a.canonicalPath === b.canonicalPath;
}
function sameOwner(a: ExecutionOwner, b: ExecutionOwner): boolean {
  return a.sessionId === b.sessionId && a.anchorId === b.anchorId;
}
function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
}

const MAX_BYTES = 16 * 1024;
const MAX_LINES = 200;
/** A draining streaming decoder: neither split UTF-8 nor arbitrarily large output grows memory. */
class Tail {
  private readonly decoder = new StringDecoder("utf8");
  text = "";
  omitted = 0;
  push(chunk: Buffer | string): void {
    this.append(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }
  end(): void { this.append(this.decoder.end()); }
  private append(value: string): void {
    this.text += value;
    const before = Buffer.byteLength(this.text);
    const lines = this.text.split("\n");
    // A final newline terminates the last line; it is not an additional empty line.
    const count = lines.length - (this.text.endsWith("\n") ? 1 : 0);
    if (count > MAX_LINES) this.text = lines.slice(count - MAX_LINES).join("\n");
    if (Buffer.byteLength(this.text) > MAX_BYTES) {
      const bytes = Buffer.from(this.text);
      let offset = bytes.length - MAX_BYTES;
      while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
      this.text = bytes.subarray(offset).toString("utf8");
    }
    this.omitted += before - Buffer.byteLength(this.text);
  }
}

function boundedEvidence(values: string[]): string[] {
  const tail = new Tail();
  tail.push([...new Set(values.map(clean))].join("\n"));
  tail.end();
  return tail.text ? tail.text.split("\n") : [];
}

/** Explicit whitelist also protects persisted snapshots from accidentally retaining code or credentials. */
function copy(record: ExecutionRecord): ExecutionRecord {
  return {
    version: 1, id: record.id,
    owner: { sessionId: record.owner.sessionId, anchorId: record.owner.anchorId },
    target: { url: record.target.url, path: record.target.path, canonicalPath: record.target.canonicalPath, sessionId: record.target.sessionId },
    kind: record.kind, label: record.label, state: record.state, startedAt: record.startedAt, endedAt: record.endedAt,
    notification: record.notification, delivery: record.delivery, detached: record.detached,
    exitCode: record.exitCode, signal: record.signal,
    stdout: clean(record.stdout), stderr: clean(record.stderr),
    stdoutOmittedBytes: record.stdoutOmittedBytes, stderrOmittedBytes: record.stderrOmittedBytes,
    summary: record.summary === undefined ? undefined : clean(record.summary), errors: boundedEvidence(record.errors), blocked: boundedEvidence(record.blocked),
  };
}
interface Entry {
  record: ExecutionRecord;
  child?: ChildProcess;
  poolKey?: string;
  waveId?: string;
  interrupted?: boolean;
  /** Retain a native result until the foreground caller chooses inline/detached. */
  foreground?: boolean;
}
interface Pool {
  target: ExecutionTarget;
  observer: WaveObserver;
  records: Set<string>;
  policies: Set<string>;
  waiters: Set<() => void>;
  snapshot: WaveSnapshot;
  /** Current-wave claims outlive evicted delivered records, without retaining output. */
  represented: Map<string, Set<string>>;
}
interface Policy { owner: ExecutionOwner; keys: Set<string> }
const BUSY = "Kernel is busy; use marimo_watch to subscribe without sending more Python.";

export class ExecutionHost {
  private readonly records = new Map<string, Entry>();
  private readonly pools = new Map<string, Pool>();
  private readonly policies = new Map<string, Policy>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly waits = new Set<() => void>();
  private readonly probes = new Map<string, Promise<void>>();
  private readonly probeChildren = new Set<ChildProcess>();
  private readonly stopProbes = new Map<ChildProcess, () => void>();
  private readonly children = new Set<ChildProcess>();
  private readonly spawn: NonNullable<ExecutionHostOptions["spawn"]>;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly observerFactory: NonNullable<ExecutionHostOptions["observerFactory"]>;
  private readonly killGroup?: ExecutionHostOptions["killGroup"];
  private disposed = false;

  constructor(options: ExecutionHostOptions = {}) {
    this.spawn = options.spawn ?? spawn;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.observerFactory = options.observerFactory ?? ((o) => new ExecutionWaveObserver(o));
    this.killGroup = options.killGroup ?? (options.spawn ? undefined : (pid, signal) => { process.kill(-pid, signal); });
  }

  start(spec: ExecutionStartSpec): ExecutionRecord {
    this.assertOpen();
    if (!spec.code.trim()) throw new Error("Python code must be nonempty. Nothing was submitted.");
    if (!spec.command.length || spec.command.some((s) => typeof s !== "string" || !s)) throw new Error("Configure execution.command. Nothing was submitted.");
    this.reserve(spec.id, spec.owner);
    if (this.nativeBusy(spec.target)) throw new Error(BUSY);
    const record = this.newRecord(spec.id, spec.owner, spec.target, "execute", spec.label || "Python execution", spec.subscribed ? "explicit" : "none");
    const entry: Entry = { record, foreground: true };
    this.records.set(record.id, entry);
    // Capture argv/cwd/identity now, not mutable adapter state after the asynchronous probe.
    const captured = { ...spec, command: [...spec.command], owner: { ...spec.owner }, target: { ...spec.target } };
    this.changed(record);
    void this.launch(entry, captured);
    return copy(record);
  }

  /** Exact-owner dedupe here; the adapter validates ancestry before reusing a
   * different task registration anchor in the same active branch. */
  async watch(spec: ExecutionWatchSpec): Promise<ExecutionRecord | undefined> {
    this.assertOpen();
    const existing = this.representative(spec.owner, spec.target);
    if (existing) return spec.subscribed ? this.subscribe(existing.record.owner, existing.record.id) : copy(existing.record);
    this.reserve(spec.id, spec.owner);
    const pool = this.pool(spec.target, spec.seedBusyCells);
    // Retain a read-only observer while obtaining up to one second of evidence.
    const hold = () => {};
    pool.waiters.add(hold);
    try {
      const initialWave = pool.snapshot.wave;
      // A retained terminal wave is history, not something a new watch may subscribe to.
      if (!initialWave || (initialWave.state !== "running" && initialWave.state !== "reconnecting")) await this.waitForEvidence(pool, 1000, initialWave?.id);
      const observed = pool.snapshot.wave;
      if (this.disposed || !observed || (observed.id === initialWave?.id && initialWave.state !== "running" && initialWave.state !== "reconnecting")) return undefined;
      const raced = this.representative(spec.owner, spec.target);
      if (raced) return spec.subscribed ? this.subscribe(raced.record.owner, raced.record.id) : copy(raced.record);
      this.reserve(spec.id, spec.owner);
      const record = this.newRecord(spec.id, spec.owner, spec.target, "watch", "Notebook execution", spec.subscribed ? "explicit" : "none");
      record.detached = true;
      const entry: Entry = { record, poolKey: executionTargetKey(spec.target), waveId: observed.id };
      this.records.set(record.id, entry);
      pool.records.add(record.id);
      // A seeded policy replay can race explicit watch registration. The explicit
      // task wins without rewriting the policy record's immutable ownership.
      for (const other of this.records.values()) {
        if (other !== entry && other.record.owner.sessionId === spec.owner.sessionId && other.poolKey === entry.poolKey && other.waveId === entry.waveId && other.record.notification === "automatic") {
          other.record.notification = "none";
          other.record.delivery = "suppressed";
          this.changed(other.record);
        }
      }
      this.applyWave(entry, pool.snapshot);
      this.changed(record);
      return copy(record);
    } finally {
      pool.waiters.delete(hold);
      this.releasePool(executionTargetKey(spec.target));
    }
  }

  get(owner: ExecutionOwner, id: string): ExecutionRecord { return copy(this.owned(owner, id).record); }
  list(sessionId: string, activeAnchors: ReadonlySet<string>): ExecutionRecord[] {
    return [...this.records.values()].reverse().map((e) => e.record)
      .filter((r) => r.owner.sessionId === sessionId && activeAnchors.has(r.owner.anchorId))
      .sort((a, b) => b.startedAt - a.startedAt).map(copy);
  }
  unsubscribe(owner: ExecutionOwner, id: string): ExecutionRecord {
    const entry = this.owned(owner, id);
    entry.record.notification = "none";
    entry.record.delivery = "suppressed";
    this.changed(entry.record);
    return copy(entry.record);
  }
  /** Rearm a live handle after unsubscribe/subscribe:false. The adapter first
   * validates active-branch ancestry; ownership and CLI authority never change. */
  subscribe(owner: ExecutionOwner, id: string): ExecutionRecord {
    const entry = this.owned(owner, id);
    if (isExecutionTerminal(entry.record.state)) throw new Error(`Execution is already terminal; cannot subscribe: ${id}`);
    entry.record.notification = "explicit";
    entry.record.delivery = "pending";
    entry.record.detached = true;
    this.changed(entry.record);
    entry.foreground = false;
    return copy(entry.record);
  }
  /** Detached is a reporting transition, never computation cancellation. */
  markDetached(id: string): void {
    const entry = this.required(id);
    const record = entry.record;
    record.detached = true;
    this.changed(record);
    entry.foreground = false;
    this.prune(record.owner.sessionId, id);
  }
  /** Atomic claim used by the adapter before it enqueues a deterministic completion ID. */
  markQueued(id: string): void {
    const record = this.required(id).record;
    if (!record.detached || !isExecutionTerminal(record.state) || record.notification === "none" || record.delivery !== "pending") return;
    record.delivery = "queued";
    this.changed(record);
  }
  /** Retry notification only after a runtime rebind confirms the old Pi queue is gone. */
  retryDelivery(id: string): void {
    const record = this.required(id).record;
    if (isExecutionTerminal(record.state) && record.detached && record.notification !== "none" && record.delivery === "queued") {
      record.delivery = "pending";
      this.changed(record);
    }
  }
  markDelivered(id: string): void {
    const record = this.required(id).record;
    if (record.delivery !== "queued") return;
    record.delivery = "delivered";
    this.changed(record);
    this.prune(record.owner.sessionId, id);
  }
  /** Synchronous inline claim wins over detachment/queueing; no duplicate follow-up. */
  markInline(id: string): void {
    const entry = this.required(id);
    const record = entry.record;
    if (record.delivery === "pending") {
      record.delivery = "delivered";
      record.detached = false;
      this.changed(record);
    }
    entry.foreground = false;
    this.prune(record.owner.sessionId, id);
  }

  /** Undefined means foreground yield or AbortSignal only. It NEVER stops the CLI child. */
  waitForResult(id: string, ms: number, signal?: AbortSignal): Promise<ExecutionRecord | undefined> {
    const entry = this.required(id);
    if (signal?.aborted) return Promise.resolve(undefined);
    if (isExecutionTerminal(entry.record.state)) return Promise.resolve(copy(entry.record));
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value?: ExecutionRecord) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.waits.delete(check);
        resolve(value);
      };
      const check = () => { if (isExecutionTerminal(entry.record.state)) finish(copy(entry.record)); else if (this.disposed) finish(); };
      const abort = () => finish();
      this.waits.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, Math.max(0, ms));
    });
  }

  observeAll(owner: ExecutionOwner, targets: ExecutionTarget[], enabled: boolean): void {
    this.assertOpen();
    const key = JSON.stringify([owner.sessionId, owner.anchorId]);
    const previous = this.policies.get(key);
    const wanted = new Set(enabled ? targets.map(executionTargetKey) : []);
    for (const old of previous?.keys ?? []) {
      if (wanted.has(old)) continue;
      this.pools.get(old)?.policies.delete(key);
      this.releasePool(old);
    }
    if (!enabled || !targets.length) { this.policies.delete(key); return; }
    this.policies.set(key, { owner: { ...owner }, keys: wanted });
    for (const target of targets) {
      const pool = this.pool(target, []);
      pool.policies.add(key);
      this.onWave(executionTargetKey(target), pool.snapshot);
    }
  }

  subscribeOwner(sessionId: string, onChange: () => void): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) this.listeners.set(sessionId, listeners = new Set());
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
      if (!listeners.size) this.listeners.delete(sessionId);
    };
  }

  restore(records: ExecutionRecord[]): void {
    for (const saved of records) {
      if (saved.version !== 1 || this.records.has(saved.id)) continue; // Same-process authority always wins.
      const record = copy(saved);
      // Bound imported tails too; durable metadata never imports a child or execution source.
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = new Tail(); tail.push(record[stream]); tail.end();
        record[stream] = clean(tail.text);
        record[`${stream}OmittedBytes`] += tail.omitted;
      }
      if (!isExecutionTerminal(record.state)) {
        record.state = "unknown";
        record.endedAt = this.now();
        record.detached = true;
        record.summary = "Execution ownership was lost after process restart. Outcome unknown; nothing was resubmitted.";
      }
      this.records.set(record.id, { record });
      this.changed(record);
      this.prune(record.owner.sessionId);
    }
  }

  needsKernel(url: string, path?: string): boolean {
    return [...this.records.values()].some(({ record, child }) => (!isExecutionTerminal(record.state) || !!child) && sameServer(record.target.url, url)
      && (!path || record.target.path === path || record.target.canonicalPath === path));
  }
  activity(sessionId: string, target: ExecutionTarget): ExecutionActivity {
    const records = [...this.records.values()].reverse().map((e) => e.record)
      .filter((r) => r.owner.sessionId === sessionId && sameNotebook(r.target, target)).sort((a, b) => b.startedAt - a.startedAt);
    const active = records.filter((r) => !isExecutionTerminal(r.state));
    const terminal = records.find((r) => r.kind === "execute" && isExecutionTerminal(r.state));
    return {
      running: active.length > 0,
      startedAt: active.length ? Math.min(...active.map((r) => r.startedAt)) : terminal?.startedAt,
      detail: [...(active.some((r) => r.kind === "execute") ? ["executing Python"] : []),
        ...(active.some((r) => r.notification !== "none" && r.delivery !== "suppressed") ? ["resume armed"] : [])],
      failed: !!terminal && terminal.state !== "succeeded", endedAt: terminal?.endedAt, summary: terminal?.summary,
    };
  }

  /** Process exit/test isolation only. Kills ONLY this host's clients, never notebook servers.
   * Closing an official client may interrupt scratch execution; no exit-survival guarantee. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of [...this.probeChildren]) {
      this.terminate(child, "SIGTERM");
      this.stopProbes.get(child)?.();
    }
    for (const child of this.children) this.terminate(child, "SIGTERM");
    for (const entry of this.records.values()) {
      if (!isExecutionTerminal(entry.record.state)) this.finish(entry, "unknown", "Execution client closed with the Pi process; outcome unknown.");
    }
    for (const pool of this.pools.values()) {
      for (const wake of pool.waiters) wake();
      pool.observer.stop();
    }
    this.pools.clear();
    this.policies.clear();
    for (const wake of [...this.waits]) wake();
    this.listeners.clear();
  }

  private terminate(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && child.pid && this.killGroup) {
      try { this.killGroup(child.pid, signal); return; } catch { /* already gone or group unavailable */ }
    }
    try { child.kill(signal); } catch { /* already gone */ }
  }
  private assertOpen(): void { if (this.disposed) throw new Error("Execution host is disposed."); }
  private required(id: string): Entry {
    const entry = this.records.get(id);
    if (!entry) throw new Error(`Unknown execution: ${id}`);
    return entry;
  }
  private owned(owner: ExecutionOwner, id: string): Entry {
    const entry = this.required(id);
    if (!sameOwner(owner, entry.record.owner)) throw new Error(`Unknown execution for this session/branch: ${id}`);
    return entry;
  }
  private reserve(id: string, owner: ExecutionOwner): void {
    if (this.records.has(id)) throw new Error(`Execution ID already registered: ${id}`);
    // Registration anchors are per-task; bound the whole owning session, not each fresh anchor.
    const active = [...this.records.values()].filter((e) => e.record.owner.sessionId === owner.sessionId && (!isExecutionTerminal(e.record.state) || !!e.child));
    if (active.length >= 32) throw new Error("Too many active executions (32); nothing was submitted.");
  }
  private newRecord(id: string, owner: ExecutionOwner, target: ExecutionTarget, kind: ExecutionRecord["kind"], label: string, notification: ExecutionRecord["notification"]): ExecutionRecord {
    return { version: 1, id, owner: { ...owner }, target: { ...target }, kind, label: clean(label), state: "starting", startedAt: this.now(),
      notification, delivery: notification === "none" ? "suppressed" : "pending", detached: false,
      stdout: "", stderr: "", stdoutOmittedBytes: 0, stderrOmittedBytes: 0, errors: [], blocked: [] };
  }
  private nativeBusy(target: ExecutionTarget, except?: string): boolean {
    return [...this.records.values()].some(({ record, child }) => record.id !== except && record.kind === "execute" && (!isExecutionTerminal(record.state) || !!child) && sameNotebook(record.target, target));
  }
  private representative(owner: ExecutionOwner, target: ExecutionTarget, waveId?: string, sessionWide = false): Entry | undefined {
    return [...this.records.values()].find((e) => (sessionWide ? e.record.owner.sessionId === owner.sessionId : sameOwner(e.record.owner, owner)) && executionTargetKey(e.record.target) === executionTargetKey(target)
      && (waveId ? e.waveId === waveId || (!isExecutionTerminal(e.record.state) && e.record.kind === "execute") : !isExecutionTerminal(e.record.state)));
  }
  private changed(record: ExecutionRecord): void {
    for (const wake of [...this.waits]) wake();
    for (const listener of [...(this.listeners.get(record.owner.sessionId) ?? [])]) {
      try { listener(); } catch { /* A stale runtime callback must not stop supervision. */ }
    }
  }
  private finish(entry: Entry, state: ExecutionState, summary: string, endedAt = this.now()): void {
    if (isExecutionTerminal(entry.record.state)) return;
    entry.record.state = state;
    entry.record.endedAt = endedAt;
    entry.record.summary = clean(summary);
    if (entry.poolKey) {
      this.pools.get(entry.poolKey)?.records.delete(entry.record.id);
      this.releasePool(entry.poolKey);
    }
    this.changed(entry.record);
    this.prune(entry.record.owner.sessionId, entry.record.id);
  }
  private prune(sessionId: string, protectedId?: string): void {
    const completed = [...this.records.values()].map((e) => e.record)
      .filter((r) => r.owner.sessionId === sessionId && isExecutionTerminal(r.state)).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    let excess = completed.length - 100;
    for (const record of completed) {
      if (excess <= 0) break;
      const entry = this.records.get(record.id)!;
      if (record.id === protectedId || entry.foreground || entry.child || record.delivery === "pending" || record.delivery === "queued") continue;
      this.records.delete(record.id);
      excess--;
    }
  }

  private async launch(entry: Entry, spec: ExecutionStartSpec): Promise<void> {
    try {
      if (this.disposed) return;
      await this.probe(spec.command, spec.cwd);
      if (this.disposed || isExecutionTerminal(entry.record.state)) return;
      if (spec.isCurrent && !spec.isCurrent()) throw new Error("Notebook target changed or kernel is busy. Nothing was submitted.");
      if (this.nativeBusy(spec.target, spec.id)) throw new Error(BUSY);
      // Native evidence observers are never execution authority.
      try {
        const pool = this.pool(spec.target, []);
        entry.poolKey = executionTargetKey(spec.target);
        pool.records.add(spec.id);
        if (pool.snapshot.wave?.state === "running" || pool.snapshot.wave?.state === "reconnecting") this.applyWave(entry, pool.snapshot);
      } catch { /* CLI remains authoritative if read-only evidence cannot attach. */ }
      if (spec.isCurrent && !spec.isCurrent()) throw new Error("Notebook target changed or kernel is busy. Nothing was submitted.");
      const [bin, ...prefix] = spec.command;
      const child = this.spawn(bin!, [...prefix, "pair", "execute", "--url", spec.target.url, "--session", spec.target.sessionId, "--code-file", "-", "--stream"],
        { cwd: spec.cwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      entry.child = child;
      this.children.add(child);
      entry.record.state = "running";
      const stdout = new Tail();
      const stderr = new Tail();
      const take = () => {
        entry.record.stdout = clean(stdout.text); entry.record.stderr = clean(stderr.text);
        entry.record.stdoutOmittedBytes = stdout.omitted; entry.record.stderrOmittedBytes = stderr.omitted;
        this.changed(entry.record);
      };
      child.stdout?.on("data", (chunk: Buffer | string) => { stdout.push(chunk); take(); });
      child.stderr?.on("data", (chunk: Buffer | string) => { stderr.push(chunk); take(); });
      const lostOutput = (error: Error) => this.finish(entry, "unknown", `Execution client transport was lost; outcome unknown. Do not retry automatically. ${error.message}`);
      child.stdout?.on("error", lostOutput);
      child.stderr?.on("error", lostOutput);
      child.stdin?.on("error", () => {
        // EPIPE may mean submission already reached marimo. Drain the client and await its exit.
      });
      child.once("error", (error) => {
        this.finish(entry, child.pid ? "unknown" : "failed", child.pid
          ? `Execution transport failed; outcome unknown. Do not retry automatically. ${error.message}`
          : `Nothing was submitted: ${error.message}. Check execution.command.`);
      });
      child.once("close", (code, signal) => {
        stdout.end(); stderr.end(); take();
        entry.child = undefined;
        this.children.delete(child);
        entry.record.exitCode = code; entry.record.signal = signal;
        const state = !signal && code === 0 ? "succeeded" : !signal && code === 1 ? (entry.interrupted ? "interrupted" : "failed") : "unknown";
        const guidance = entry.record.stderr.trim();
        const summary = state === "succeeded" ? "Python request succeeded; notebook descendants may still be running or have errors."
          : state === "interrupted" ? "Python execution was interrupted."
            : state === "failed" ? "Python execution failed."
              : "Execution outcome unknown. Inspect the notebook; do not retry automatically.";
        const alreadyTerminal = isExecutionTerminal(entry.record.state);
        this.finish(entry, state, `${summary}${guidance ? `\n${guidance}` : ""}`);
        if (alreadyTerminal) this.changed(entry.record);
        this.prune(entry.record.owner.sessionId, entry.record.id);
      });
      this.changed(entry.record);
      child.stdin?.end(spec.code); // One submission, never retried; source is not retained in records.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish(entry, entry.child ? "unknown" : "failed", entry.child
        ? `Execution transport failed; outcome unknown. Do not retry automatically. ${message}`
        : `Nothing was submitted. ${message} Check execution.command.`);
    }
  }

  private probe(command: string[], cwd: string): Promise<void> {
    const key = JSON.stringify([command, cwd]);
    const cached = this.probes.get(key);
    if (cached) return cached;
    const promise = new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try { child = this.spawn(command[0]!, [...command.slice(1), "pair", "execute", "--help"], { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { reject(error); return; }
      this.probeChildren.add(child);
      const output = new Tail();
      const take = (chunk: Buffer | string) => output.push(chunk);
      child.stdout?.on("data", take); child.stderr?.on("data", take);
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stopProbes.delete(child);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        this.terminate(child, "SIGKILL");
        done(new Error("marimo pair execute --help timed out (5s); configure execution.command."));
      }, 5000);
      this.stopProbes.set(child, () => done(new Error("Execution host was disposed; nothing was submitted.")));
      child.once("error", (e) => done(e));
      child.stdout?.on("error", (e) => done(e));
      child.stderr?.on("error", (e) => done(e));
      child.once("close", (code, signal) => {
        this.probeChildren.delete(child);
        output.end();
        const flags = ["--url", "--session", "--code-file", "--stream"];
        done(code === 0 && !signal && flags.every((flag) => new RegExp(`${flag}(?=[\\s=,]|$)`, "u").test(output.text)) ? undefined
          : new Error("Official marimo pair execute CLI lacks required --url, --session, --code-file - and --stream support; configure execution.command."));
      });
    });
    this.probes.set(key, promise);
    void promise.catch(() => { if (this.probes.get(key) === promise) this.probes.delete(key); });
    return promise;
  }

  private pool(target: ExecutionTarget, seedBusyCells: string[]): Pool {
    const key = executionTargetKey(target);
    const existing = this.pools.get(key);
    if (existing && seedBusyCells.length && (!existing.snapshot.wave || (existing.snapshot.wave.state !== "running" && existing.snapshot.wave.state !== "reconnecting")) && !existing.records.size && !existing.waiters.size) {
      // Seed evidence from the UI can arrive before an idle policy stream has replayed it.
      // Replace only an idle observer, retaining its policy refs, never a live task's stream.
      this.pools.delete(key);
      existing.observer.stop();
    } else if (existing) return existing;
    // Install the pool before start: fake observers and replay may call back synchronously.
    const pool: Pool = { target: { ...target }, observer: undefined!, records: new Set(), policies: existing?.policies ?? new Set(), waiters: new Set(), snapshot: { connection: "connecting" }, represented: new Map() };
    const observer = this.observerFactory({ target: { url: target.url, path: target.path, sessionId: target.sessionId }, now: this.now, id: this.id,
      seedBusyCells: [...seedBusyCells], onChange: (snapshot) => { if (this.pools.get(key) === pool) this.onWave(key, snapshot); } });
    pool.observer = observer;
    this.pools.set(key, pool);
    try {
      observer.start();
      this.onWave(key, observer.snapshot());
    } catch (error) {
      this.pools.delete(key);
      observer.stop();
      throw error;
    }
    return pool;
  }
  private releasePool(key: string): void {
    const pool = this.pools.get(key);
    if (!pool || pool.records.size || pool.policies.size || pool.waiters.size) return;
    this.pools.delete(key); // Guard callbacks before stop.
    pool.observer.stop();
  }
  private waitForEvidence(pool: Pool, ms: number, previousWaveId?: string): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => { if ((pool.snapshot.wave && pool.snapshot.wave.id !== previousWaveId) || this.disposed) finish(); };
      const finish = () => { clearTimeout(timer); pool.waiters.delete(wake); resolve(); };
      const timer = setTimeout(finish, ms);
      pool.waiters.add(wake);
    });
  }
  private onWave(key: string, snapshot: WaveSnapshot): void {
    if (this.disposed) return;
    const pool = this.pools.get(key);
    if (!pool) return;
    pool.snapshot = snapshot;
    const wave = snapshot.wave;
    if (wave) {
      // Only the current wave needs a compact suppression/representation ledger.
      for (const old of pool.represented.keys()) if (old !== wave.id) pool.represented.delete(old);
      for (const id of [...pool.records]) {
        const entry = this.records.get(id);
        if (entry) this.applyWave(entry, snapshot);
      }
      for (const policyKey of pool.policies) {
        const policy = this.policies.get(policyKey);
        if (!policy || pool.represented.get(wave.id)?.has(policy.owner.sessionId) || this.representative(policy.owner, pool.target, wave.id, true)) continue;
        // Historical terminal replay never creates an automatic task.
        if (wave.state !== "running" && wave.state !== "reconnecting") continue;
        const id = this.id();
        try { this.reserve(id, policy.owner); } catch { continue; }
        const record = this.newRecord(id, policy.owner, pool.target, "watch", "Notebook execution", "automatic");
        record.detached = true;
        const entry: Entry = { record, poolKey: key, waveId: wave.id };
        this.records.set(id, entry);
        pool.records.add(id);
        this.applyWave(entry, snapshot);
        this.changed(record);
      }
    }
    for (const wake of [...pool.waiters]) wake();
  }
  private applyWave(entry: Entry, snapshot: WaveSnapshot): void {
    const wave = snapshot.wave;
    if (!wave || isExecutionTerminal(entry.record.state) || (entry.waveId && entry.waveId !== wave.id)) return;
    // Retained historical evidence must not classify a later CLI request as interrupted.
    if (!entry.waveId && entry.record.kind === "execute" && wave.endedAt !== undefined && wave.endedAt <= entry.record.startedAt) return;
    entry.waveId = wave.id;
    if (entry.poolKey) {
      const represented = this.pools.get(entry.poolKey)?.represented;
      if (represented) {
        let owners = represented.get(wave.id);
        if (!owners) represented.set(wave.id, owners = new Set());
        owners.add(entry.record.owner.sessionId);
      }
    }
    entry.record.errors = boundedEvidence([...entry.record.errors, ...wave.errors]);
    entry.record.blocked = boundedEvidence([...entry.record.blocked, ...wave.blocked]);
    if (wave.state === "interrupted") entry.interrupted = true;
    if (entry.record.kind === "execute") { this.changed(entry.record); return; }
    entry.record.startedAt = wave.startedAt;
    if (wave.state === "running" || wave.state === "reconnecting") {
      entry.record.state = wave.state;
      this.changed(entry.record);
    } else {
      this.finish(entry, wave.state, wave.state === "unknown" ? "Completion was not observed; inspect the notebook before continuing."
        : wave.state === "succeeded" ? "Notebook execution wave completed. Other work in the same kernel may still be busy."
          : `Notebook execution wave ${wave.state}.`, wave.endedAt ?? this.now());
    }
  }
}

const KEY = Symbol.for("pi-marimo.executions.v1");
/** Call from session startup only: importing the extension starts no clients or timers. */
export function ownExecutions(): ExecutionHost {
  const global = globalThis as Record<symbol, ExecutionHost | undefined>;
  if (!global[KEY]) {
    const host = new ExecutionHost();
    global[KEY] = host;
    process.once("exit", () => host.dispose());
  }
  return global[KEY]!;
}
