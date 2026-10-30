// Single-attempt, session-bound cell mutations. Target acquisition belongs to the caller.
import { randomUUID } from "node:crypto";
import { runScratch, type ScratchEvent, type ScratchResult } from "../ui/scratch.js";
import type { NotebookState } from "./notebook.js";

export interface SaveReceipt { canonicalCode: string; requestId: string }
export interface EditorSession { url: string; sessionId: string }
export type ScratchExecute = (target: EditorSession, code: string, token: string | undefined, onEvent: (event: ScratchEvent) => void, signal: AbortSignal) => Promise<ScratchResult>;
export interface EditCellOptions {
  target: EditorSession;
  notebook: NotebookState;
  /** Must include notebook/kernel identity, not just server URL. */
  isCurrent: () => boolean;
  /** Read-only refresh after an uncertain outcome. Must never repost the mutation. */
  reconcile: () => void | Promise<void>;
  token?: string;
  execute?: ScratchExecute;
  timeoutMs?: number;
  onRunError?: (error: Error) => void;
}

/** JSON string nested in a JSON string: Python sees only an ASCII string literal. */
export function pythonJson(value: unknown): string {
  const json = JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `json.loads(${JSON.stringify(json)})`;
}

export class EditCellService {
  private requests = new Set<AbortController>();
  private disposed = false;
  constructor(private readonly options: EditCellOptions) {}

  dispose(): void {
    this.disposed = true;
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }

  private check(): void {
    if (this.disposed || !this.options.isCurrent()) throw new Error("Notebook session changed; your draft is kept");
  }

  private start(code: string, onEvent: (event: ScratchEvent, accepted: () => void) => void): { done: Promise<ScratchResult> } {
    this.check();
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Request cancelled or timed out; outcome unknown")), { once: true }));
    const execution = Promise.resolve().then(() => {
      this.check();
      if (controller.signal.aborted) throw new Error("Request cancelled; outcome unknown");
      return (this.options.execute ?? runScratch)(
        { ...this.options.target }, code, this.options.token, event => {
          if (!controller.signal.aborted) onEvent(event, () => clearTimeout(timer));
        }, controller.signal,
      );
    });
    const done = Promise.race([execution, aborted]).finally(() => {
      clearTimeout(timer);
      this.requests.delete(controller);
    });
    return { done };
  }

  async saveCell(cellId: string, code: string, expectedCode: string): Promise<SaveReceipt> {
    this.check();
    const nb = this.options.notebook;
    if ([...nb.cells.values()].some(c => c.status === "running" || c.status === "queued")) throw new Error("Kernel is busy; your draft is kept. Save when idle.");
    if (!nb.cells.has(cellId)) throw new Error("Cell no longer exists; your draft is kept");
    const requestId = randomUUID();
    const marker = `pi-marimo-save-${requestId}:`;
    const args = pythonJson({ cellId, code, expectedCode });
    const script = `import json\nimport marimo._code_mode as cm\n_args = ${args}\nasync with cm.get_context() as ctx:\n    if ctx.cells[_args["cellId"]].code != _args["expectedCode"]:\n        raise ValueError("Cell changed elsewhere; your draft was not saved")\n    ctx.edit_cell(_args["cellId"], code=_args["code"])\nprint(${pythonJson(marker)} + json.dumps({"canonicalCode": ctx.cells[_args["cellId"]].code, "requestId": ${pythonJson(requestId)}}))\n`;
    let receipt: SaveReceipt | undefined;
    const diagnostics: string[] = [];
    nb.beginUserEdit(cellId, requestId);
    try {
      const { done } = this.start(script, event => {
        if (event.stream === "stderr") { diagnostics.push(event.text.slice(-4000)); if (diagnostics.length > 20) diagnostics.shift(); }
        if (event.stream !== "stdout" || !event.text.startsWith(marker)) return;
        const value: unknown = JSON.parse(event.text.slice(marker.length));
        if (value && typeof value === "object" && "canonicalCode" in value && typeof value.canonicalCode === "string" && "requestId" in value && value.requestId === requestId) receipt = value as SaveReceipt;
      });
      const result = await done;
      this.check();
      if (!result.success || !receipt) throw new Error(result.output?.data || diagnostics.slice(-20).join("\n") || "Save outcome unknown: no canonical receipt");
      if (nb.cells.get(cellId)?.code !== receipt.canonicalCode) {
        await this.options.reconcile();
        this.check();
      }
      if (!nb.finishUserEdit(cellId, requestId, receipt.canonicalCode)) throw new Error("Save outcome unknown: canonical source and transaction disagree");
      return receipt;
    } catch (error) {
      nb.finishUserEdit(cellId, requestId);
      try { await this.options.reconcile(); } catch { /* Preserve the mutation failure; never retry it. */ }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Cell changed elsewhere; your draft was not saved")) throw new Error("Cell changed elsewhere; your draft was not saved");
      throw new Error(/outcome unknown/iu.test(message) ? message : `Save outcome unknown: ${message}`);
    }
  }

  /** Resolves on checked queue acceptance; owns the scratch stream until execution finishes. */
  async runSavedCell(cellId: string, canonicalCode: string): Promise<void> {
    this.check();
    const marker = `pi-marimo-run-${randomUUID()}:accepted`;
    const script = `import json\nimport marimo._code_mode as cm\n_args = ${pythonJson({ cellId, canonicalCode })}\nasync with cm.get_context() as ctx:\n    if ctx.cells[_args["cellId"]].code != _args["canonicalCode"]:\n        raise ValueError("Cell changed elsewhere")\n    ctx.run_cell(_args["cellId"])\n    print(${pythonJson(marker)}, flush=True)\n`;
    return new Promise<void>((resolve, reject) => {
      let accepted = false;
      const diagnostics: string[] = [];
      const fail = (reason: unknown) => {
        const error = new Error(`Saved, but not run: ${reason instanceof Error ? reason.message : String(reason)}`);
        if (!accepted) reject(error);
        else this.options.onRunError?.(error);
      };
      const { done } = this.start(script, (event, keepAlive) => {
        if (event.stream === "stderr") { diagnostics.push(event.text.slice(-4000)); if (diagnostics.length > 20) diagnostics.shift(); }
        if (event.stream !== "stdout" || event.text !== marker) return;
        try { this.check(); accepted = true; keepAlive(); resolve(); } catch (error) { fail(error); }
      });
      void done.then(result => {
        this.check();
        if (!accepted || !result.success) throw new Error(result.output?.data || diagnostics.slice(-20).join("\n") || "run outcome unknown");
      }).catch(error => { fail(error); void Promise.resolve(this.options.reconcile()).catch(() => {}); });
    });
  }
}
