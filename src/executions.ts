// Pi-facing execution ownership and delivery. The process host owns CLI clients;
// this adapter can be discarded on reload without interrupting their Python.
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ownExecutions, type ExecutionActivity, type ExecutionHost, type ExecutionOwner, type ExecutionRecord, type ExecutionTarget } from "./core/execution.js";
import { sameServer } from "./core/touch.js";
import type { Followed } from "./core/watcher.js";

export const EXECUTION_ENTRY = "pi-marimo-execution";
export const COMPLETION_MESSAGE = "pi-marimo-completion";
export type CompletionMode = "subscribed" | "all" | "off";
export interface ExecutionConfig {
  execution: { command: string[] };
  completion: { mode: CompletionMode };
}

let warnedMode = false;
/** Normalize after loadConfig; preserve unrelated settings and never resolve/install a CLI here. */
export function normalizeExecutionConfig<T extends object>(config: T, warn: (message: string) => void = () => {}): T & ExecutionConfig {
  const raw = config as { execution?: { command?: unknown }; completion?: { mode?: unknown } };
  const given = raw.completion?.mode;
  const mode = given === "all" || given === "off" || given === "subscribed" ? given : "subscribed";
  if (given !== undefined && given !== mode && !warnedMode) {
    warnedMode = true;
    warn("marimo: invalid completion.mode; using subscribed (expected subscribed, all, or off).");
  }
  return {
    ...config,
    execution: { command: Array.isArray(raw.execution?.command) ? raw.execution.command.filter((s): s is string => typeof s === "string" && s.length > 0) : [] },
    completion: { mode },
  };
}

