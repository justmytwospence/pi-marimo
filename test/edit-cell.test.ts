import { execFileSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { EditCellService, pythonJson, type ScratchExecute } from "../src/core/edit-cell.js";
import { NotebookState } from "../src/core/notebook.js";
import type { ScratchEvent, ScratchResult } from "../src/ui/scratch.js";

function fixture() {
  const nb = new NotebookState();
  nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["x = 1"] });
  // Bypass reconnect replay's attribution grace window, without timers shared by other tests.
  Object.assign(nb, { readyAt: Date.now() - 2000 });
  let current = true;
  const reconcile = vi.fn();
  const tx = (code: string) => nb.apply("notebook-document-transaction", { transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "a", code }] } });
  const execute = vi.fn<ScratchExecute>();
  const service = new EditCellService({ target: { url: "http://fixture", sessionId: "session" }, notebook: nb, isCurrent: () => current, reconcile, execute });
  return { nb, service, execute, reconcile, tx, changeSession: () => { current = false; } };
}
function receipt(script: string, onEvent: (e: ScratchEvent) => void, canonicalCode: string) {
  const requestId = /pi-marimo-save-([a-f0-9-]+):/u.exec(script)![1]!;
  onEvent({ stream: "stdout", text: `pi-marimo-save-${requestId}:` + JSON.stringify({ canonicalCode, requestId }) });
}
const ok = { success: true };

describe("single-attempt saves", () => {
  test("JSON marshalling round trips Python syntax, booleans, newlines, unicode and injection", () => {
    const value = { id: '\"\\\n', code: '🌈 é\nprint("x")\n', boolean: true, nil: null, attack: "'); raise Exception(); #" };
    const result = execFileSync("python3", ["-c", `import json\nprint(json.dumps(${pythonJson(value)}))`], { encoding: "utf8" });
    expect(JSON.parse(result)).toEqual(value);
  });
  test("strict compare in edit-only context; post-exit canonical receipt defers attribution", async () => {
    const f = fixture();
    f.execute.mockImplementation(async (_, script, __, emit) => {
      expect(script).toContain('ctx.cells[_args["cellId"]].code != _args["expectedCode"]');
      expect(script).toContain('ctx.edit_cell(_args["cellId"], code=_args["code"])');
      expect(script).not.toContain("run_cell");
      expect(script).not.toContain("skip_staleness_check");
      expect(script).toContain('\nprint(');
      f.tx("x = 2");
      expect(f.nb.agentChanges.size).toBe(0);
      receipt(script, emit, "x = 2");
      return ok;
    });
    expect(await f.service.saveCell("a", "x=2", "x = 1")).toMatchObject({ canonicalCode: "x = 2", requestId: expect.any(String) });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.nb.agentChanges.size).toBe(0);
    f.tx("x = 3");
    expect(f.nb.agentChanges.has("a")).toBe(true);
  });
  test("no-op receipt needs no transaction, and leaves no attribution exemption", async () => {
    const f = fixture();
    f.execute.mockImplementation(async (_, script, __, emit) => { receipt(script, emit, "x = 1"); return ok; });
    await f.service.saveCell("a", "x = 1", "x = 1");
    f.tx("x = 2"); f.tx("x = 1");
    expect(f.nb.agentChanges.has("a")).toBe(true);
  });
  test("unrelated pending transactions remain agent edits", async () => {
    const f = fixture();
    f.execute.mockImplementation(async (_, script, __, emit) => {
      f.tx("unrelated = 1"); f.tx("x = 2"); receipt(script, emit, "x = 2"); return ok;
    });
    await f.service.saveCell("a", "x=2", "x = 1");
    expect(f.nb.agentChanges.get("a")).toMatchObject({ before: "x = 1" });
  });
  test.each(["HTTP500", "timeout", "Cell changed elsewhere; your draft was not saved", "deleted cell"])("%s is never replayed and releases attribution", async reason => {
    const f = fixture();
    f.execute.mockImplementation(async () => { f.tx("agent = 1"); throw new Error(reason); });
    await expect(f.service.saveCell("a", "x=2", "x = 1")).rejects.toThrow(reason);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.nb.agentChanges.has("a")).toBe(true);
    // A new attempt is possible; the failed expectation is gone.
    f.nb.beginUserEdit("a", "new"); f.nb.finishUserEdit("a", "new");
  });
  test("a successful transport without a receipt is unknown, never a save acknowledgement", async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => { f.tx("x = 2"); return ok; });
    await expect(f.service.saveCell("a", "x=2", "x = 1")).rejects.toThrow("no canonical receipt");
    expect(f.nb.agentChanges.has("a")).toBe(true);
    expect(f.execute).toHaveBeenCalledOnce();
  });
  test("canonical mismatch is unknown and releases all candidates", async () => {
    const f = fixture();
    f.execute.mockImplementation(async (_, script, __, emit) => { f.tx("other = 1"); receipt(script, emit, "x = 2"); return ok; });
    await expect(f.service.saveCell("a", "x=2", "x = 1")).rejects.toThrow("outcome unknown");
    expect(f.nb.agentChanges.has("a")).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  test("no transaction can reconcile read-only to receipt", async () => {
    const f = fixture();
    f.reconcile.mockImplementation(() => { f.nb.cells.get("a")!.code = "x = 2"; });
    f.execute.mockImplementation(async (_, script, __, emit) => { receipt(script, emit, "x = 2"); return ok; });
    await expect(f.service.saveCell("a", "x=2", "x = 1")).resolves.toMatchObject({ canonicalCode: "x = 2" });
    expect(f.reconcile).toHaveBeenCalledOnce();
  });
  test.each(["running", "queued"])("busy %s refuses save before sending", async status => {
    const f = fixture(); f.nb.cells.get("a")!.status = status;
    await expect(f.service.saveCell("a", "x=2", "x = 1")).rejects.toThrow("Kernel is busy");
    expect(f.execute).not.toHaveBeenCalled();
  });
  test("missing cell and changed session refuse before sending", async () => {
    const f = fixture();
    await expect(f.service.saveCell("missing", "", "")).rejects.toThrow("no longer exists");
    f.changeSession();
    await expect(f.service.saveCell("a", "", "")).rejects.toThrow("session changed");
    expect(f.execute).not.toHaveBeenCalled();
  });
  test("session changes after submission fail and release attribution", async () => {
    const f = fixture();
    f.execute.mockImplementation(async (_, script, __, emit) => { f.tx("x = 2"); receipt(script, emit, "x = 2"); f.changeSession(); return ok; });
    await expect(f.service.saveCell("a", "x=2", "x = 1")).rejects.toThrow("session changed");
    expect(f.nb.agentChanges.has("a")).toBe(true);
  });
  test("a real deadline aborts once and releases attribution without replay", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let signal!: AbortSignal;
      f.execute.mockImplementation(async (_, __, ___, ____, s) => { signal = s; f.tx("agent = 2"); return new Promise(() => {}); });
      const save = f.service.saveCell("a", "x=2", "x = 1");
      const failure = expect(save).rejects.toThrow("outcome unknown");
      await vi.advanceTimersByTimeAsync(120_000);
      await failure;
      expect(signal.aborted).toBe(true);
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.nb.agentChanges.has("a")).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  test("disposal aborts outstanding saves and refuses further requests", async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => new Promise(() => {}));
    const save = f.service.saveCell("a", "x=2", "x = 1");
    await Promise.resolve(); f.service.dispose();
    await expect(save).rejects.toThrow("outcome unknown");
    await expect(f.service.saveCell("a", "x=2", "x = 1")).rejects.toThrow("session changed");
  });
});

