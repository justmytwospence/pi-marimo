// Passive, exact-session evidence for notebook-wide execution waves. This is
// deliberately independent of the resettable document/UI state. The host owns
// pooling and subscription lifetimes; this class owns only a kiosk stream.

import { randomUUID } from "node:crypto";
import type { Cancellable, Io } from "./io.js";
import { nodeIo } from "./node-io.js";
import { streamSession } from "./sse.js";

export type WaveState = "running" | "reconnecting" | "succeeded" | "failed" | "interrupted" | "unknown";

export interface WaveSnapshot {
  connection: "connecting" | "connected" | "reconnecting" | "stopped";
  wave?: {
    id: string;
    startedAt: number;
    endedAt?: number;
    state: WaveState;
    busyCells: string[];
    /** Cell-prefixed structured error summaries, or the reason for uncertainty. */
    errors: string[];
    /** IDs of participating cells prevented from running by an ancestor. */
    blocked: string[];
  };
}

interface ObserverOptions {
  target: { url: string; path: string; sessionId: string };
  io?: Io;
  token?: string;
  now?: () => number;
  id?: () => string;
  onChange?: (snapshot: WaveSnapshot) => void;
  seedBusyCells?: string[];
  graceMs?: number;
  retryMs?: number;
}

interface CellEvidence {
  status: string;
  statusAt?: number;
  beganAt?: number;
  errors: string[];
  blocked: boolean;
  interrupted: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const busy = (status: string): boolean => status === "queued" || status === "running";
const timestamp = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const UNOBSERVED = "Completion was not observed; inspect the notebook before continuing.";

export class ExecutionWaveObserver {
  private readonly io: Io;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly target: ObserverOptions["target"];
  private readonly token?: string;
  private readonly graceMs: number;
  private readonly retryMs: number;
  private connection: WaveSnapshot["connection"] = "stopped";
  private wave?: NonNullable<WaveSnapshot["wave"]>;
  private readonly cells = new Map<string, CellEvidence>();
  private readonly participants = new Set<string>();
  private readonly completedIds = new Set<string>();
  private active = false;
  private started = false;
  private generation = 0;
  private stream?: Cancellable<unknown>;
  private retry?: Cancellable<void>;
  private grace?: Cancellable<void>;
  private graceGeneration = 0;
  private quietSince?: number;
  private lostAt?: number;
  // A reconnect must supply fresh busy evidence, not merely replay idle state.
  private busyProof = true;

  constructor(private readonly options: ObserverOptions) {
    this.io = options.io ?? nodeIo();
    this.now = options.now ?? Date.now;
    this.makeId = options.id ?? randomUUID;
    this.target = { ...options.target };
    this.token = options.token ?? process.env.MARIMO_TOKEN;
    this.graceMs = options.graceMs ?? 30_000;
    this.retryMs = options.retryMs ?? 1000;
    for (const id of options.seedBusyCells ?? []) {
      if (!id) continue;
      this.cells.set(id, { status: "running", errors: [], blocked: false, interrupted: false });
      this.begin();
      this.participants.add(id);
    }
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    if (this.started && this.pending()) {
      this.lostAt = this.now();
      this.busyProof = false;
      this.wave!.state = "reconnecting";
    }
    this.started = true;
    this.connect();
  }