export type ExecutionPi = Pick<ExtensionAPI, "appendEntry" | "sendMessage">;
export type ExecutionContext = Pick<ExtensionContext, "cwd"> & {
  hasPendingMessages?: () => boolean;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getBranch">;
};
/** All notebook/server integration lives in index. No companion extension is consulted. */
export interface ExecutionDependencies {
  /** Apply explicit argv, remembered own-server argv/cwd, then serverCommand fallback. */
  command(followed: Followed, config: ExecutionConfig, cwd: string): { command: string[]; cwd: string };
  /** Existing writable-target path; may reuse followed.attachment without opening a new consumer. */
  acquireTarget(followed: Followed): Promise<{ url: string; sessionId: string }>;
  engage(followed: Followed): void;
  host?: () => ExecutionHost;
  id?: () => string;
  onChange?: () => void;
}
export interface ExecutionSelector { notebook?: string; url?: string }
export interface ExecuteParams extends ExecutionSelector { code: string; label?: string; subscribe?: boolean; yield_ms?: number }
export interface ExecutionReply {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

const terminal = (r: ExecutionRecord): boolean => !["starting", "running", "reconnecting"].includes(r.state);
const completionId = (id: string): string => `pi-marimo-execution:${id}`;
const targetOf = (f: Followed): ExecutionTarget => ({ ...f.attachment, canonicalPath: f.canonicalPath ?? f.attachment.path });
const busyCells = (f: Followed): string[] => [...f.notebook.cells.values()].filter(c => c.status === "running" || c.status === "queued").map(c => c.id);
const sameTarget = (a: ExecutionTarget, b: ExecutionTarget): boolean => sameServer(a.url, b.url) && a.canonicalPath === b.canonicalPath && a.sessionId === b.sessionId;
const reply = (text: string, details: Record<string, unknown>): ExecutionReply => ({ content: [{ type: "text", text }], details });
const offNotice = "Automatic continuation is disabled by completion.mode=off.";

function outputTail(name: string, text: string, omitted: number, limit?: number): string {
  const tail = limit === undefined ? text : Array.from(text).slice(-limit).join("");
  const missing = omitted + Buffer.byteLength(text) - Buffer.byteLength(tail);
  return text || missing ? `\n${name}${missing ? ` (${missing} earlier bytes omitted)` : ""}:\n${tail}` : "";
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** Session data is untrusted/versioned metadata, not authority to launch or import arbitrary fields. */
function savedRecord(value: unknown): value is ExecutionRecord {
  const r = object(value);
  const owner = object(r?.owner);
  const target = object(r?.target);
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string");
  return !!r && r.version === 1 && typeof r.id === "string" && r.id.length > 0 &&
    !!owner && typeof owner.sessionId === "string" && owner.sessionId.length > 0 && typeof owner.anchorId === "string" && owner.anchorId.length > 0 &&
    !!target && [target.url, target.path, target.canonicalPath, target.sessionId].every(v => typeof v === "string" && v.length > 0) &&
    (r.kind === "execute" || r.kind === "watch") && typeof r.label === "string" &&
    typeof r.state === "string" && ["starting", "running", "reconnecting", "succeeded", "failed", "interrupted", "unknown"].includes(r.state) &&
    typeof r.startedAt === "number" && Number.isFinite(r.startedAt) && (r.endedAt === undefined || typeof r.endedAt === "number" && Number.isFinite(r.endedAt)) &&
    typeof r.notification === "string" && ["explicit", "automatic", "none"].includes(r.notification) && typeof r.delivery === "string" && ["pending", "queued", "delivered", "suppressed"].includes(r.delivery) &&
    typeof r.detached === "boolean" && typeof r.stdout === "string" && typeof r.stderr === "string" &&
    [r.stdoutOmittedBytes, r.stderrOmittedBytes].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
    (r.summary === undefined || typeof r.summary === "string") && strings(r.errors) && strings(r.blocked);
}

/** The tools and slash aliases share this one session-bound adapter. */
export class ExecutionSession {
  private ctx?: ExecutionContext;
  private host?: ExecutionHost;
  private sessionId?: string;
  private config: ExecutionConfig = normalizeExecutionConfig({});
  private followed: Followed[] = [];
  private release?: () => void;
  private policy?: ExecutionOwner;
  private policyKey = "";
  private scheduled = false;
  private generation = 0;
  private fingerprints = new Map<string, string>();
  private foreground = new Set<string>();
  private ledger = new Set<string>();
  private failedDelivery = new Set<string>();

  constructor(private readonly pi: ExecutionPi, private readonly deps: ExecutionDependencies) {}

  start(ctx: ExecutionContext, config: object): void {
    this.shutdown();
    this.ctx = ctx;
    this.config = normalizeExecutionConfig(config);
    this.sessionId = typeof ctx.sessionManager.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined;
    if (typeof this.sessionId !== "string" || !this.sessionId || typeof ctx.sessionManager.getLeafId !== "function" || typeof ctx.sessionManager.getBranch !== "function") {
      this.sessionId = undefined;
      return;
    }
    this.host = (this.deps.host ?? ownExecutions)();
    this.fingerprints.clear();
    this.ledger.clear();
    this.failedDelivery.clear();
    const anchors = this.anchors();
    const live = new Set(this.host.list(this.sessionId, anchors).map(r => r.id));
    const records = new Map<string, ExecutionRecord>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === EXECUTION_ENTRY) {
        const data = entry.data as { version?: number; kind?: string; record?: ExecutionRecord; sessionId?: string } | undefined;
        if (data?.version === 1 && data.kind === "snapshot" && savedRecord(data.record) && data.record.owner.sessionId === this.sessionId && anchors.has(data.record.owner.anchorId)) records.set(data.record.id, data.record);
        if (data?.version === 1 && data.kind === "policy" && data.sessionId === this.sessionId) this.policy = { sessionId: this.sessionId, anchorId: entry.id };
      }
      // Pi persists native sendMessage as custom_message, not message.role=custom.
      // Details may contain arbitrary additional renderer metadata.
      if (entry.type === "custom_message" && entry.customType === COMPLETION_MESSAGE) {
        const ids = (entry.details as { ids?: unknown } | undefined)?.ids;
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") this.ledger.add(id);
      }
    }
    this.host.restore([...records.values()]);
    for (const r of this.records()) {
      // A process may have died between persisting a terminal result and claiming
      // its inline response. Requeue the result, never its Python request.
      if (!live.has(r.id) && terminal(r) && r.delivery === "pending" && !r.detached) this.host.markDetached(r.id);
      if (this.ledger.has(completionId(r.id))) { this.host.markQueued(r.id); this.host.markDelivered(r.id); }
      else if (this.config.completion.mode === "off" && r.notification !== "none") this.host.unsubscribe(r.owner, r.id);
      else if (r.delivery === "queued" && ctx.hasPendingMessages?.() !== true) this.host.retryDelivery(r.id);
    }
    const generation = this.generation;
    this.release = this.host.subscribeOwner(this.sessionId, () => {
      if (generation === this.generation) this.changed(true);
    });
    this.syncPolicy();
    this.changed();
  }