describe("explicit checked run", () => {
  test("resolves at acceptance before long execution, using IDs only and owning stream", async () => {
    const f = fixture();
    let finish!: (value: ScratchResult) => void;
    let signal!: AbortSignal;
    f.execute.mockImplementation((_, script, __, emit, requestSignal) => {
      expect(script).toContain('ctx.cells[_args["cellId"]].code != _args["canonicalCode"]');
      expect(script).toContain('ctx.run_cell(_args["cellId"])');
      expect(script).not.toContain("edit_cell");
      expect(script).toContain('\n    print(');
      signal = requestSignal;
      const marker = /pi-marimo-run-[a-f0-9-]+:accepted/u.exec(script)![0];
      emit({ stream: "stdout", text: marker });
      return new Promise(resolve => { finish = resolve; });
    });
    f.nb.cells.get("a")!.status = "running"; // Only saves have a busy refusal.
    await f.service.runSavedCell("a", "x = 1");
    expect(signal.aborted).toBe(false);
    expect(f.execute).toHaveBeenCalledOnce();
    finish(ok); await Promise.resolve();
    f.service.dispose();
  });
  test("accepted runs remain owned beyond the request deadline and are disposed", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let signal!: AbortSignal;
      f.execute.mockImplementation(async (_, script, __, emit, s) => {
        signal = s;
        emit({ stream: "stdout", text: /pi-marimo-run-[a-f0-9-]+:accepted/u.exec(script)![0] });
        return new Promise(() => {});
      });
      await f.service.runSavedCell("a", "x = 1");
      await vi.advanceTimersByTimeAsync(360_000);
      expect(signal.aborted).toBe(false);
      f.service.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  test("session change before acceptance rejects the run without replay", async () => {
    const f = fixture();
    f.execute.mockImplementation(async (_, script, __, emit) => {
      f.changeSession();
      emit({ stream: "stdout", text: /pi-marimo-run-[a-f0-9-]+:accepted/u.exec(script)![0] });
      return ok;
    });
    await expect(f.service.runSavedCell("a", "x = 1")).rejects.toThrow("session changed");
    expect(f.execute).toHaveBeenCalledOnce();
  });
  test("no acceptance marker is not a successful run", async () => {
    const f = fixture(); f.execute.mockResolvedValue(ok);
    await expect(f.service.runSavedCell("a", "x = 1")).rejects.toThrow("Saved, but not run: run outcome unknown");
    expect(f.execute).toHaveBeenCalledOnce();
  });
  test("run rejection does not replay or affect saved code", async () => {
    const f = fixture();
    f.execute.mockResolvedValue({ success: false, output: { mimetype: "text/plain", data: "Cell changed elsewhere" } });
    await expect(f.service.runSavedCell("a", "x = 1")).rejects.toThrow("Saved, but not run: Cell changed elsewhere");
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.nb.cells.get("a")!.code).toBe("x = 1");
  });
});
