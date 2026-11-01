// Standalone adapter: native Pi messages + real execution host, no extensions,
// sockets, marimo servers, Python kernels, browser, or companion event handlers.
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { ExecutionHost, type ExecutionObserverOptions, type ExecutionRecord, type WaveObserver } from "../src/core/execution.js";
import type { WaveSnapshot } from "../src/core/execution-observer.js";
import { NotebookState } from "../src/core/notebook.js";
import type { Followed } from "../src/core/watcher.js";
import { COMPLETION_MESSAGE, EXECUTION_ENTRY, ExecutionSession, normalizeExecutionConfig, registerExecutionTools, type ExecutionContext } from "../src/executions.js";

class Child extends EventEmitter {
  pid = 123;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  code = "";
  kill = vi.fn(() => true);
  constructor() {
    super();
    this.stdin.on("data", chunk => { this.code += String(chunk); });
  }
  finish(code = 0): void { this.emit("close", code, null); }
}

class Observer implements WaveObserver {
  value: WaveSnapshot = { connection: "connected" };
  start = vi.fn();
  stop = vi.fn();
  constructor(readonly options: ExecutionObserverOptions) {
    if (options.seedBusyCells?.length) this.value = this.wave("seed", "running", options.seedBusyCells);
  }
  snapshot(): WaveSnapshot { return structuredClone(this.value); }
  wave(id: string, state: "running" | "succeeded" | "failed", busyCells: string[] = []): WaveSnapshot {
    return { connection: "connected", wave: { id, state, startedAt: 1, ...(state !== "running" ? { endedAt: 2 } : {}), busyCells, errors: state === "failed" ? ["fit: ValueError"] : [], blocked: state === "failed" ? ["child"] : [] } };
  }
  emit(id: string, state: "running" | "succeeded" | "failed", busy: string[] = []): void {
    this.value = this.wave(id, state, busy);
    this.options.onChange?.(this.snapshot());
  }
}

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  throw new Error("Test condition was not reached");
}
function notebook(path = "/w/fit.py", url = "http://localhost:2799", sessionId = "kernel"): Followed {
  const state = new NotebookState(() => {});
  state.ready = true;
  return { attachment: { path, url, sessionId }, canonicalPath: path, connection: "connected", notebook: state, current: true, touchedAt: 1, engaged: true };
}

function setup(mode: "subscribed" | "all" | "off" = "subscribed", options: { inline?: boolean; context?: boolean; holdHelp?: boolean } = {}) {
  let nextEntry = 0;
  let nextId = 0;
  let sessionId = "conversation";
  let entries: any[] = [];
  const messages: any[] = [];
  const tools = new Map<string, any>();
  const children: Child[] = [];
  const probes: Child[] = [];
  const spawns: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const observers: Observer[] = [];
  const persistent = (type: string, extra: object) => {
    const entry = { id: `entry-${++nextEntry}`, parentId: entries.at(-1)?.id ?? null, type, ...extra };
    entries.push(entry);
    return entry;
  };
  const pi = {
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    appendEntry: vi.fn((customType: string, data: unknown) => { persistent("custom", { customType, data: structuredClone(data) }); }),
    sendMessage: vi.fn((message: any, delivery: any) => {
      messages.push({ ...message, delivery });
      persistent("custom_message", { ...structuredClone(message) });
    }),
  };
  // No UI/editor API exists on this fake; touching the user's draft would fail.
  const ctx: ExecutionContext = {
    cwd: "/w",
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => entries,
    },
  };
  const host = new ExecutionHost({
    id: () => `automatic-${++nextId}`,
    spawn: (command, args, spawnOptions) => {
      spawns.push({ command, args, options: spawnOptions });
      const child = new Child();
      if (args.includes("--help")) {
        probes.push(child);
        if (!options.holdHelp) queueMicrotask(() => { child.stdout.write("--url --session --code-file --stream\n"); child.finish(); });
      } else {
        children.push(child);
        if (options.inline) child.stdin.once("finish", () => { child.stdout.write("inline result\n"); child.finish(); });
      }
      return child as unknown as ChildProcess;
    },
    observerFactory: settings => {
      const observer = new Observer(settings);
      observers.push(observer);
      // Automatic observer ownership must already have a persisted policy anchor.
      if (mode === "all") expect(entries.some(e => e.data?.kind === "policy")).toBe(true);
      return observer;
    },
  });
  const command = vi.fn(() => ({ command: ["fake-marimo"], cwd: "/project" }));
  const acquireTarget = vi.fn(async (f: Followed) => f.attachment);
  const engage = vi.fn((f: Followed) => { f.engaged = true; });
  const hostFactory = vi.fn(() => host);
  const deps = { host: hostFactory, command, acquireTarget, engage, id: () => `native-${++nextId}` };
  let manager = new ExecutionSession(pi as any, deps);
  const config = { completion: { mode }, context: options.context ?? true };
  const followed = [notebook()];
  const start = () => { manager.start(ctx, config); manager.update(followed); };
  const tool = (name: string, params: any = {}, signal?: AbortSignal) => tools.get(name).execute("tool-call", params, signal, undefined, ctx);
  cleanup.push(() => { manager.shutdown(); host.dispose(); });
  return {
    pi, ctx, deps, config, host, tools, messages, children, probes, spawns, observers, followed, command, acquireTarget, engage, hostFactory,
    get manager() { return manager; },
    get entries() { return entries; },
    set entries(value: any[]) { entries = value; },
    start, tool, persistent,
    setSession(id: string) { sessionId = id; },
    rebind() { manager.shutdown(); manager = new ExecutionSession(pi as any, deps); start(); },
    register() { registerExecutionTools(pi as any, manager); },
  };
}