  update(followed: Followed[]): void {
    this.followed = [...followed];
    this.syncPolicy();
    this.changed();
  }

  /** Context is optional; bookkeeping and native follow-ups are not. */
  beforeTurn(): string {
    // Retry only failed enqueue attempts here; an accepted follow-up can still be in Pi's queue.
    for (const id of this.failedDelivery) if (this.records().some(r => r.id === id)) this.host?.retryDelivery(id);
    this.failedDelivery.clear();
    for (const entry of this.ctx?.sessionManager.getBranch() ?? []) {
      if (entry.type !== "custom_message" || entry.customType !== COMPLETION_MESSAGE) continue;
      const ids = object(entry.details)?.ids;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") this.ledger.add(id);
    }
    this.syncPolicy();
    this.changed();
    const records = this.records().filter(r => !terminal(r) || r.delivery === "pending" || r.delivery === "queued").slice(0, 12);
    return records.length ? `Marimo executions (${this.config.completion.mode}):\n${records.map(r => `${r.id}: ${r.label} · ${r.state} · ${r.notification === "none" ? "not subscribed" : "resume armed"} · ${r.target.canonicalPath}`).join("\n")}` : "";
  }

  settled(): void {
    if (!this.ctx || !this.host || this.ctx.hasPendingMessages?.() === true) return;
    for (const r of this.records()) if (r.delivery === "queued" && !this.ledger.has(completionId(r.id))) this.host.retryDelivery(r.id);
    this.changed();
  }

  /** Pi's sendMessage is fire-and-forget. A message_end event confirms actual consumption, not just enqueue. */
  messageDelivered(message: unknown): void {
    if (!this.ctx || !this.host || this.ctx.sessionManager.getSessionId() !== this.sessionId) return;
    const custom = message as { role?: string; customType?: string; details?: { ids?: unknown } } | undefined;
    if (custom?.role !== "custom" || custom.customType !== COMPLETION_MESSAGE || !Array.isArray(custom.details?.ids)) return;
    const ids = new Set(custom.details.ids.filter((id): id is string => typeof id === "string"));
    for (const r of this.records()) if (ids.has(completionId(r.id))) {
      this.ledger.add(completionId(r.id));
      this.host.markQueued(r.id);
      this.host.markDelivered(r.id);
      this.persist(this.host.get(r.owner, r.id));
    }
  }

  shutdown(): void {
    this.generation++;
    this.release?.();
    this.release = undefined;
    if (this.policy) this.host?.observeAll(this.policy, [], false);
    this.policy = undefined;
    this.policyKey = "";
    this.ctx = undefined;
    this.followed = [];
    this.sessionId = undefined;
    this.host = undefined;
    this.scheduled = false;
    this.foreground.clear();
    // Never dispose the process host, CLI client, or a headless consumer here.
  }

