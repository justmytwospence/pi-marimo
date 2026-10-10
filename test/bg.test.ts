import { describe, expect, test } from "vitest";
import { BgBridge } from "../src/bg.js";
import { withWaitHint } from "../src/index.js";

function bus() {
  const sent: Array<[string, any]> = [];
  return { sent, emit: (channel: string, data: unknown) => void sent.push([channel, data]) };
}

/** A followed notebook, as much of one as the bridge reads. */
function followed(path: string, state: { running?: string; queued?: number; errors?: number; connection?: string } = {}): any {
  return {
    attachment: { path },
    connection: state.connection ?? "connected",
    current: false,
    touchedAt: 0,
    notebook: {
      running: () => (state.running ? { section: [state.running], cell: { name: "_", id: "c1" } } : undefined),
      queued: () => state.queued ?? 0,
      errors: () => Array.from({ length: state.errors ?? 0 }, () => ({})),
    },
  };
}

describe("pi-bg: busy notebooks as outside work", () => {
  test("running, then done with what the run took", () => {
    const b = bus();
    const bridge = new BgBridge(b, () => []);
    bridge.external([followed("/p/fit.py", { running: "Model fit" })], "/p", 1_000);
    bridge.external([followed("/p/fit.py", { running: "Model fit" })], "/p", 2_000);
    expect(bridge.runningIds()).toEqual(["marimo:fit.py"]);
    bridge.external([followed("/p/fit.py")], "/p", 63_000);
    expect(b.sent).toEqual([
      ["bg:external", { id: "marimo:fit.py", label: "fit.py: Model fit", state: "running" }],
      ["bg:external", { id: "marimo:fit.py", label: "fit.py", state: "done", summary: "ran 1m02s" }],
    ]);
    expect(bridge.runningIds()).toEqual([]);
  });

  test("errors, a disconnect or an unfollowed notebook end it as failed; shared names use the path", () => {
    const b = bus();
    const bridge = new BgBridge(b, () => []);
    const a = followed("/p/a/nb.py", { queued: 2 });
    const c = followed("/p/c/nb.py", { running: "Load" });
    bridge.external([a, c], "/p", 0);
    expect(b.sent.map(([, d]) => d.id)).toEqual(["marimo:a/nb.py", "marimo:c/nb.py"]);
    bridge.external([followed("/p/a/nb.py", { errors: 1 })], "/p", 5_000);
    expect(b.sent.slice(2).map(([, d]) => [d.id, d.state, d.summary])).toEqual([
      ["marimo:a/nb.py", "failed", "ran 5s · 1 error"],
      ["marimo:c/nb.py", "failed", "ran 5s · no longer followed"],
    ]);
  });
});

describe("pi-bg: no second notice for a run a waking job drives", () => {
  test("covered only by a job that will wake the agent and targets that notebook", () => {
    const bridge = new BgBridge(undefined, (command) => (command.includes("fit") ? ["/p/fit.py"] : []));
    bridge.onTasks([{ id: "x", command: "execute-code.sh --url u --file fit.py", origin: "agent", status: "running", willWake: true }]);
    bridge.noteCovered(["/p/fit.py", "/p/prep.py"]);
    expect(bridge.coversAll(["/p/fit.py"])).toBe(true);
    expect(bridge.coversAll(["/p/fit.py", "/p/prep.py"])).toBe(false);
    // Once covered, it stays covered after the job ended (it wakes the agent about the end).
    bridge.onTasks([]);
    expect(bridge.coversAll(["/p/fit.py"])).toBe(true);
    bridge.resetHold();
    expect(bridge.coversAll(["/p/fit.py"])).toBe(false);
    bridge.onTasks([{ id: "y", command: "execute-code.sh --file fit.py", origin: "agent", status: "running", willWake: false }]);
    bridge.noteCovered(["/p/fit.py"]);
    expect(bridge.coversAll(["/p/fit.py"])).toBe(false);
  });
});

describe("the bg_wait hint in the state block", () => {
  const block = "<marimo_notebook_state notebooks=\"1\">\nstate\n</marimo_notebook_state>";
  test("only with pi-bg loaded and a notebook running", () => {
    const listening = { events: { emit: (_c: string, d: any) => d?.reply?.() } } as any;
    const silent = { events: { emit: () => {} } } as any;
    expect(withWaitHint(block, ["marimo:fit.py"], listening)).toBe(
      "<marimo_notebook_state notebooks=\"1\">\nstate\nTo wait for a running notebook inside your turn, call bg_wait with its id: marimo:fit.py.\n</marimo_notebook_state>",
    );
    expect(withWaitHint(block, ["marimo:fit.py"], silent)).toBe(block);
    expect(withWaitHint(block, [], listening)).toBe(block);
  });
});