function record(result: { details: Record<string, unknown> }): ExecutionRecord { return result.details as unknown as ExecutionRecord; }
function snapshots(x: ReturnType<typeof setup>): any[] { return x.entries.filter(e => e.customType === EXECUTION_ENTRY && e.data?.kind === "snapshot"); }

test("factory registers three Type.Object native tools but initializes no host until startup", () => {
  const x = setup();
  x.register();
  expect([...x.tools.keys()]).toEqual(["marimo_execute", "marimo_watch", "marimo_execution"]);
  expect(x.hostFactory).not.toHaveBeenCalled();
  expect(x.spawns).toEqual([]);
  expect(x.observers).toEqual([]);
  for (const tool of x.tools.values()) {
    expect(tool.parameters.type).toBe("object");
    expect(tool.promptGuidelines.join(" ")).toMatch(/official.*CLI/);
    expect(tool.promptGuidelines.join(" ")).toContain("help(cm)");
    expect(tool.promptGuidelines.join(" ")).toContain("Never poll a busy kernel");
  }
  x.start();
  expect(x.hostFactory).toHaveBeenCalledOnce();
  expect(x.spawns).toEqual([]);
  expect(x.observers).toEqual([]);
});

test("delayed official execution survives unrelated turns and sends exactly one native follow-up", async () => {
  const x = setup(); x.start(); x.register();
  const result = await x.tool("marimo_execute", { code: "SECRET_SOURCE()", yield_ms: 0 });
  const r = record(result);
  expect(r.state).toBe("running");
  expect(result.details.subscribed).toBe(true);
  const registration = x.entries.find(e => e.data?.kind === "registration");
  expect(r.owner).toEqual({ sessionId: "conversation", anchorId: registration.id });
  expect(registration.data.id).toBe(r.id);
  expect(x.engage).toHaveBeenCalledOnce();
  expect(x.command).toHaveBeenCalledWith(x.followed[0], normalizeExecutionConfig(x.config), "/w");
  expect(x.spawns.at(-1)?.args).toEqual(["pair", "execute", "--url", "http://localhost:2799", "--session", "kernel", "--code-file", "-", "--stream"]);
  expect(x.spawns.at(-1)?.options).toMatchObject({ cwd: "/project", shell: false });
  expect(x.children[0]?.code).toBe("SECRET_SOURCE()");
  expect(JSON.stringify(snapshots(x))).not.toContain("SECRET_SOURCE");
  for (let i = 0; i < 4; i++) { x.persistent("message", { message: { role: "user", content: "Unrelated question" } }); expect(x.manager.beforeTurn()).toContain(r.id); }
  expect(x.children[0]?.kill).not.toHaveBeenCalled();
  x.children[0]!.stdout.write("done\n");
  x.children[0]!.finish();
  await tick();
  expect(x.messages).toHaveLength(1);
  expect(x.messages[0]).toMatchObject({ customType: COMPLETION_MESSAGE, delivery: { deliverAs: "followUp", triggerTurn: true }, details: { ids: [`pi-marimo-execution:${r.id}`] } });
  expect(x.messages[0].content).toContain("Other work in the same kernel may still be busy");
  x.manager.beforeTurn(); x.manager.update(x.followed); await tick();
  expect(x.messages).toHaveLength(1);
  expect(record(x.manager.status(r.id)).delivery).toBe("delivered");
});