  async execute(params: ExecuteParams, signal?: AbortSignal): Promise<ExecutionReply> {
    const { host, ctx, sessionId } = this.requireSession();
    if (!params.code.trim()) throw new Error("code must be nonempty.");
    const ms = params.yield_ms ?? 1000;
    if (!Number.isInteger(ms) || ms < 0 || ms > 1000) throw new Error("yield_ms must be an integer from 0 to 1000.");
    const f = this.select(params);
    const original = targetOf(f);
    const isCurrent = () => this.ctx === ctx && this.sessionId === sessionId && this.followed.some(o => o.notebook === f.notebook && o.connection === "connected" && o.notebook.ready && sameTarget(targetOf(o), original)) && !busyCells(f).length;
    this.assertNotBusy(f);
    const acquired = await this.deps.acquireTarget(f);
    if (!isCurrent()) throw new Error("Notebook session changed or kernel is busy; nothing was submitted.");
    this.assertNotBusy(f);
    const target = { ...original, url: acquired.url, sessionId: acquired.sessionId };
    const command = this.deps.command(f, this.config, ctx.cwd);
    const id = (this.deps.id ?? randomUUID)();
    const owner = this.register(id, target);
    const subscribed = params.subscribe !== false && this.config.completion.mode !== "off";
    this.foreground.add(id);
    let r: ExecutionRecord;
    try {
      r = host.start({ id, owner, target, code: params.code, label: params.label?.trim() || "Python execution", command: [...command.command], cwd: command.cwd, subscribed, isCurrent: () => isCurrent() && this.anchors().has(owner.anchorId) && !this.records().some(other => other.id !== id && other.kind === "execute" && !terminal(other) && sameTarget(other.target, target)) });
    } catch (error) {
      this.foreground.delete(id);
      throw error;
    }
    this.deps.engage(f);
    this.persist(r);
    // Abort/yield affects only this foreground wait, never ownership or the CLI.
    try {
      const done = await host.waitForResult(id, ms, signal);
      if (done) {
        host.markInline(id);
        r = host.get(owner, id);
      } else {
        host.markDetached(id);
        r = host.get(owner, id);
      }
    } finally {
      this.foreground.delete(id);
      this.changed();
    }
    return this.recordReply(r);
  }

  async watch(selector: ExecutionSelector = {}): Promise<ExecutionReply> {
    const { host, ctx, sessionId } = this.requireSession();
    const f = this.select(selector);
    const target = targetOf(f);
    const existing = this.records().find(r => !terminal(r) && sameServer(r.target.url, target.url) && r.target.canonicalPath === target.canonicalPath && (r.kind === "execute" || r.target.sessionId === target.sessionId));
    if (existing) {
      const current = existing.notification === "none" && this.config.completion.mode !== "off" ? host.subscribe(existing.owner, existing.id) : existing;
      this.persist(current);
      this.changed();
      return this.recordReply(current);
    }
    const id = (this.deps.id ?? randomUUID)();
    const owner = this.register(id, target);
    // Read-only observation of the existing captured session; no acquireTarget.
    const r = await host.watch({ id, owner, target, seedBusyCells: busyCells(f), subscribed: this.config.completion.mode !== "off" });
    if (this.ctx !== ctx || this.sessionId !== sessionId) return reply("Watch remains owned by its originating session.", { id, state: r?.state ?? "unknown" });
    if (!r) return reply(`No active execution was observed; nothing was subscribed.${this.disabled()}`, { state: "unknown", subscribed: false });
    if (!this.anchors().has(r.owner.anchorId) || r.owner.sessionId !== sessionId) throw new Error("Execution belongs to another branch; nothing was subscribed here.");
    this.persist(r);
    this.changed();
    return this.recordReply(r);
  }

  status(id?: string): ExecutionReply {
    this.requireSession();
    if (id) return this.recordReply(this.owned(id));
    const records = this.records();
    return reply(`${records.length ? records.map(r => `${r.id}: ${r.label} · ${r.state} · ${r.notification === "none" ? "not subscribed" : "subscribed"} · ${r.target.canonicalPath}`).join("\n") : "No marimo executions in this session/branch."}${this.disabled()}`, { records });
  }

  unsubscribe(id: string): ExecutionReply {
    const { host } = this.requireSession();
    const r = this.owned(id);
    const updated = host.unsubscribe(r.owner, id);
    this.persist(updated);
    return reply(`Stopped watching ${id}; Python execution was not interrupted.${this.disabled()}`, { ...updated, subscribed: false });
  }

