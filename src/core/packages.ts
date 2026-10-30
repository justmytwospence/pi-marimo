// Session-bound package management. Never use the package REST routes: they can
// silently fall back to the server environment when a session has disappeared.
import { randomUUID } from "node:crypto";
import { pythonJson, type EditorSession, type ScratchExecute } from "./edit-cell.js";
import type { NotebookState } from "./notebook.js";

export interface PackageInfo { name: string; version: string }
export type PackageAction = "install" | "upgrade" | "remove";
export type EnvironmentSource = "kernel" | "server";
export interface EnvironmentFingerprint {
  filename: string; executable: string; pid: number; manager: string;
  version: string; capabilities: Record<string, boolean>;
}
export interface PackageOperation {
  operation_id: string;
  source: EnvironmentSource;
  action: string;
  status: { kind: string; error?: string; reason?: string };
  packages: Record<string, string>;
  logs: Record<string, string>;
  droppedHistory: boolean;
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const stringMap = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(object(v)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
const sourceOf = (v: unknown): EnvironmentSource | undefined => v === "kernel" || v === "server" ? v : undefined;
export const PACKAGE_LOG_LIMIT = 256 * 1024;
export const DROPPED_HISTORY_NOTICE = "[Earlier package operation logs dropped]\n";

/** View-only environment snapshots, deliberately separate for kernel and server. */
export class EnvironmentState {
  operations = new Map<string, PackageOperation>();
  missing = new Map<EnvironmentSource, { packages: string[]; isolated: boolean }>();
  restartRequired = new Map<EnvironmentSource, boolean>();

  get activeMutation(): boolean {
    return [...this.operations.values()].some(op => op.source === "kernel" && op.status.kind === "running");
  }
  reset(): void { this.operations.clear(); this.missing.clear(); this.restartRequired.clear(); }

  apply(event: string, raw: unknown): void {
    const data = object(raw);
    const source = sourceOf(data.source ?? (event === "missing-package-alert" ? "kernel" : undefined));
    if (!source) return;
    if (event === "missing-package-alert") {
      this.missing.set(source, { packages: Array.isArray(data.packages) ? data.packages.filter((p): p is string => typeof p === "string") : [], isolated: data.isolated === true });
    } else if (event === "environment-state") {
      for (const [key, op] of this.operations) if (op.source === source) this.operations.delete(key);
      const state = object(data.state);
      this.restartRequired.set(source, state.restart_required === true);
      for (const op of Array.isArray(state.operations) ? state.operations : []) this.operation({ ...object(op), source, log_mode: "replace" });
    } else if (event === "environment-operation") {
      this.operation(data);
    }
  }

  private operation(data: Record<string, unknown>): void {
    const source = sourceOf(data.source);
    const status = object(data.status);
    if (!source || typeof data.operation_id !== "string" || typeof status.kind !== "string") return;
    const key = `${source}:${data.operation_id}`;
    const previous = this.operations.get(key);
    const logs = { ...previous?.logs };
    for (const [name, chunk] of Object.entries(stringMap(data.logs))) logs[name] = data.log_mode === "replace" ? chunk : (logs[name] ?? "") + chunk;
    // Bound total UTF-8 bytes, not characters; retain the newest log tail.
    let budget = PACKAGE_LOG_LIMIT - Buffer.byteLength(DROPPED_HISTORY_NOTICE);
    let dropped = previous?.droppedHistory ?? false;
    for (const name of Object.keys(logs).reverse()) {
      const bytes = Buffer.from(logs[name]!);
      if (bytes.length > budget) {
        let start = bytes.length - budget;
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
        logs[name] = bytes.subarray(start).toString("utf8");
        dropped = true;
      }
      budget -= Buffer.byteLength(logs[name]!);
    }
    const operation: PackageOperation = {
      operation_id: data.operation_id, source, action: typeof data.action === "string" ? data.action : previous?.action ?? "unknown",
      status: { kind: status.kind, ...(typeof status.error === "string" ? { error: status.error } : {}), ...(typeof status.reason === "string" ? { reason: status.reason } : {}) },
      packages: stringMap(data.packages), logs, droppedHistory: dropped,
    };
    // Completion order, not creation order: a long-running operation that just
    // finished must not be evicted ahead of older completed operations.
    this.operations.delete(key);
    this.operations.set(key, operation);
    if (status.kind === "restart-required") this.restartRequired.set(source, true);
    const completed = [...this.operations].filter(([, op]) => op.status.kind !== "running");
    for (const [old] of completed.slice(0, Math.max(0, completed.length - 20))) this.operations.delete(old);
  }

  logText(operation: PackageOperation): string {
    return (operation.droppedHistory ? DROPPED_HISTORY_NOTICE : "") + Object.values(operation.logs).join("");
  }
}

export interface PackageSnapshot { fingerprint: EnvironmentFingerprint; packages: PackageInfo[] }
export interface PackageConfirmation {
  action: PackageAction; spec: string; fingerprint: EnvironmentFingerprint;
  warning: string; defaultChoice: "cancel";
}
export interface PackageMutationResult { status: "succeeded" | "failed" | "restart-required" | "cancelled" }
export interface PackageClientOptions {
  /** Caller resolves a writable session once; never wrap executeOnce in a retry helper. */
  target: EditorSession;
  filename: string;
  notebook: NotebookState;
  /** Must cover selected notebook, writable session and kernel identity. */
  isCurrent: () => boolean;
  isConnected: () => boolean;
  executeOnce: ScratchExecute;
  reconcile: () => void | Promise<void>;
  token?: string;
  timeoutMs?: number;
}

// Exact private-API compatibility target inspected in marimo 0.25.0. A new
// marimo version must be reviewed, not optimistically accepted for mutations.
const KERNEL_SETUP = `import asyncio, inspect, json, os, sys
import marimo
import msgspec
import marimo._code_mode as cm
from functools import partial

def _signature(fn, args, kwargs):
    try:
        inspect.signature(fn).bind(*args, **kwargs)
        return True
    except (TypeError, ValueError):
        return False

def _environment(ctx):
    pm = ctx._kernel.packages_callbacks.package_manager
    filename = ctx._kernel.app_metadata.filename
    capabilities = {}
    capabilities["list"] = callable(getattr(ctx.packages, "list", None))
    capabilities["tree"] = _signature(getattr(pm, "dependency_tree", None), [], {"filename": filename})
    capabilities["install"] = _signature(getattr(pm, "install", None), [""], {"version": None, "upgrade": False, "log_callback": None}) and inspect.iscoroutinefunction(getattr(pm, "install", None))
    capabilities["remove"] = _signature(getattr(pm, "uninstall", None), [""], {}) and inspect.iscoroutinefunction(getattr(pm, "uninstall", None))
    capabilities["metadata"] = _signature(getattr(pm, "update_notebook_script_metadata", None), [], {"filepath": filename, "packages_to_add": [], "packages_to_remove": [], "upgrade": False})
    capabilities["manager"] = callable(getattr(pm, "is_manager_installed", None)) and pm.is_manager_installed() and hasattr(pm, "restart_required")
    try:
        from marimo._runtime.packages.operations import environment_operation
        from marimo._messaging.notification_utils import broadcast_notification
        from marimo._runtime.packages.utils import split_packages
        from marimo._config.settings import GLOBAL_SETTINGS
        capabilities["notifications"] = _signature(environment_operation, ["install", {}, "kernel", None], {}) and _signature(broadcast_notification, [None], {"stream": ctx._kernel.stream}) and callable(split_packages) and hasattr(GLOBAL_SETTINGS, "MANAGE_SCRIPT_METADATA")
    except (ImportError, AttributeError):
        capabilities["notifications"] = False
    return {"filename": os.path.realpath(filename) if filename else "", "executable": os.path.realpath(sys.executable), "pid": os.getpid(), "manager": getattr(pm, "name", ""), "version": marimo.__version__, "capabilities": capabilities}
`;

class PackageRequestRejected extends Error {}

export class PackageClient {
  private pending = false;
  private unknown = false;
  private uncertain?: { action: string; spec: string; previousIds: Set<string> };
  private disposed = false;
  private requests = new Set<AbortController>();
  constructor(private readonly options: PackageClientOptions) {}
  get outcomeUnknown(): boolean { return this.unknown; }
  dispose(): void { this.disposed = true; for (const request of this.requests) request.abort(); this.requests.clear(); }

  private check(): void {
    if (this.disposed || !this.options.target.sessionId || !this.options.isCurrent()) throw new Error("Notebook session changed; refresh packages");
    if (!this.options.isConnected() || !this.options.notebook.ready) throw new Error("Notebook is disconnected");
  }
  private idle(): void {
    this.check();
    if ([...this.options.notebook.cells.values()].some(c => c.status === "running" || c.status === "queued")) throw new Error("Kernel is busy; refresh packages when idle");
  }
  private async request<T>(body: string, args: unknown = {}): Promise<T> {
    this.check();
    const marker = `pi-marimo-packages-${randomUUID()}:`;
    const script = `${KERNEL_SETUP}\n_args = ${pythonJson(args)}\nasync with cm.get_context() as ctx:\n    _fp = _environment(ctx)\n    if _fp["filename"] != os.path.realpath(${pythonJson(this.options.filename)}):\n        _result = {"_rejected": "Notebook filename changed; refresh and confirm again"}\n    else:\n${body.split("\n").map(line => "    " + line).join("\n")}\n    print(${pythonJson(marker)} + json.dumps(_result))\n`;
    const controller = new AbortController();
    this.requests.add(controller);
    let receipt: T | undefined;
    const diagnostics: string[] = [];
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Package request cancelled or timed out")), { once: true }));
    try {
      const execution = Promise.resolve().then(() => {
        this.check();
        if (controller.signal.aborted) throw new Error("Package request cancelled");
        return this.options.executeOnce({ ...this.options.target }, script, this.options.token, event => {
          if (controller.signal.aborted) return;
          if (event.stream === "stderr") { diagnostics.push(event.text.slice(-4000)); if (diagnostics.length > 20) diagnostics.shift(); }
          if (event.stream === "stdout") for (const line of event.text.split("\n")) if (line.startsWith(marker)) receipt = JSON.parse(line.slice(marker.length)) as T;
        }, controller.signal);
      });
      const result = await Promise.race([execution, aborted]);
      this.check();
      if (!result.success || receipt === undefined) throw new Error(result.output?.data || diagnostics.join("\n") || "No package result received");
      const rejected = object(receipt)._rejected;
      if (typeof rejected === "string") throw new PackageRequestRejected(rejected);
      return receipt;
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }

  async list(): Promise<PackageSnapshot> {
    this.idle();
    return this.request<PackageSnapshot>('    _result = {"fingerprint": _fp, "packages": msgspec.to_builtins(ctx.packages.list())}');
  }

  async dependencyTree(): Promise<unknown> {
    this.idle();
    const result = await this.request<unknown>('    _result = msgspec.to_builtins(ctx._kernel.packages_callbacks.package_manager.dependency_tree(filename=ctx._kernel.app_metadata.filename)) if _fp["capabilities"]["tree"] else None');
    if (result === null) throw new Error("Dependency tree unavailable");
    return result;
  }

  /** Confirmation is explicit and defaults to cancel. No action is performed by list/tree. */
  async mutate(action: PackageAction, spec: string, confirm: (question: PackageConfirmation) => Promise<boolean>): Promise<PackageMutationResult> {
    this.idle();
    if (this.pending || this.unknown || this.options.notebook.environment.activeMutation) throw new Error(this.unknown ? "Package outcome unknown; reconcile before another mutation" : "A package operation is already active");
    // PackageManager ultimately builds argv from split_packages. Reject CLI
    // flags rather than allowing a requirement to override manager policy
    // (including cooldown configuration). Quoting is not a shell escape here.
    if (!["install", "upgrade", "remove"].includes(action) || !spec.trim() || spec.includes("\0") || /(?:^|[\s"'])-/u.test(spec)) throw new Error("Invalid package request; enter requirements, not command-line options");
    this.pending = true;
    let submitted = false;
    try {
      const { fingerprint } = await this.list();
      if (fingerprint.version !== "0.25.0" || !["manager", "install", "remove", "metadata", "notifications"].every(key => fingerprint.capabilities[key])) throw new Error("Package management unavailable for this marimo version or manager");
      if (!await confirm({ action, spec, fingerprint, warning: "This kernel environment may be shared with the server or other notebooks. Changes affect every user of this environment.", defaultChoice: "cancel" })) return { status: "cancelled" };
      this.idle();
      if (this.options.notebook.environment.activeMutation) throw new Error("A package operation is already active");
      this.uncertain = { action: action === "remove" ? "remove" : "install", spec, previousIds: new Set(this.options.notebook.environment.operations.keys()) };
      submitted = true;
      const result = await this.request<PackageMutationResult>(MUTATE_BODY, { action, spec, fingerprint });
      await this.list();
      this.uncertain = undefined;
      return result;
    } catch (error) {
      if (error instanceof PackageRequestRejected) { this.uncertain = undefined; throw error; }
      if (submitted) {
        this.unknown = true;
        try { await this.options.reconcile(); await this.list(); } catch { /* Read-only reconciliation never replays an action. */ }
        throw new Error(`Package outcome unknown; do not repeat the action: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    } finally { this.pending = false; }
  }

  /** Explicit read-only reconciliation; an unresolved streamed operation stays blocked. */
  async reconcile(): Promise<PackageSnapshot> {
    await this.options.reconcile();
    const snapshot = await this.list();
    const uncertain = this.uncertain;
    const resolved = uncertain && [...this.options.notebook.environment.operations].some(([key, operation]) =>
      !uncertain.previousIds.has(key) && operation.source === "kernel" && operation.action === uncertain.action &&
      Object.hasOwn(operation.packages, uncertain.spec) && operation.status.kind !== "running");
    if (!this.options.notebook.environment.activeMutation && resolved) {
      this.unknown = false;
      this.uncertain = undefined;
    }
    return snapshot;
  }
}

const MUTATE_BODY = `    if _fp != _args["fingerprint"]:
        _result = {"_rejected": "Environment changed; refresh and confirm again"}
    elif _fp["version"] != "0.25.0" or not all(_fp["capabilities"].get(key) for key in ("manager", "install", "remove", "metadata", "notifications")):
        _result = {"_rejected": "Package management unavailable"}
    else:
${`    from marimo._runtime.packages.operations import environment_operation
    from marimo._messaging.notification_utils import broadcast_notification
    from marimo._runtime.packages.utils import split_packages
    from marimo._config.settings import GLOBAL_SETTINGS
    pm = ctx._kernel.packages_callbacks.package_manager
    spec = _args["spec"]
    removing = _args["action"] == "remove"
    upgrade = _args["action"] == "upgrade"
    statuses = {spec: "queued"}
    with environment_operation("remove" if removing else "install", statuses, "kernel", partial(broadcast_notification, stream=ctx._kernel.stream)) as operation:
        statuses[spec] = "running"
        operation.update()
        success = await pm.uninstall(spec) if removing else await pm.install(spec, version=None, upgrade=upgrade, log_callback=lambda line: operation.update({spec: line}))
        statuses[spec] = "succeeded" if success else "restart-required" if pm.restart_required else "failed"
        operation.update()
        if success and GLOBAL_SETTINGS.MANAGE_SCRIPT_METADATA is True and ctx._kernel.app_metadata.filename is not None:
            try:
                metadata_ok = await asyncio.to_thread(pm.update_notebook_script_metadata, filepath=ctx._kernel.app_metadata.filename, **({"packages_to_remove": split_packages(spec)} if removing else {"packages_to_add": split_packages(spec)}), upgrade=upgrade)
                if metadata_ok is False:
                    raise RuntimeError("Metadata update failed")
            except Exception as exc:
                raise RuntimeError("Environment change possibly applied; metadata write failed; do not repeat package action") from exc
    _result = {"status": statuses[spec]}
`.split("\n").map(line => "    " + line).join("\n")}`;