test("inline completion wins the reporting race without an automatic continuation", async () => {
  const x = setup("subscribed", { inline: true }); x.start();
  const result = await x.manager.execute({ code: "inline", yield_ms: 1000 });
  expect(record(result)).toMatchObject({ state: "succeeded", delivery: "delivered", detached: false });
  expect(result.content[0]?.text).toContain("inline result");
  await tick(); expect(x.messages).toEqual([]);
});

test("aborted foreground wait detaches without killing or unsubscribing the process", async () => {
  const x = setup(); x.start();
  const controller = new AbortController();
  const result = x.manager.execute({ code: "long", yield_ms: 1000 }, controller.signal);
  await until(() => x.children.length === 1);
  controller.abort();
  const r = record(await result);
  expect(r).toMatchObject({ detached: true, notification: "explicit" });
  expect(x.children[0]!.kill).not.toHaveBeenCalled();
  x.children[0]!.finish(); await tick();
  expect(x.messages).toHaveLength(1);
});

test("completions are batched even during a busy response, with untouched drafts and context:false", async () => {
  const x = setup("subscribed", { context: false });
  x.followed.push(notebook("/w/other.py", "http://localhost:2799", "second")); x.start();
  const a = record(await x.manager.execute({ notebook: "fit.py", code: "one", yield_ms: 0 }));
  const b = record(await x.manager.execute({ notebook: "other.py", code: "two", yield_ms: 0 }));
  x.children[0]!.finish(); x.children[1]!.finish(); await tick();
  expect(x.messages).toHaveLength(1);
  expect(x.messages[0].details.ids.sort()).toEqual([`pi-marimo-execution:${a.id}`, `pi-marimo-execution:${b.id}`].sort());
  expect(x.messages[0].delivery).toEqual({ deliverAs: "followUp", triggerTurn: true });
});

test("status/unsubscribe public aliases share tool ownership and never interrupt", async () => {
  const x = setup(); x.start(); x.register();
  const r = record(await x.tool("marimo_execute", { code: "long", yield_ms: 0 }));
  x.persistent("message", { message: { role: "user", content: "next" } });
  expect(record(await x.tool("marimo_execution", { id: r.id })).id).toBe(r.id);
  expect(x.manager.status().details.records).toHaveLength(1);
  expect((await x.tool("marimo_execution", { action: "unsubscribe", id: r.id })).content[0].text).toContain("Python execution was not interrupted");
  expect(x.manager.unsubscribe(r.id).details.subscribed).toBe(false);
  await expect(x.tool("marimo_execution", { action: "unsubscribe" })).rejects.toThrow("requires");
  x.children[0]!.finish(); await tick();
  expect(record(x.manager.status(r.id)).state).toBe("succeeded");
  expect(x.messages).toEqual([]);
  expect(x.children[0]!.kill).not.toHaveBeenCalled();
});

test("mode off suppresses explicit execution and watch continuations without suppressing results", async () => {
  const x = setup("off"); x.start();
  const r = record(await x.manager.execute({ code: "long", subscribe: true, yield_ms: 0 }));
  expect(x.manager.status(r.id).content[0]?.text).toContain("completion.mode=off");
  x.children[0]!.finish(); await tick();
  expect(x.messages).toEqual([]);
  expect(record(x.manager.status(r.id))).toMatchObject({ state: "succeeded", notification: "none" });
  x.followed[0]!.notebook.cells.set("fit", { id: "fit", status: "running" } as any);
  const watched = await x.manager.watch();
  expect(watched.details.subscribed).toBe(false);
  expect(watched.content[0]?.text).toContain("completion.mode=off");
  x.observers.at(-1)!.emit("seed", "succeeded"); await tick();
  expect(x.messages).toEqual([]);
  expect(x.acquireTarget).toHaveBeenCalledOnce(); // Execution only, never watch.
});