  activity(f: Followed): ExecutionActivity {
    if (!this.host || !this.sessionId) return { running: false, detail: [] };
    const target = targetOf(f);
    const records = this.records().filter(r => sameServer(r.target.url, target.url) && r.target.canonicalPath === target.canonicalPath);
    const active = records.filter(r => !terminal(r));
    const latest = records.find(r => r.kind === "execute" && terminal(r));
    const failed = latest && latest.state !== "succeeded" ? latest : undefined;
    return {
      running: active.length > 0,
      startedAt: active.length ? Math.min(...active.map(r => r.startedAt)) : latest?.startedAt,
      detail: [...(active.some(r => r.kind === "execute") && !busyCells(f).length ? ["executing Python"] : []), ...(active.some(r => r.notification !== "none") ? ["resume armed"] : [])],
      failed: !!failed, endedAt: latest?.endedAt, summary: latest?.summary,
    };
  }

  private requireSession(): { ctx: ExecutionContext; host: ExecutionHost; sessionId: string } {
    if (!this.ctx || !this.host || !this.sessionId || this.ctx.sessionManager.getSessionId() !== this.sessionId) throw new Error("Persistent session identity is required for marimo background execution.");
    return { ctx: this.ctx, host: this.host, sessionId: this.sessionId };
  }

  private anchors(): Set<string> {
    return new Set(this.ctx?.sessionManager.getBranch().map(e => e.id) ?? []);
  }

  private records(): ExecutionRecord[] {
    return this.host && this.sessionId && this.ctx?.sessionManager.getSessionId() === this.sessionId ? this.host.list(this.sessionId, this.anchors()).reverse().sort((a, b) => b.startedAt - a.startedAt) : [];
  }

  private owned(id: string): ExecutionRecord {
    const r = this.records().find(r => r.id === id);
    if (!r) throw new Error(`Unknown marimo execution in this session/branch: ${id}`);
    return this.requireSession().host.get(r.owner, id);
  }

  private select(selector: ExecutionSelector): Followed {
    const connected = this.followed.filter(f => f.connection === "connected" && f.notebook.ready && (!selector.url || sameServer(selector.url, f.attachment.url)));
    let matches: Followed[];
    if (selector.notebook) {
      const requested = selector.notebook;
      const absolute = resolve(this.ctx!.cwd, requested);
      matches = connected.filter(f => f.canonicalPath === requested || f.attachment.path === requested || f.canonicalPath === absolute || f.attachment.path === absolute);
      if (!matches.length && basename(requested) === requested) matches = connected.filter(f => basename(f.attachment.path) === requested || basename(f.canonicalPath ?? "") === requested);
    } else matches = connected.filter(f => f.engaged);
    if (matches.length === 1) return matches[0]!;
    const candidates = (matches.length ? matches : connected).map(f => `${f.canonicalPath ?? f.attachment.path} (${f.attachment.url})`).join("\n");
    throw new Error(`${matches.length > 1 ? "Ambiguous notebook; select a full path and, if needed, url." : "No matching engaged, connected notebook. Follow a notebook first; this tool does not start a server."}${candidates ? `\nCandidates:\n${candidates}` : ""}`);
  }

  private assertNotBusy(f: Followed): void {
    const target = targetOf(f);
    if (busyCells(f).length || this.records().some(r => r.kind === "execute" && !terminal(r) && sameServer(r.target.url, target.url) && r.target.canonicalPath === target.canonicalPath)) throw new Error("Kernel is busy; use marimo_watch to subscribe without sending more Python.");
  }

  private register(id: string, target: ExecutionTarget): ExecutionOwner {
    const { ctx, sessionId } = this.requireSession();
    this.pi.appendEntry(EXECUTION_ENTRY, { version: 1, kind: "registration", id, sessionId, target });
    const anchorId = ctx.sessionManager.getLeafId();
    const entry = ctx.sessionManager.getBranch().find(e => e.id === anchorId);
    const data = entry?.type === "custom" ? entry.data as { kind?: string; id?: string; sessionId?: string } : undefined;
    if (!anchorId || entry?.type !== "custom" || entry.customType !== EXECUTION_ENTRY || data?.kind !== "registration" || data.id !== id || data.sessionId !== sessionId) throw new Error("Could not persist execution ownership; nothing was submitted.");
    return { sessionId, anchorId };
  }