  /** Closes only our read-only observation, never an execution or its kernel. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    ++this.generation;
    this.stream?.cancel();
    this.stream = undefined;
    this.retry?.cancel();
    this.retry = undefined;
    this.cancelGrace();
    this.connection = "stopped";
    this.changed();
  }

  snapshot(): WaveSnapshot {
    if (!this.wave) return { connection: this.connection };
    const wave = this.wave;
    return { connection: this.connection, wave: { ...wave, busyCells: this.busyCells(), errors: [...wave.errors], blocked: [...wave.blocked] } };
  }

  private pending(): boolean {
    return this.wave !== undefined && this.wave.endedAt === undefined;
  }

  private busyCells(): string[] {
    return [...this.participants].filter(id => busy(this.cells.get(id)?.status ?? ""));
  }

  private begin(): void {
    if (this.pending()) return;
    this.participants.clear();
    this.quietSince = undefined;
    this.wave = { id: this.makeId(), startedAt: this.now(), state: "running", busyCells: [], errors: [], blocked: [] };
  }

  private changed(): void {
    try { this.options.onChange?.(this.snapshot()); } catch { /* A listener must not break observation. */ }
  }

  private connect(): void {
    if (!this.active) return;
    const generation = ++this.generation;
    this.connection = this.lostAt === undefined ? "connecting" : "reconnecting";
    this.changed();
    // A listener may synchronously release the last host reference.
    if (!this.active || generation !== this.generation) return;
    try {
      const stream = streamSession({
        io: this.io, url: this.target.url, sessionId: this.target.sessionId, file: this.target.path, token: this.token,
        onMessage: (op, data) => {
          if (this.active && generation === this.generation) this.message(op, record(data));
        },
      });
      if (!this.active || generation !== this.generation) { stream.cancel(); return; }
      this.stream = stream;
      void stream.done.then(() => this.disconnected(generation), () => this.disconnected(generation));
    } catch {
      this.disconnected(generation);
    }
    this.armGrace();
  }

  private disconnected(generation: number): void {
    if (!this.active || generation !== this.generation) return;
    ++this.generation; // Invalidates even callbacks made after stream.done resolved.
    this.stream = undefined;
    this.connection = "reconnecting";
    this.lostAt ??= this.now();
    this.busyProof = false;
    if (this.pending()) this.wave!.state = "reconnecting";
    this.armGrace();
    this.changed();
    if (!this.active) return;
    const next = this.generation;
    const retry = this.io.sleep(this.retryMs);
    this.retry = retry;
    void retry.done.then(() => {
      if (!this.active || next !== this.generation || this.retry !== retry) return;
      this.retry = undefined;
      this.connect();
    });
  }

  private message(op: string, data: Record<string, unknown>): void {
    if (op === "kernel-ready") {
      // No replay barrier and no run completion can be inferred from readiness.
      this.connection = "connected";
      this.changed();
      return;
    }
    if (op === "completed-run") {
      const id = typeof data.run_id === "string" ? data.run_id : undefined;
      if (id && this.completedIds.has(id)) return;
      if (id) {
        this.completedIds.add(id);
        if (this.completedIds.size > 128) this.completedIds.delete(this.completedIds.values().next().value!);
      }
      if (!this.pending() || !this.busyProof || this.busyCells().length) return;
      const interrupted = [...this.participants].some(id => this.cells.get(id)?.interrupted);
      this.finish(interrupted ? "interrupted" : this.wave!.errors.length || this.wave!.blocked.length ? "failed" : "succeeded");
      return;
    }
    if (op !== "cell-op" || typeof data.cell_id !== "string" || !data.cell_id) return;
    const id = data.cell_id;
    let cell = this.cells.get(id);
    if (!cell) {
      cell = { status: "idle", errors: [], blocked: false, interrupted: false };
      this.cells.set(id, cell);
    }
    const at = timestamp(data.timestamp);
    if (at !== undefined && cell.statusAt !== undefined && at < cell.statusAt) return;
    const status = typeof data.status === "string" ? data.status : undefined;
    if (status !== undefined) {
      const transition = status !== cell.status;
      const fresh = transition || (at !== undefined && at !== cell.statusAt);
      if (busy(status)) {
        // Replayed same-status notifications still reestablish busy evidence on
        // reconnect, but a duplicate after a terminal wave cannot create a wave.
        if (!this.pending() && !fresh) return;
        const newWave = !this.pending();
        this.begin();
        this.participants.add(id);
        this.busyProof = true;
        this.lostAt = undefined;
        this.wave!.state = "running";
        if (newWave || transition || cell.beganAt === undefined) {
          cell.errors = [];
          cell.blocked = false;
          cell.interrupted = false;
          cell.beganAt = at;
        }
      }
      cell.status = status;
      if (at !== undefined) cell.statusAt = at;
    }
    if (!this.pending()) return;
    const output = record(data.output);
    const outputAt = timestamp(output.timestamp);
    if (this.participants.has(id) && output.channel === "marimo-error" && Array.isArray(output.data)
      && (outputAt === undefined || cell.beganAt === undefined || outputAt >= cell.beganAt)) {
      // A merged busy replay may contain output from the previous run. Only
      // structured output new enough for this participant belongs to its wave.
      for (const raw of output.data) {
        const error = record(raw);
        const type = typeof error.type === "string" ? error.type : "error";
        if (type === "ancestor-prevented" || type === "ancestor-stopped") { cell.blocked = true; continue; }
        const msg = typeof error.msg === "string" ? error.msg.trim().split("\n")[0] : "";
        const name = type === "exception" && typeof error.exception_type === "string" ? error.exception_type : type;
        if (type === "interruption") cell.interrupted = true;
        const summary = (type === "interruption" ? "interrupted" : msg ? `${name}: ${msg}` : name).slice(0, 512);
        if (cell.errors.length < 4 && !cell.errors.includes(summary)) cell.errors.push(summary);
      }
    }
    this.wave!.errors = [...this.participants].flatMap(id => (this.cells.get(id)?.errors ?? []).map(error => `${id.slice(0, 128)}: ${error}`)).slice(0, 32);
    this.wave!.blocked = [...this.participants].filter(id => this.cells.get(id)?.blocked).slice(0, 256).map(id => id.slice(0, 128));
    if (this.busyCells().length) this.quietSince = undefined;
    else this.quietSince ??= this.now();
    this.armGrace();
    this.changed();
  }

  private finish(state: WaveState): void {
    if (!this.pending()) return;
    this.wave!.state = state;
    this.wave!.endedAt = this.now();
    if (state === "unknown") this.wave!.errors = [...this.wave!.errors.slice(0, 31), UNOBSERVED];
    this.cancelGrace();
    this.changed();
  }

  private cancelGrace(): void {
    ++this.graceGeneration;
    this.grace?.cancel();
    this.grace = undefined;
  }

  private armGrace(): void {
    this.cancelGrace();
    if (!this.active) return;
    const deadlines: number[] = [];
    if (this.lostAt !== undefined) deadlines.push(this.lostAt + this.graceMs);
    if (this.pending() && this.quietSince !== undefined && !this.busyCells().length) deadlines.push(this.quietSince + this.graceMs);
    if (!deadlines.length) return;
    const generation = this.graceGeneration;
    const timer = this.io.sleep(Math.max(0, Math.min(...deadlines) - this.now()));
    this.grace = timer;
    void timer.done.then(() => {
      if (!this.active || generation !== this.graceGeneration) return;
      this.grace = undefined;
      if (this.lostAt !== undefined && this.now() >= this.lostAt + this.graceMs) {
        this.finish("unknown");
        // The same exact target was unavailable for the entire retry budget.
        this.stop();
      } else if (this.pending() && !this.busyCells().length) this.finish("unknown");
    });
  }
}