test("watching an unsubscribed native request rearms its original authoritative handle without executing again", async () => {
  const x = setup(); x.start();
  const result = record(await x.manager.execute({ code: "fit()", subscribe: false, yield_ms: 0 }));
  await until(() => x.children.length === 1);
  const first = await x.manager.watch();
  expect(first.details).toMatchObject({ id: result.id, subscribed: true });
  x.manager.unsubscribe(result.id);
  const rearmed = await x.manager.watch();
  expect(rearmed.details).toMatchObject({ id: result.id, subscribed: true });
  expect(x.children).toHaveLength(1);
  x.children[0]!.finish(); await tick();
  expect(x.messages).toHaveLength(1);
  expect(x.messages[0].details.ids).toEqual([`pi-marimo-execution:${result.id}`]);
});

test("watching an active off-mode native request never overrides the configured quiet policy", async () => {
  const x = setup("off"); x.start();
  const result = record(await x.manager.execute({ code: "fit()", yield_ms: 0 }));
  await until(() => x.children.length === 1);
  expect((await x.manager.watch()).details).toMatchObject({ id: result.id, subscribed: false });
  x.children[0]!.finish(); await tick();
  expect(x.messages).toEqual([]);
});

test("subscribe:false overrides all mode for the current request/wave", async () => {
  const x = setup("all"); x.start();
  const r = record(await x.manager.execute({ code: "quiet", subscribe: false, yield_ms: 0 }));
  x.observers[0]!.emit("wave", "running", ["__scratch__"]);
  x.children[0]!.finish(); x.observers[0]!.emit("wave", "succeeded"); await tick();
  expect(x.messages).toEqual([]);
  expect(x.manager.status().details.records).toHaveLength(1);
  expect(record(x.manager.status(r.id)).delivery).toBe("suppressed");
});

test("all mode owns observers under a prior policy registration and only observes engaged notebooks", async () => {
  const x = setup("all");
  const passive = notebook("/w/not-engaged.py"); passive.engaged = false;
  x.followed.push(passive); x.start();
  expect(x.observers).toHaveLength(1);
  expect(x.spawns).toEqual([]);
  const policy = x.entries.find(e => e.data?.kind === "policy");
  x.observers[0]!.emit("one", "running", ["fit", "child", "__scratch__"]);
  const automatic = (x.manager.status().details.records as ExecutionRecord[])[0]!;
  expect(automatic).toMatchObject({ owner: { sessionId: "conversation", anchorId: policy.id }, notification: "automatic" });
  x.manager.unsubscribe(automatic.id);
  x.observers[0]!.emit("one", "succeeded"); await tick();
  expect(x.messages).toEqual([]);
  x.observers[0]!.emit("two", "running", ["fit"]);
  x.observers[0]!.emit("two", "failed"); await tick();
  expect(x.messages).toHaveLength(1);
  expect(x.messages[0].content).toContain("New notebook errors");
  expect(x.messages[0].content).toContain("Blocked cells: child");
  expect(x.messages[0].details.executions[0]).toMatchObject({ errors: ["fit: ValueError"], blocked: ["child"] });
});

test("watch uses busy evidence without writable acquisition and deduplicates a current wave", async () => {
  const x = setup(); x.start();
  x.followed[0]!.notebook.cells.set("fit", { id: "fit", status: "running" } as any);
  const a = record(await x.manager.watch());
  const b = record(await x.manager.watch({ notebook: "fit.py" }));
  expect(a.id).toBe(b.id);
  expect(x.acquireTarget).not.toHaveBeenCalled();
  expect(x.spawns).toEqual([]);
  x.observers[0]!.emit("seed", "succeeded"); await tick();
  expect(x.messages).toHaveLength(1);
});

test("idle watch obtains bounded evidence and never arms a future run", async () => {
  const x = setup(); x.start();
  vi.useFakeTimers();
  try {
    const watching = x.manager.watch();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await watching;
    expect(result.details).toEqual({ state: "unknown", subscribed: false });
    expect(result.content[0]?.text).toContain("No active execution was observed");
    expect(x.observers[0]!.stop).toHaveBeenCalledOnce();
    expect(x.acquireTarget).not.toHaveBeenCalled();
    expect(x.messages).toEqual([]);
  } finally { vi.useRealTimers(); }
});