  private syncPolicy(): void {
    if (!this.host || !this.ctx || !this.sessionId) return;
    const enabled = this.config.completion.mode === "all";
    const anchors = this.anchors();
    if (this.policy && (!enabled || !anchors.has(this.policy.anchorId))) {
      const old = this.policy;
      this.policy = undefined;
      this.policyKey = "";
      this.host.observeAll(old, [], false);
    }
    if (!enabled) return;
    if (!this.policy) {
      this.pi.appendEntry(EXECUTION_ENTRY, { version: 1, kind: "policy", sessionId: this.sessionId });
      const anchorId = this.ctx.sessionManager.getLeafId();
      const entry = this.ctx.sessionManager.getBranch().find(e => e.id === anchorId);
      const data = entry?.type === "custom" ? entry.data as { kind?: string; sessionId?: string } : undefined;
      if (!anchorId || entry?.type !== "custom" || entry.customType !== EXECUTION_ENTRY || data?.kind !== "policy" || data.sessionId !== this.sessionId) throw new Error("Could not persist completion policy ownership.");
      this.policy = { sessionId: this.sessionId, anchorId };
    }
    const targets = this.followed.filter(f => f.engaged && f.connection === "connected" && f.notebook.ready).map(targetOf);
    const key = JSON.stringify([this.policy, targets]);
    if (key === this.policyKey) return;
    this.policyKey = key;
    this.host.observeAll(this.policy, targets, true);
  }

  private disabled(): string { return this.config.completion.mode === "off" ? `\n${offNotice}` : ""; }

  private recordReply(r: ExecutionRecord): ExecutionReply {
    const subscribed = r.notification !== "none" && this.config.completion.mode !== "off";
    return reply(`${r.id}: ${r.label} · ${r.state}\n${r.target.canonicalPath}\n${r.summary ?? ""}${r.errors.length ? `\nNew notebook errors:\n${r.errors.join("\n")}` : ""}${r.blocked.length ? `\nBlocked cells: ${r.blocked.join(", ")}` : ""}${outputTail("stdout", r.stdout, r.stdoutOmittedBytes)}${outputTail("stderr", r.stderr, r.stderrOmittedBytes)}${this.disabled()}`, { ...r, subscribed, notebook: r.target.canonicalPath });
  }

  private persist(r: ExecutionRecord): void {
    if (!this.ctx || r.owner.sessionId !== this.sessionId || !this.anchors().has(r.owner.anchorId)) return;
    // Output chunks do not make session entries: only lifecycle/intent changes do.
    const fingerprint = JSON.stringify([r.state, r.notification, r.delivery, r.startedAt, r.endedAt, r.detached]);
    if (this.fingerprints.get(r.id) === fingerprint) return;
    this.pi.appendEntry(EXECUTION_ENTRY, { version: 1, kind: "snapshot", record: r });
    this.fingerprints.set(r.id, fingerprint);
  }

  private changed(notify = false): void {
    if (!this.ctx || !this.host) return;
    for (const r of this.records()) this.persist(r);
    if (notify) this.deps.onChange?.();
    if (this.scheduled) return;
    this.scheduled = true;
    const generation = this.generation;
    queueMicrotask(() => {
      if (generation !== this.generation) return;
      this.scheduled = false;
      this.deliver();
    });
  }

  private deliver(): void {
    if (!this.ctx || !this.host) return;
    const host = this.host;
    const pending = this.records().filter(r => terminal(r) && r.delivery === "pending" && !this.foreground.has(r.id) && r.detached && !this.failedDelivery.has(r.id));
    const batch: ExecutionRecord[] = [];
    for (const r of pending) {
      if (this.ledger.has(completionId(r.id))) { host.markQueued(r.id); host.markDelivered(r.id); continue; }
      if (this.config.completion.mode === "off" || r.notification === "none") { host.unsubscribe(r.owner, r.id); continue; }
      this.persist(r); // Terminal result precedes the nontransactional enqueue.
      host.markQueued(r.id);
      const queued = host.get(r.owner, r.id);
      this.persist(queued);
      if (queued.delivery === "queued") batch.push(queued);
    }
    if (!batch.length) return;
    const ids = batch.map(r => completionId(r.id));
    // Bound aggregate text as well as individual host tails.
    const headline = batch.map(r => `${r.id}: ${r.state}`).join("\n");
    const body = batch.map(r => `${r.id}: ${r.label} · ${r.state}\n${r.target.canonicalPath}\n${r.summary ?? ""}${r.errors.length ? `\nNew notebook errors:\n${r.errors.join("\n").slice(-2048)}` : ""}${r.blocked.length ? `\nBlocked cells: ${r.blocked.join(", ").slice(-1024)}` : ""}${outputTail("stdout", r.stdout, r.stdoutOmittedBytes, 4096)}${outputTail("stderr", r.stderr, r.stderrOmittedBytes, 4096)}`).join("\n\n");
    const content = `${headline}\n\n${body.length > 22_000 ? "Some details omitted; use marimo_execution with an ID for its result.\n" : ""}${body.slice(-22_000)}\n\nA native CLI success confirms only its Python request, not every downstream notebook cell. Other work in the same kernel may still be busy; inspect new notebook errors/blocked cells before continuing. Do not retry an unknown outcome automatically.`;
    try {
      this.pi.sendMessage({ customType: COMPLETION_MESSAGE, content, display: true, details: { version: 1, ids, executions: batch.map(r => ({ id: r.id, target: r.target, state: r.state, summary: r.summary, errors: r.errors, blocked: r.blocked })) } }, { deliverAs: "followUp", triggerTurn: true });
    } catch {
      // Keep queued metadata recoverable. A host change callback is already queued;
      // block it from retrying indefinitely. beforeTurn/rebind may retry safely.
      for (const r of batch) this.failedDelivery.add(r.id);
      return;
    }
    // Idle/direct senders may have persisted immediately. Busy Pi queues are acknowledged by message_end.
    for (const entry of this.ctx.sessionManager.getBranch()) if (entry.type === "custom_message") {
      this.messageDelivered({ role: "custom", customType: entry.customType, details: entry.details });
    }
  }
}

/** Factory-safe: registration only. ExecutionSession.start initializes the process host. */
export function registerExecutionTools(pi: Pick<ExtensionAPI, "registerTool">, session: ExecutionSession): void {
  const selector = {
    notebook: Type.Optional(Type.String({ description: "Followed notebook's canonical/full path or unambiguous filename" })),
    url: Type.Optional(Type.String({ description: "Server URL to disambiguate the same notebook on different servers" })),
  };
  const guidelines = [
    "marimo_execute supervises the official marimo pair execute CLI; it is transport, not a new notebook editing API. Follow the marimo-pair workflow and use marimo._code_mode for durable notebook changes, never direct .py edits.",
    "The dedicated first inspection is import marimo._code_mode as cm; help(cm). Run that by itself before other code-mode work.",
    "Never poll a busy kernel with Python or queue inspection behind a fit. Use marimo_watch to subscribe and marimo_execution to read results or unsubscribe. Yield/abort and unsubscribe do not interrupt Python. Never automatically retry an unknown outcome.",
  ];
  pi.registerTool({
    name: "marimo_execute", label: "Execute Python", description: "Run Python through the official marimo CLI in an already-followed connected notebook. Returns inline within 1000 ms or a supervised execution handle; subscribed completion resumes this session with a native follow-up.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ ...selector, code: Type.String({ minLength: 1 }), label: Type.Optional(Type.String()), subscribe: Type.Optional(Type.Boolean()), yield_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })) }),
    execute: (_id, params, signal) => session.execute(params, signal),
  });
  pi.registerTool({
    name: "marimo_watch", label: "Watch execution", description: "Subscribe once to the currently observed notebook execution wave, including queued descendants and scratch work. Read-only: executes no Python, starts no server or kernel. No observed busy evidence means no subscription.",
    promptGuidelines: guidelines,
    parameters: Type.Object(selector),
    execute: (_id, params) => session.watch(params),
  });
  pi.registerTool({
    name: "marimo_execution", label: "Execution status", description: "List this session/branch's execution results or inspect one ID. Unsubscribe changes notification intent only; Python is not interrupted.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ action: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("unsubscribe")])), id: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      if (params.action === "unsubscribe") {
        if (!params.id) throw new Error("unsubscribe requires an execution id.");
        return session.unsubscribe(params.id);
      }
      return session.status(params.id);
    },
  });
}