test("busy document/native requests reject before acquisition and watch reuses native ID", async () => {
  const x = setup(); x.start();
  x.followed[0]!.notebook.cells.set("fit", { id: "fit", status: "queued" } as any);
  await expect(x.manager.execute({ code: "inspection" })).rejects.toThrow("Kernel is busy; use marimo_watch");
  expect(x.acquireTarget).not.toHaveBeenCalled();
  x.followed[0]!.notebook.cells.clear();
  const r = record(await x.manager.execute({ code: "long", yield_ms: 0 }));
  await expect(x.manager.execute({ code: "inspection" })).rejects.toThrow("Kernel is busy");
  expect(record(await x.manager.watch()).id).toBe(r.id);
  expect(x.acquireTarget).toHaveBeenCalledOnce();
});

test("selection requires engagement without selectors and full-path/url disambiguation", async () => {
  const x = setup();
  x.followed[0]!.engaged = false; x.start();
  await expect(x.manager.execute({ code: "x" })).rejects.toThrow("No matching engaged");
  x.followed[0]!.engaged = true;
  x.followed.push(notebook("/w/nested/fit.py")); x.manager.update(x.followed);
  await expect(x.manager.execute({ code: "x" })).rejects.toThrow("Ambiguous");
  // Exact full path wins, rather than a suffix or busiest-notebook heuristic.
  const first = record(await x.manager.execute({ notebook: "/w/fit.py", code: "x", yield_ms: 0 }));
  expect(first.target.path).toBe("/w/fit.py");
  x.children[0]!.finish(); await tick();
  x.followed.push(notebook("/w/fit.py", "http://localhost:2800", "other-server")); x.manager.update(x.followed);
  await expect(x.manager.execute({ notebook: "/w/fit.py", code: "x" })).rejects.toThrow("url");
  const second = record(await x.manager.execute({ notebook: "/w/fit.py", url: "http://127.0.0.1:2800", code: "x", yield_ms: 0 }));
  expect(second.target.sessionId).toBe("other-server");
});

test("ambiguous filenames do not match arbitrary path suffixes", async () => {
  const x = setup(); x.followed.splice(0, 1, notebook("/w/one/fit.py"), notebook("/w/two/fit.py")); x.start();
  await expect(x.manager.execute({ notebook: "fit.py", code: "x" })).rejects.toThrow("Ambiguous");
  await expect(x.manager.execute({ notebook: "ne/fit.py", code: "x" })).rejects.toThrow("No matching");
  expect(x.spawns).toEqual([]);
});

test("rechecks captured session after acquisition and immediately before CLI spawn, never retargets", async () => {
  const x = setup("subscribed", { holdHelp: true }); x.start();
  const executing = x.manager.execute({ code: "x", yield_ms: 1000 });
  await until(() => x.probes.length === 1);
  x.followed[0]!.attachment.sessionId = "replacement";
  x.probes[0]!.stdout.write("--url --session --code-file --stream\n"); x.probes[0]!.finish();
  const result = record(await executing);
  expect(result.state).toBe("failed");
  expect(result.summary).toContain("Nothing was submitted");
  expect(x.children).toEqual([]);
  expect(x.acquireTarget).toHaveBeenCalledOnce();
  await tick(); expect(x.messages).toEqual([]);
});

test("persistent identity and the exact registration leaf are required before dispatch", async () => {
  const x = setup(); x.setSession(""); x.start();
  await expect(x.manager.execute({ code: "x" })).rejects.toThrow("Persistent session identity");
  expect(x.spawns).toEqual([]);
  x.setSession("conversation"); x.start();
  x.pi.appendEntry.mockImplementation(() => {});
  await expect(x.manager.execute({ code: "x" })).rejects.toThrow("persist execution ownership");
  expect(x.spawns).toEqual([]);
});

test("active-branch descendants retain ownership; abandoned branches and forks cannot access/deliver", async () => {
  const x = setup(); x.start();
  const r = record(await x.manager.execute({ code: "x", yield_ms: 0 }));
  const branch = [...x.entries];
  x.persistent("message", { message: { role: "user" } });
  expect(record(x.manager.status(r.id)).id).toBe(r.id);
  x.entries = [];
  expect(() => x.manager.status(r.id)).toThrow("Unknown marimo execution");
  expect(() => x.manager.unsubscribe(r.id)).toThrow("Unknown marimo execution");
  expect(x.manager.activity(x.followed[0]!).running).toBe(false);
  x.children[0]!.finish(); await tick(); expect(x.messages).toEqual([]);
  x.entries = branch; x.setSession("fork"); x.rebind(); await tick();
  expect(x.manager.status().details.records).toEqual([]);
  expect(x.messages).toEqual([]);
  x.setSession("conversation"); x.rebind(); await tick();
  expect(x.messages).toHaveLength(1);
});

test("inactive completion remains pending; shutdown/rebind reuses the live host without submission", async () => {
  const x = setup(); x.start();
  const r = record(await x.manager.execute({ code: "long", yield_ms: 0 }));
  expect(x.host.needsKernel("http://localhost:2799", "/w/fit.py")).toBe(true);
  x.manager.shutdown();
  expect(x.children[0]!.kill).not.toHaveBeenCalled();
  x.children[0]!.finish(); await tick();
  expect(x.messages).toEqual([]);
  x.rebind(); await tick();
  expect(x.messages).toHaveLength(1);
  expect(x.children).toHaveLength(1);
  expect(record(x.manager.status(r.id)).state).toBe("succeeded");
  x.rebind(); await tick(); expect(x.messages).toHaveLength(1);
});

test("reload during foreground wait preserves exactly one reporting path", async () => {
  const x = setup(); x.start();
  const executing = x.manager.execute({ code: "long", yield_ms: 1000 });
  await until(() => x.children.length === 1);
  x.rebind();
  x.children[0]!.finish();
  expect(record(await executing).state).toBe("succeeded");
  await tick();
  expect(x.messages).toEqual([]); // Old tool returned inline; new adapter saw detached:false.
  expect(x.children).toHaveLength(1);
});

test("restored pending result dedupes native custom_message details.ids with arbitrary metadata", async () => {
  const x = setup(); x.start();
  const r = record(await x.manager.execute({ code: "long", yield_ms: 0 }));
  x.manager.shutdown(); x.children[0]!.finish();
  x.persistent("custom_message", { customType: COMPLETION_MESSAGE, content: "already queued", details: { ids: [`pi-marimo-execution:${r.id}`], rendererMetadata: { anything: true } } });
  x.rebind(); await tick();
  expect(x.messages).toEqual([]);
  expect(record(x.manager.status(r.id)).delivery).toBe("delivered");
});

test("process restart restores nonterminal work as unknown without replaying Python", async () => {
  const old = setup(); old.start();
  const r = record(await old.manager.execute({ code: "DO_NOT_REPLAY", yield_ms: 0 }));
  const persisted = structuredClone(old.entries);
  old.manager.shutdown();
  const fresh = setup(); fresh.entries = persisted; fresh.start(); await tick();
  expect(fresh.spawns).toEqual([]);
  expect(record(fresh.manager.status(r.id))).toMatchObject({ state: "unknown", detached: true });
  expect(fresh.messages).toHaveLength(1);
  expect(fresh.messages[0].content).toContain("nothing was resubmitted");
  fresh.rebind(); await tick(); expect(fresh.messages).toHaveLength(1);
});

test("off on reload suppresses pending completions permanently, not the running computation", async () => {
  const x = setup(); x.start();
  const r = record(await x.manager.execute({ code: "long", yield_ms: 0 }));
  x.config.completion.mode = "off"; x.rebind();
  expect(x.children[0]!.kill).not.toHaveBeenCalled();
  x.children[0]!.finish(); await tick();
  x.config.completion.mode = "subscribed"; x.rebind(); await tick();
  expect(x.messages).toEqual([]);
  expect(record(x.manager.status(r.id)).delivery).toBe("suppressed");
});

test("persist lifecycle changes, not each output chunk, and preserve separate notebook error evidence", async () => {
  const x = setup(); x.start();
  const r = record(await x.manager.execute({ code: "long", yield_ms: 0 }));
  const count = snapshots(x).length;
  for (let i = 0; i < 20; i++) x.children[0]!.stdout.write(`line ${i}\n`);
  await tick(); expect(snapshots(x)).toHaveLength(count);
  x.observers[0]!.emit("wave", "running", ["child"]);
  x.observers[0]!.emit("wave", "failed");
  x.children[0]!.finish(); await tick();
  expect(x.messages).toHaveLength(1);
  expect(x.messages[0].content).toContain("New notebook errors");
  expect(x.messages[0].details.executions[0]).toMatchObject({ state: "succeeded", errors: ["fit: ValueError"], blocked: ["child"] });
  expect(record(x.manager.status(r.id)).stdout).toContain("line 19");
  expect(snapshots(x).at(-1).data.record).toMatchObject({ state: "succeeded", delivery: "delivered" });
});

test("sendMessage failure stays recoverable without a self-spinning microtask retry", async () => {
  const x = setup(); x.start();
  const r = record(await x.manager.execute({ code: "long", yield_ms: 0 }));
  x.pi.sendMessage.mockImplementationOnce(() => { throw new Error("Runtime temporarily unavailable"); });
  x.children[0]!.finish(); await tick(); await tick();
  expect(x.pi.sendMessage).toHaveBeenCalledOnce();
  expect(record(x.manager.status(r.id)).delivery).toBe("queued");
  // A later lifecycle opportunity can retry, rather than failing the CLI or rerunning code.
  x.manager.beforeTurn(); await tick();
  expect(x.pi.sendMessage).toHaveBeenCalledTimes(2);
  expect(x.messages).toHaveLength(1);
  expect(x.children).toHaveLength(1);
  expect(record(x.manager.status(r.id)).delivery).toBe("delivered");
});

test("a message persisted just before sendMessage throws is not enqueued twice on retry", async () => {
  const x = setup(); x.start();
  const r = record(await x.manager.execute({ code: "long", yield_ms: 0 }));
  x.pi.sendMessage.mockImplementationOnce((message: any) => {
    x.persistent("custom_message", structuredClone(message));
    throw new Error("Interrupted after persistence");
  });
  x.children[0]!.finish(); await tick();
  x.manager.beforeTurn(); await tick();
  expect(x.pi.sendMessage).toHaveBeenCalledOnce();
  expect(record(x.manager.status(r.id)).delivery).toBe("delivered");
});

test("unrelated custom message types cannot suppress a native completion", async () => {
  const x = setup(); x.start();
  const r = record(await x.manager.execute({ code: "long", yield_ms: 0 }));
  x.manager.shutdown(); x.children[0]!.finish();
  x.persistent("custom_message", { customType: "other-extension", details: { ids: [`pi-marimo-execution:${r.id}`] } });
  x.rebind(); await tick();
  expect(x.messages).toHaveLength(1);
});

test("malformed persisted execution metadata is ignored without crashing or submitting", async () => {
  const x = setup();
  const malformed: unknown[] = [null, {}, { version: 1 }, { version: 1, owner: null }, { version: 1, owner: { sessionId: "conversation" }, target: null }];
  for (const record of malformed) x.persistent("custom", { customType: EXECUTION_ENTRY, data: { version: 1, kind: "snapshot", record } });
  x.start(); await tick();
  expect(x.manager.status().details.records).toEqual([]);
  expect(x.spawns).toEqual([]);
  expect(x.messages).toEqual([]);
});

test("terminal result persisted before an inline claim is recoverable after a process restart", async () => {
  const old = setup(); old.start();
  const r = record(await old.manager.execute({ code: "long", yield_ms: 0 }));
  old.manager.shutdown(); old.children[0]!.finish();
  const knownTerminal = old.host.get(r.owner, r.id);
  knownTerminal.detached = false;
  knownTerminal.delivery = "pending";
  old.persistent("custom", { customType: EXECUTION_ENTRY, data: { version: 1, kind: "snapshot", record: knownTerminal } });
  const fresh = setup(); fresh.entries = structuredClone(old.entries); fresh.start(); await tick();
  expect(fresh.messages).toHaveLength(1);
  expect(fresh.spawns).toEqual([]);
  expect(record(fresh.manager.status(r.id))).toMatchObject({ state: "succeeded", delivery: "delivered" });
});

test("accepted follow-ups stay queued until Pi consumes them, survive reload, and recover from a lost queue", async () => {
  const x = setup();
  let pending = true;
  x.ctx.hasPendingMessages = () => pending;
  x.pi.sendMessage.mockImplementation((message: any, delivery: any) => { x.messages.push({ ...message, delivery }); });
  x.start();
  const r = record(await x.manager.execute({ code: "fit()", yield_ms: 0 }));
  await until(() => x.children.length === 1);
  x.children[0]!.finish(); await tick();
  expect(record(x.manager.status(r.id)).delivery).toBe("queued");
  expect(x.messages).toHaveLength(1);
  x.manager.beforeTurn(); await tick();
  expect(x.messages).toHaveLength(1);
  x.rebind(); await tick();
  expect(x.messages).toHaveLength(1); // Core's accepted queue survived the extension reload.
  pending = false;
  x.manager.settled(); await tick(); // Core dropped the queued message before consuming it.
  expect(x.messages).toHaveLength(2);
  expect(x.spawns.filter(call => !call.args.includes("--help"))).toHaveLength(1);
  const completion = x.messages[1];
  x.persistent("custom_message", completion);
  x.manager.messageDelivered({ role: "custom", ...completion });
  expect(record(x.manager.status(r.id)).delivery).toBe("delivered");
  x.rebind(); await tick();
  expect(x.messages).toHaveLength(2);
});

test("bounded native output reports omitted bytes in status and completion text", async () => {
  const x = setup(); x.start();
  const r = record(await x.manager.execute({ code: "verbose()", yield_ms: 0 }));
  await until(() => x.children.length === 1);
  x.children[0]!.stdout.write("x".repeat(30_000));
  x.children[0]!.finish(); await tick();
  expect(x.manager.status(r.id).content[0]!.text).toContain("earlier bytes omitted");
  expect(x.messages).toHaveLength(1);
  expect(x.messages[0].content).toContain("earlier bytes omitted");
  expect(x.messages[0].content).toContain(`${r.id}: succeeded`);
  expect(x.messages[0].content.length).toBeLessThan(24_000);
});

test("native failure activity has timing and is cleared by a newer successful request", async () => {
  const x = setup(); x.start();
  await x.manager.execute({ code: "bad", yield_ms: 0 });
  x.children[0]!.finish(1); await tick();
  expect(x.manager.activity(x.followed[0]!)).toMatchObject({ running: false, failed: true, startedAt: expect.any(Number), endedAt: expect.any(Number) });
  await x.manager.execute({ code: "good", yield_ms: 0 });
  x.followed[0]!.notebook.cells.set("child", { id: "child", status: "running" } as any);
  expect(x.manager.activity(x.followed[0]!).detail).toEqual(["resume armed"]);
  x.followed[0]!.notebook.cells.clear();
  x.children[1]!.finish(); await tick();
  expect(x.manager.activity(x.followed[0]!)).toMatchObject({ running: false, failed: false, startedAt: expect.any(Number), endedAt: expect.any(Number), summary: expect.stringContaining("succeeded") });
});

test("all-mode branch switch disables its idle policy and registers the new anchor first", async () => {
  const x = setup("all"); x.start();
  const oldObserver = x.observers[0]!;
  x.entries = [];
  x.manager.beforeTurn();
  expect(oldObserver.stop).toHaveBeenCalledOnce();
  expect(x.entries.find(e => e.data?.kind === "policy")).toBeDefined();
  expect(x.observers).toHaveLength(2);
  x.observers[1]!.emit("new-branch", "running", ["__scratch__"]);
  x.observers[1]!.emit("new-branch", "succeeded"); await tick();
  expect(x.messages).toHaveLength(1);
});

test("configuration normalizes argv and enum once without mutating unrelated settings", () => {
  const warn = vi.fn();
  const config = { context: false, server: { command: ["uv", "run", "marimo"] }, execution: { command: ["uv", "", 1, "run", "marimo"] }, completion: { mode: "bad" } };
  const normalized = normalizeExecutionConfig(config, warn);
  expect(normalized).toMatchObject({ context: false, execution: { command: ["uv", "run", "marimo"] }, completion: { mode: "subscribed" } });
  normalizeExecutionConfig(config, warn);
  expect(warn).toHaveBeenCalledOnce();
  expect(config.completion.mode).toBe("bad");
  expect(normalized.server).toBe(config.server);
});
