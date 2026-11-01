import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ExecutionHost, executionTargetKey, isExecutionTerminal, ownExecutions,
  type ExecutionHostOptions, type ExecutionObserverOptions, type ExecutionOwner,
  type ExecutionRecord, type ExecutionStartSpec, type ExecutionTarget, type ExecutionWatchSpec, type WaveObserver,
} from "../src/core/execution.js";
import type { WaveSnapshot, WaveState } from "../src/core/execution-observer.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pair.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));
const owner: ExecutionOwner = { sessionId: "pi-session", anchorId: "task-anchor" };
const target: ExecutionTarget = {
  url: "http://127.0.0.1:2718", path: "/fake/notebook.py",
  canonicalPath: "/canonical/notebook.py", sessionId: "captured-kernel-session",
};
const owners = (anchorId: string): ExecutionOwner => ({ ...owner, anchorId });
const targets = (name: string): ExecutionTarget => ({ ...target, path: `/fake/${name}.py`, canonicalPath: `/canonical/${name}.py` });
const spec = (overrides: Partial<ExecutionStartSpec> = {}): ExecutionStartSpec => ({
  id: "exec-1", owner: { ...owner }, target: { ...target }, code: "# fake-pair: success\nprint('private source')",
  label: "Python task", command: [process.execPath, fixture], cwd, subscribed: true, ...overrides,
});
const watchSpec = (overrides: Partial<ExecutionWatchSpec> = {}): ExecutionWatchSpec => ({
  id: "watch-1", owner: { ...owner }, target: { ...target }, seedBusyCells: [], subscribed: true, ...overrides,
});
function wave(id = "wave-1", state: WaveState = "running", changes: Partial<NonNullable<WaveSnapshot["wave"]>> = {}): WaveSnapshot {
  return { connection: state === "reconnecting" ? "reconnecting" : "connected", wave: {
    id, state, startedAt: 123_456, busyCells: state === "running" ? ["cell-a"] : [], errors: [], blocked: [],
    ...(isExecutionTerminal(state) ? { endedAt: 124_456 } : {}), ...changes,
  } };
}

class FakeObserver implements WaveObserver {
  private value: WaveSnapshot;
  readonly start = vi.fn(() => {});
  readonly stop = vi.fn(() => {});
  constructor(readonly options: ExecutionObserverOptions, initial?: WaveSnapshot) {
    this.value = initial ?? (options.seedBusyCells?.length
      ? wave("seeded-wave", "running", { busyCells: [...options.seedBusyCells] }) : { connection: "connected" });
  }
  snapshot(): WaveSnapshot { return structuredClone(this.value); }
  emit(snapshot: WaveSnapshot): void {
    this.value = structuredClone(snapshot);
    this.options.onChange?.(this.snapshot());
  }
}

// No sockets, IO adapters, kernels or real CLI clients: this is a minimal
// injectable ChildProcess with independently controlled stdio and lifecycle.
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
  source = "";
  constructor(readonly pid: number | undefined = 1234) {
    super();
    this.stdin.on("data", chunk => { this.source += chunk.toString("utf8"); });
  }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.stdout.end(); this.stderr.end();
    this.emit("close", code, signal);
  }
  asProcess(): ChildProcess { return this as unknown as ChildProcess; }
}
interface SpawnCall { command: string; args: string[]; options: SpawnOptions; child: FakeChild }
function runner(options: { help?: string; helpCode?: number; hang?: boolean } = {}) {
  const calls: SpawnCall[] = [];
  const spawn = vi.fn((command: string, args: string[], spawnOptions: SpawnOptions): ChildProcess => {
    const child = new FakeChild();
    calls.push({ command, args: [...args], options: spawnOptions, child });
    if (args.at(-1) === "--help" && !options.hang) queueMicrotask(() => {
      child.stdout.write(options.help ?? "--url URL --session SESSION --code-file - --stream\n");
      child.close(options.helpCode ?? 0);
    });
    return child.asProcess();
  });
  return {
    calls, spawn,
    probes: () => calls.filter(call => call.args.at(-1) === "--help"),
    executions: () => calls.filter(call => call.args.at(-1) !== "--help"),
  };
}
const hosts: ExecutionHost[] = [];
function setup(options: ExecutionHostOptions = {}, initial?: WaveSnapshot) {
  const native = runner();
  const observers: FakeObserver[] = [];
  let id = 0;
  const observerFactory = vi.fn((opts: ExecutionObserverOptions) => {
    const observer = new FakeObserver(opts, initial);
    observers.push(observer);
    return observer;
  });
  // Every test-created host injects an observer, even tests that only probe.
  const host = new ExecutionHost({ spawn: native.spawn, now: () => 123_456, id: () => `auto-${++id}`, ...options, observerFactory });
  hosts.push(host);
  return { host, observers, observerFactory, native };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
function records(host: ExecutionHost, anchors = [owner.anchorId], sessionId = owner.sessionId): ExecutionRecord[] {
  return host.list(sessionId, new Set(anchors));
}
function assertTail(text: string, original: string, omitted: number): void {
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
  expect(text.split("\n").length - (text.endsWith("\n") ? 1 : 0)).toBeLessThanOrEqual(200);
  expect(text).not.toContain("\ufffd");
  expect(original.endsWith(text)).toBe(true);
  expect(omitted).toBe(Buffer.byteLength(original) - Buffer.byteLength(text));
}
afterEach(() => {
  // Only dispose hosts owned by this test file, never the process singleton.
  for (const host of hosts.splice(0)) host.dispose();
  vi.useRealTimers();
});

describe("official CLI contract (Node fixture only)", () => {
  function fixtureHost() {
    const children: ChildProcess[] = [];
    const spawn = vi.fn((command: string, args: string[], options: SpawnOptions): ChildProcess => {
      expect(command).toBe(process.execPath);
      expect(args[0]).toBe(fixture);
      const child = nodeSpawn(command, args, options);
      children.push(child);
      return child;
    });
    return { ...setup({ spawn }), spawn, children };
  }

  test("probes official capabilities, sends source only to stdin, and inherits cwd/env without a shell or token argv", async () => {
    const { host, spawn, observers } = fixtureHost();
    const source = "# fake-pair: echo\nprint('é 🐍; $(not-a-shell)')\n--not-an-argv-flag";
    host.start(spec({ code: source }));
    const result = await host.waitForResult("exec-1", 5000);
    expect(result).toMatchObject({ state: "succeeded", exitCode: 0, signal: null, stdoutOmittedBytes: 0, stderrOmittedBytes: 0 });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]).toEqual([process.execPath, [fixture, "pair", "execute", "--help"], {
      cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    }]);
    const argv = ["pair", "execute", "--url", target.url, "--session", target.sessionId, "--code-file", "-", "--stream"];
    expect(spawn.mock.calls[1]).toEqual([process.execPath, [fixture, ...argv], { cwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }]);
    expect(JSON.parse(result!.stdout)).toEqual({ argv, source, cwd: process.cwd(), env: { PATH: process.env.PATH } });
    for (const [, args, options] of spawn.mock.calls) {
      expect(args.join(" ")).not.toContain(source);
      expect(args.join(" ")).not.toMatch(/MARIMO_TOKEN|--token|--access-token/u);
      expect(options.env).toBeUndefined(); // Node inherits the entire parent environment.
    }
    expect(observers).toHaveLength(1);
    expect(observers[0]!.options.target).toEqual({ url: target.url, path: target.path, sessionId: target.sessionId });
    expect(observers[0]!.stop).toHaveBeenCalledOnce();
  });

  test.each([
    ["success", "succeeded", 0], ["failure", "failed", 1], ["exit2", "unknown", 2],
  ] as const)("fixture %s classifies native exit independently of textual diagnostics", async (mode, state, exitCode) => {
    const { host } = fixtureHost();
    host.start(spec({ code: `# fake-pair: ${mode}\n` }));
    expect(await host.waitForResult("exec-1", 5000)).toMatchObject({ state, exitCode, errors: [], blocked: [] });
  });

  test("yielding a real delayed fixture wait leaves the owned client alive and allows a later result", async () => {
    const { host, children } = fixtureHost();
    host.start(spec({ code: "# fake-pair: delay\n" }));
    expect(await host.waitForResult("exec-1", 0)).toBeUndefined();
    const result = await host.waitForResult("exec-1", 5000);
    expect(result).toMatchObject({ state: "succeeded", stdout: "delayed success\n" });
    expect(children.every(child => !child.killed)).toBe(true);
  });

  test("drains large Unicode stdout and stderr with exact omitted-byte accounting", async () => {
    const { host } = fixtureHost();
    host.start(spec({ code: "# fake-pair: large-output\n" }));
    const result = (await host.waitForResult("exec-1", 5000))!;
    expect(result.state).toBe("succeeded");
    const stdout = Array.from({ length: 360 }, (_, i) => `line-${i}: café 🐍 漢字 ${"🧪".repeat(24)}\n`).join("");
    const stderr = Array.from({ length: 320 }, (_, i) => `err-${i}: é🧪\n`).join("");
    assertTail(result.stdout, stdout, result.stdoutOmittedBytes);
    assertTail(result.stderr, stderr, result.stderrOmittedBytes);
    expect(result.stdoutOmittedBytes).toBeGreaterThan(0);
    expect(result.stderrOmittedBytes).toBeGreaterThan(0);
  });
});

describe("capability checks and dispatch", () => {
  test.each([
    { help: "--url --session --code-file", helpCode: 0 },
    { help: "--urlish --session-id --code-file --streaming", helpCode: 0 },
    { help: "--url --session --code-file --stream", helpCode: 2 },
  ])("rejects missing, lookalike or unsuccessful capability help: %j", async options => {
    const native = runner(options);
    const { host, observerFactory } = setup({ spawn: native.spawn });
    host.start(spec());
    const result = await host.waitForResult("exec-1", 1000);
    expect(result).toMatchObject({ state: "failed", stdout: "", stderr: "" });
    expect(result!.summary).toMatch(/Nothing was submitted.*lacks required/su);
    expect(native.executions()).toHaveLength(0);
    expect(observerFactory).not.toHaveBeenCalled();
  });

  test("a hung help probe is killed at exactly 5s, never dispatches source, and failure is not cached", async () => {
    vi.useFakeTimers();
    const native = runner({ hang: true });
    const { host, observerFactory } = setup({ spawn: native.spawn });
    host.start(spec());
    await vi.advanceTimersByTimeAsync(4999);
    expect(host.get(owner, "exec-1").state).toBe("starting");
    expect(native.probes()[0]!.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.get(owner, "exec-1")).toMatchObject({ state: "failed", summary: expect.stringContaining("timed out (5s)") });
    expect(native.probes()[0]!.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(native.probes()[0]!.child.source).toBe("");
    expect(native.executions()).toHaveLength(0);
    expect(observerFactory).not.toHaveBeenCalled();
    host.start(spec({ id: "retry-probe" }));
    expect(native.probes()).toHaveLength(2);
  });

  test("shares in-flight/successful help only for the exact command and cwd, not the target", async () => {
    const { host, native } = setup();
    host.start(spec());
    host.start(spec({ id: "other-target", target: targets("other") }));
    expect(native.probes()).toHaveLength(1);
    await flush();
    expect(native.executions()).toHaveLength(2);
    for (const call of native.executions()) call.child.close();
    host.start(spec({ id: "cached" }));
    await flush();
    expect(native.probes()).toHaveLength(1);
    host.start(spec({ id: "cwd", target: targets("cwd"), cwd: "/fake/other-cwd" }));
    host.start(spec({ id: "command", target: targets("command"), command: ["different-bin", "prefix"] }));
    await flush();
    expect(native.probes()).toHaveLength(3);
    expect(native.probes()[1]!.options.cwd).toBe("/fake/other-cwd");
    expect(native.probes()[2]!.args).toEqual(["prefix", "pair", "execute", "--help"]);
  });

  test("captures command/cwd/target/code before an asynchronous probe and rechecks identity twice", async () => {
    const { host, native } = setup();
    const isCurrent = vi.fn(() => true);
    const input = spec({ isCurrent });
    host.start(input);
    input.command.push("bad"); input.cwd = "/mutated"; input.code = "mutated";
    input.owner.anchorId = "mutated"; input.target.sessionId = "mutated";
    await flush();
    const call = native.executions()[0]!;
    expect(call.args).toEqual([fixture, "pair", "execute", "--url", target.url, "--session", target.sessionId, "--code-file", "-", "--stream"]);
    expect(call.options.cwd).toBe(cwd);
    expect(call.child.source).toBe(spec().code);
    expect(host.get(owner, "exec-1").target).toEqual(target);
    expect(isCurrent).toHaveBeenCalledTimes(2);
  });

  test.each([false, true])("stale/busy identity prevents submission (observer already attached: %s)", async afterAttach => {
    const isCurrent = vi.fn().mockReturnValueOnce(afterAttach).mockReturnValue(false);
    const { host, native } = setup();
    host.start(spec({ isCurrent }));
    await flush();
    expect(host.get(owner, "exec-1")).toMatchObject({ state: "failed", summary: expect.stringContaining("Nothing was submitted") });
    expect(native.executions()).toHaveLength(0);
  });

  test("rejects invalid code/commands and duplicate IDs synchronously without another submission", () => {
    const { host, native } = setup();
    expect(() => host.start(spec({ code: " \n\t" }))).toThrow(/nonempty/u);
    expect(() => host.start(spec({ command: [] }))).toThrow(/execution.command/u);
    expect(() => host.start(spec({ command: ["node", ""] }))).toThrow(/execution.command/u);
    expect(native.spawn).not.toHaveBeenCalled();
    host.start(spec());
    expect(() => host.start(spec({ target: targets("other") }))).toThrow(/already registered/u);
    expect(native.probes()).toHaveLength(1);
  });

  test("a probe spawn failure reports nothing submitted, is retryable, and never opens an observer", async () => {
    const spawn = vi.fn((): ChildProcess => { throw new Error("ENOENT fixture"); });
    const { host, observerFactory } = setup({ spawn });
    host.start(spec());
    await flush();
    expect(host.get(owner, "exec-1")).toMatchObject({ state: "failed", summary: expect.stringContaining("ENOENT fixture") });
    host.start(spec({ id: "retry" }));
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(observerFactory).not.toHaveBeenCalled();
  });
});

describe("owned child lifetime, result classification and delivery", () => {
  test("timeouts, already-aborted waits and mid-wait aborts never kill or close the client", async () => {
    vi.useFakeTimers();
    const { host, native } = setup();
    host.start(spec());
    await flush();
    const child = native.executions()[0]!.child;
    const timed = host.waitForResult("exec-1", 25);
    await vi.advanceTimersByTimeAsync(25);
    expect(await timed).toBeUndefined();
    const aborted = new AbortController(); aborted.abort();
    expect(await host.waitForResult("exec-1", 1000, aborted.signal)).toBeUndefined();
    const controller = new AbortController();
    const waiting = host.waitForResult("exec-1", 1000, controller.signal);
    controller.abort();
    expect(await waiting).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(false);
    expect(child.stderr.destroyed).toBe(false);
    expect(host.get(owner, "exec-1").state).toBe("running");
    child.stdout.write("late output\n"); child.close();
    expect(await host.waitForResult("exec-1", 0)).toMatchObject({ state: "succeeded", stdout: "late output\n" });
    expect(child.kill).not.toHaveBeenCalled();
  });

  test.each([
    [0, null, "succeeded"], [1, null, "failed"], [2, null, "unknown"],
    [130, null, "unknown"], [null, "SIGINT", "unknown"], [null, "SIGTERM", "unknown"],
  ] as const)("exit %s signal %s produces %s, never guessing interruption from stderr", async (code, signal, state) => {
    const { host, native } = setup();
    host.start(spec()); await flush();
    const child = native.executions()[0]!.child;
    child.stderr.write("KeyboardInterrupt: interrupted by user\n");
    child.close(code, signal);
    expect(await host.waitForResult("exec-1", 0)).toMatchObject({ state, exitCode: code, signal });
  });

  test.each([0, 1, 2])("structured interruption is evidence only; native exit %s remains authoritative", async code => {
    const { host, native, observers } = setup();
    host.start(spec()); await flush();
    observers[0]!.emit(wave("wave-1", "interrupted", { errors: ["__scratch__: interrupted"], blocked: ["child"] }));
    expect(host.get(owner, "exec-1").state).toBe("running");
    native.executions()[0]!.child.close(code);
    expect(host.get(owner, "exec-1")).toMatchObject({
      state: code === 0 ? "succeeded" : code === 1 ? "interrupted" : "unknown",
      errors: ["__scratch__: interrupted"], blocked: ["child"],
    });
  });

  test("notebook failure/blocked evidence cannot turn successful native Python into failure", async () => {
    const { host, native, observers } = setup();
    host.start(spec()); await flush();
    observers[0]!.emit(wave("wave-1", "failed", { errors: ["a: ValueError: boom"], blocked: ["child"] }));
    native.executions()[0]!.child.close();
    expect(host.get(owner, "exec-1")).toMatchObject({ state: "succeeded", errors: ["a: ValueError: boom"], blocked: ["child"] });
  });

  test("historical observer interruption is not evidence about a new native request", async () => {
    const { host, native } = setup({}, wave("historical", "interrupted", {
      startedAt: 1000, endedAt: 2000, errors: ["old interruption"], blocked: ["old child"],
    }));
    host.start(spec()); await flush();
    native.executions()[0]!.child.close(1);
    expect(host.get(owner, "exec-1")).toMatchObject({ state: "failed", errors: [], blocked: [] });
  });

  test.each([undefined, 4321])("child error with pid %s distinguishes failed launch from uncertain transport", async pid => {
    const native = runner();
    const failed = new FakeChild(pid);
    // Passing undefined through a default parameter would create a fake PID.
    if (pid === undefined) Object.defineProperty(failed, "pid", { value: undefined });
    const spawn = vi.fn((command: string, args: string[], options: SpawnOptions) => args.at(-1) === "--help"
      ? native.spawn(command, args, options) : failed.asProcess());
    const { host } = setup({ spawn });
    host.start(spec()); await flush();
    failed.emit("error", new Error("lost client"));
    expect(host.get(owner, "exec-1")).toMatchObject({ state: pid === undefined ? "failed" : "unknown" });
    failed.close(0);
    expect(host.get(owner, "exec-1").state).toBe(pid === undefined ? "failed" : "unknown");
  });

  test("inline delivery cannot be queued; detached terminal delivery is claimed exactly once", async () => {
    const { host, native } = setup();
    host.start(spec()); await flush();
    host.markQueued("exec-1"); host.markDelivered("exec-1");
    expect(host.get(owner, "exec-1").delivery).toBe("pending");
    native.executions()[0]!.child.close();
    host.markQueued("exec-1");
    expect(host.get(owner, "exec-1").delivery).toBe("pending");
    host.markInline("exec-1"); host.markQueued("exec-1");
    expect(host.get(owner, "exec-1")).toMatchObject({ delivery: "delivered", detached: false });
    host.start(spec({ id: "detached" })); await flush();
    host.markDetached("detached"); host.markQueued("detached");
    expect(host.get(owner, "detached").delivery).toBe("pending");
    native.executions()[1]!.child.close();
    host.markQueued("detached"); host.markQueued("detached"); host.markInline("detached");
    expect(host.get(owner, "detached")).toMatchObject({ delivery: "queued", detached: true });
    host.markDelivered("detached"); host.markDelivered("detached"); host.markQueued("detached");
    expect(host.get(owner, "detached").delivery).toBe("delivered");
    expect(native.executions().every(call => call.child.kill.mock.calls.length === 0)).toBe(true);
  });

  test.each([true, false])("unsubscribe/subscribed:false suppress follow-ups without cancelling Python (%s)", async subscribed => {
    const { host, native } = setup();
    host.start(spec({ subscribed })); await flush();
    if (subscribed) host.unsubscribe(owner, "exec-1");
    host.markDetached("exec-1");
    native.executions()[0]!.child.close(); host.markQueued("exec-1"); host.markDelivered("exec-1");
    expect(host.get(owner, "exec-1")).toMatchObject({ notification: "none", delivery: "suppressed", state: "succeeded" });
    expect(native.executions()[0]!.child.kill).not.toHaveBeenCalled();
  });

  test("only owned-host disposal terminates its children; it is idempotent and leaves unknown, not interrupted", async () => {
    const { host, native, observers } = setup();
    host.start(spec()); await flush();
    const pending = host.waitForResult("exec-1", 60_000);
    host.dispose(); host.dispose();
    expect(await pending).toMatchObject({ state: "unknown" });
    expect(native.executions()[0]!.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(observers[0]!.stop).toHaveBeenCalledOnce();
    expect(() => host.start(spec({ id: "later" }))).toThrow(/disposed/u);
  });
});

describe("rearming authoritative native handles", () => {
  test.each(["subscribe:false", "unsubscribe"])("watch/subscribe reuses the live CLI after %s without mutation or duplicate all-mode work", async initial => {
    const { host, native, observers } = setup();
    host.start(spec({ subscribed: initial !== "subscribe:false" })); await flush();
    host.markDetached("exec-1");
    if (initial === "unsubscribe") host.unsubscribe(owner, "exec-1");
    const policy = owners("policy");
    host.observeAll(policy, [target], true); observers[0]!.emit(wave());
    expect(() => host.subscribe(owners("sibling"), "exec-1")).toThrow(/Unknown execution/u);
    const rearmed = initial === "subscribe:false" ? await host.watch(watchSpec()) : host.subscribe(owner, "exec-1");
    expect(rearmed).toMatchObject({ id: "exec-1", kind: "execute", owner, notification: "explicit", delivery: "pending", detached: true });
    host.unsubscribe(owner, "exec-1"); host.subscribe(owner, "exec-1");
    observers[0]!.emit(wave("wave-1", "succeeded"));
    expect(host.get(owner, "exec-1").state).toBe("running");
    native.executions()[0]!.child.close(0);
    host.markQueued("exec-1"); host.markDelivered("exec-1");
    expect(host.get(owner, "exec-1")).toMatchObject({ state: "succeeded", delivery: "delivered" });
    expect(() => host.subscribe(owner, "exec-1")).toThrow(/terminal/u);
    expect(records(host, [owner.anchorId, policy.anchorId])).toHaveLength(1);
    expect(native.executions()).toHaveLength(1);
    expect(native.executions()[0]!.child.kill).not.toHaveBeenCalled();
    expect(observers).toHaveLength(1);
  });
});

describe("owned POSIX process groups", () => {
  test.each([false, true])("real fake CLI disposal closes its owned group (non-forwarding wrapper: %s)", async wrapped => {
    if (process.platform === "win32" && wrapped) return; // Windows has no POSIX process groups.
    const observers: FakeObserver[] = [];
    // Default spawn is deliberate: no fake PID may ever reach process.kill.
    const host = new ExecutionHost({ observerFactory: options => {
      const observer = new FakeObserver(options); observers.push(observer); return observer;
    } });
    hosts.push(host);
    host.start(spec({ command: [process.execPath, fixture, ...(wrapped ? ["--wrapper"] : [])], code: "# fake-pair: hold\n" }));
    for (let i = 0; i < 400 && !host.get(owner, "exec-1").stdout.includes("started:"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const started = host.get(owner, "exec-1");
    expect(started.state).toBe("running");
    const pid = Number(/^started:(\d+)$/mu.exec(started.stdout)?.[1]);
    expect(pid).toBeGreaterThan(0);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    host.dispose();
    for (let i = 0; i < 400 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(alive()).toBe(false);
    expect(host.get(owner, "exec-1").state).toBe("unknown");
    expect(observers[0]!.stop).toHaveBeenCalledOnce();
  });

  test("injected runners opt into group kills; unavailable groups safely fall back to child.kill", async () => {
    const killGroup = vi.fn((_pid: number, _signal: NodeJS.Signals) => { throw new Error("group unavailable"); });
    const { host, native } = setup({ killGroup });
    host.start(spec()); await flush();
    host.dispose();
    if (process.platform !== "win32") expect(killGroup).toHaveBeenCalledWith(1234, "SIGTERM");
    else expect(killGroup).not.toHaveBeenCalled();
    expect(native.executions()[0]!.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  test("hung help probes signal their owned group only when explicitly injected", async () => {
    vi.useFakeTimers();
    const native = runner({ hang: true });
    const killGroup = vi.fn();
    const { host } = setup({ spawn: native.spawn, killGroup });
    host.start(spec());
    await vi.advanceTimersByTimeAsync(5000);
    if (process.platform !== "win32") {
      expect(killGroup).toHaveBeenCalledExactlyOnceWith(1234, "SIGKILL");
      expect(native.probes()[0]!.child.kill).not.toHaveBeenCalled();
    } else expect(native.probes()[0]!.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(native.executions()).toHaveLength(0);
  });
});

describe("bounded output, ownership and durable snapshots", () => {
  test("handles split UTF-8, byte-limited single lines and line-limited tails on both streams", async () => {
    const { host, native } = setup();
    host.start(spec()); await flush();
    const child = native.executions()[0]!.child;
    const stdout = "é🐍漢字".repeat(5000);
    const bytes = Buffer.from(stdout);
    for (let offset = 0; offset < bytes.length; offset += 17) child.stdout.write(bytes.subarray(offset, offset + 17));
    const stderr = Array.from({ length: 450 }, (_, i) => `é${i}🐍\n`).join("");
    child.stderr.write(Buffer.from(stderr)); child.close();
    const result = host.get(owner, "exec-1");
    assertTail(result.stdout, stdout, result.stdoutOmittedBytes);
    assertTail(result.stderr, stderr, result.stderrOmittedBytes);
    expect(result.stderr.split("\n")).toHaveLength(201);
  });

  test("strips terminal escapes and unsafe controls from display strings", async () => {
    const { host, native, observers } = setup();
    host.start(spec({ label: "\u001b[31mTask\u001b[0m\u0000" })); await flush();
    const child = native.executions()[0]!.child;
    child.stdout.write("\u001b[31mred\u001b[0m\u0000\u0007\tline\n");
    child.stderr.write("\u001b]0;title\u0007error\u0001");
    observers[0]!.emit(wave("wave-1", "failed", { errors: ["\u001b[31merror\u001b[0m"], blocked: ["cell\u0000"] }));
    child.close(1);
    expect(host.get(owner, "exec-1")).toMatchObject({ label: "Task", stdout: "red\tline\n", stderr: "error", errors: ["error"], blocked: ["cell"] });
  });

  test("enforces both session and anchor ownership, and defensively clones start/get/list/unsubscribe results", async () => {
    const { host, native, observers } = setup();
    const input = spec(); const initial = host.start(input); await flush();
    const wrongAnchor = owners("other-branch");
    const wrongSession = { ...owner, sessionId: "other-session" };
    for (const wrong of [wrongAnchor, wrongSession]) {
      expect(() => host.get(wrong, "exec-1")).toThrow(/Unknown execution/u);
      expect(() => host.unsubscribe(wrong, "exec-1")).toThrow(/Unknown execution/u);
    }
    expect(records(host, [wrongAnchor.anchorId])).toEqual([]);
    expect(records(host, [owner.anchorId], wrongSession.sessionId)).toEqual([]);
    initial.owner.anchorId = "bad"; initial.target.path = "bad"; initial.errors.push("bad");
    input.owner.sessionId = "bad"; input.target.url = "bad";
    observers[0]!.emit(wave("wave-1", "running", { errors: ["real"], blocked: ["child"] }));
    for (const result of [host.get(owner, "exec-1"), records(host)[0]!, host.unsubscribe(owner, "exec-1")]) {
      result.owner.anchorId = "bad"; result.target.sessionId = "bad";
      result.errors.push("bad"); result.blocked.push("bad");
    }
    expect(host.get(owner, "exec-1")).toMatchObject({ owner, target, errors: ["real"], blocked: ["child"] });
    expect(native.executions()).toHaveLength(1);
  });

  test("snapshot whitelist retains no source/command/cwd/env/token/child fields, including imported extras", async () => {
    const { host, native } = setup();
    host.start(spec({ code: "private-do-not-persist-source" })); await flush();
    native.executions()[0]!.child.close();
    const saved = host.get(owner, "exec-1");
    const expectedKeys = ["version", "id", "owner", "target", "kind", "label", "state", "startedAt", "endedAt", "notification", "delivery", "detached", "exitCode", "signal", "stdout", "stderr", "stdoutOmittedBytes", "stderrOmittedBytes", "summary", "errors", "blocked"].sort();
    expect(Object.keys(saved).sort()).toEqual(expectedKeys);
    expect(JSON.stringify(saved)).not.toContain("private-do-not-persist-source");
    const poisoned = Object.assign(structuredClone(saved), {
      id: "imported", code: "private-source", source: "private-source", env: { MARIMO_TOKEN: "fixture-secret" },
      token: "fixture-secret", command: ["private-bin"], cwd: "/private", child: {},
    });
    Object.assign(poisoned.owner, { token: "fixture-secret" });
    Object.assign(poisoned.target, { env: { MARIMO_TOKEN: "fixture-secret" } });
    host.restore([poisoned]);
    const restored = host.get(owner, "imported");
    expect(Object.keys(restored).sort()).toEqual(expectedKeys);
    expect(Object.keys(restored.owner).sort()).toEqual(["anchorId", "sessionId"]);
    expect(Object.keys(restored.target).sort()).toEqual(["canonicalPath", "path", "sessionId", "url"]);
    expect(JSON.stringify(restored)).not.toMatch(/private-source|fixture-secret|MARIMO_TOKEN/u);
  });

  test("same-process existing record wins restore; restart active records become unknown without resubmission", async () => {
    const { host, native } = setup();
    host.start(spec()); await flush();
    const active = host.get(owner, "exec-1");
    host.restore([{ ...active, state: "failed", stdout: "stale snapshot" }]);
    expect(host.get(owner, "exec-1")).toMatchObject({ state: "running", stdout: "" });
    const restarted = setup({ now: () => 999_999 });
    restarted.host.restore([active, { ...active, id: "old-version", version: 2 } as unknown as ExecutionRecord]);
    expect(restarted.host.get(owner, "exec-1")).toMatchObject({ state: "unknown", endedAt: 999_999, detached: true, summary: expect.stringContaining("nothing was resubmitted") });
    expect(restarted.native.spawn).not.toHaveBeenCalled();
    expect(restarted.observerFactory).not.toHaveBeenCalled();
    expect(() => restarted.host.get(owner, "old-version")).toThrow(/Unknown execution/u);
    native.executions()[0]!.child.close();
    expect(host.get(owner, "exec-1").state).toBe("succeeded");
  });

  test("restore preserves terminal outcome/delivery, bounds tails and clones caller-owned arrays", async () => {
    const first = setup(); first.host.start(spec()); await flush();
    first.native.executions()[0]!.child.close(1);
    first.host.markDetached("exec-1"); first.host.markQueued("exec-1");
    const saved = first.host.get(owner, "exec-1");
    saved.stdout = "🐍".repeat(6000); saved.stderr = "line\n".repeat(400);
    saved.stdoutOmittedBytes = 7; saved.stderrOmittedBytes = 9;
    const second = setup(); second.host.restore([saved]);
    const result = second.host.get(owner, "exec-1");
    expect(result).toMatchObject({ state: "failed", delivery: "queued", detached: true, endedAt: saved.endedAt });
    assertTail(result.stdout, saved.stdout, result.stdoutOmittedBytes - 7);
    assertTail(result.stderr, saved.stderr, result.stderrOmittedBytes - 9);
    saved.errors.push("mutated"); saved.owner.anchorId = "mutated";
    expect(second.host.get(owner, "exec-1").errors).toEqual([]);
  });
});

describe("native exclusion, active-session bounds and activity", () => {
  test("native exclusivity is url+canonicalPath across owners, branches and captured kernel sessions", async () => {
    const { host, native } = setup(); host.start(spec());
    for (const url of [target.url + "/", "http://localhost:2718", "http://[::1]:2718/"]) {
      expect(() => host.start(spec({ id: `collision-${url}`, owner: { sessionId: "another-pi", anchorId: "another-branch" },
        target: { ...target, url, path: "/symlink/notebook.py", sessionId: "new-kernel" } }))).toThrow(/busy.*marimo_watch/iu);
    }
    host.start(spec({ id: "different-path", target: targets("different") }));
    host.start(spec({ id: "different-url", target: { ...target, url: "http://127.0.0.1:2719" } }));
    await flush();
    expect(native.executions()).toHaveLength(3);
    native.executions()[0]!.child.close();
    expect(() => host.start(spec({ id: "after-terminal", target: { ...target, sessionId: "new-kernel" } }))).not.toThrow();
  });

  test("32-active bound is per owning Pi session across fresh anchors, not per branch or globally", async () => {
    const { host, native } = setup();
    for (let i = 0; i < 32; i++) host.start(spec({ id: `run-${i}`, owner: owners(`branch-${i}`), target: targets(`n-${i}`) }));
    expect(() => host.start(spec({ id: "overflow", owner: owners("fresh"), target: targets("overflow") }))).toThrow(/32/u);
    expect(() => host.start(spec({ id: "other-owner", owner: { sessionId: "other-pi", anchorId: "fresh" }, target: targets("other-pi") }))).not.toThrow();
    await flush();
    expect(native.executions()).toHaveLength(33);
    native.executions()[0]!.child.close();
    expect(() => host.start(spec({ id: "slot-reused", owner: owners("fresh"), target: targets("reused") }))).not.toThrow();
  });

  test("needsKernel/activity reflect owned active work and subscription, not historical terminal work", async () => {
    const { host, native } = setup(); host.start(spec()); await flush();
    expect(host.needsKernel("http://localhost:2718/", target.canonicalPath)).toBe(true);
    expect(host.needsKernel(target.url, target.path)).toBe(true);
    expect(host.needsKernel(target.url, "/other.py")).toBe(false);
    expect(host.activity(owner.sessionId, target)).toMatchObject({ running: true, startedAt: 123_456, detail: ["executing Python", "resume armed"] });
    expect(host.activity("other-pi", target).running).toBe(false);
    host.unsubscribe(owner, "exec-1");
    expect(host.activity(owner.sessionId, target).detail).toEqual(["executing Python"]);
    native.executions()[0]!.child.close(1);
    expect(host.needsKernel(target.url)).toBe(false);
    expect(host.activity(owner.sessionId, target)).toMatchObject({ running: false, failed: true, endedAt: 123_456, detail: [] });
  });
});

describe("terminal activity and foreground retention regressions", () => {
  test("latest native success clears historical failure, including equal timestamps, and keeps timing", async () => {
    const { host, native } = setup();
    host.start(spec({ id: "old-failure" })); await flush();
    native.executions()[0]!.child.close(1); host.markInline("old-failure");
    expect(host.activity(owner.sessionId, target)).toMatchObject({ running: false, failed: true, startedAt: 123_456, endedAt: 123_456 });
    host.start(spec({ id: "new-success" })); await flush();
    native.executions()[1]!.child.close(0); host.markInline("new-success");
    expect(host.activity(owner.sessionId, target)).toMatchObject({ running: false, failed: false, startedAt: 123_456, endedAt: 123_456, summary: expect.stringContaining("succeeded") });
    expect(records(host)[0]!.id).toBe("new-success");
  });

  test.each(["inline", "detached"] as const)("unsubscribed oldest foreground handle survives completion and %s claim at capacity", async claim => {
    const { host, native } = setup();
    host.start(spec({ id: "foreground", subscribed: false }));
    host.start(spec({ id: "concurrent", target: targets("concurrent"), subscribed: false }));
    await flush();
    const template = host.get(owner, "foreground");
    host.restore(Array.from({ length: 100 }, (_, i) => ({ ...template, id: `history-${i}`, kind: "watch" as const, state: "succeeded" as const, detached: true, endedAt: 123_456 })));
    native.executions()[0]!.child.close();
    // Another completion/prune can happen before the first foreground wait resumes.
    native.executions()[1]!.child.close();
    expect(await host.waitForResult("foreground", 0)).toMatchObject({ id: "foreground", state: "succeeded" });
    if (claim === "inline") host.markInline("foreground"); else host.markDetached("foreground");
    expect(host.get(owner, "foreground")).toMatchObject({ state: "succeeded", delivery: "suppressed", detached: claim === "detached" });
    expect(records(host)).toHaveLength(100);
  });

  test("keeps 100 claimed completions without losing the just-returned handle, but never evicts pending metadata", async () => {
    const { host, native } = setup();
    for (let i = 0; i < 105; i++) {
      const id = `inline-${i}`;
      host.start(spec({ id, subscribed: false })); await flush();
      native.executions()[i]!.child.close(); host.markInline(id);
      expect(host.get(owner, id).state).toBe("succeeded");
    }
    expect(records(host)).toHaveLength(100);
    expect(() => host.get(owner, "inline-0")).toThrow(/Unknown execution/u);
    const template = host.get(owner, "inline-104");
    const pending = Array.from({ length: 105 }, (_, i) => ({ ...template, id: `pending-${i}`, delivery: "pending" as const, notification: "explicit" as const, detached: true }));
    host.restore(pending);
    expect(records(host)).toHaveLength(105);
    for (const record of pending) expect(host.get(owner, record.id).delivery).toBe("pending");
  });
});

describe("passive watch, observer pooling and all-mode deduplication", () => {
  test("watch with no busy evidence waits at most one second, returns undefined and stops its observer", async () => {
    vi.useFakeTimers();
    const { host, native, observers } = setup();
    const done = vi.fn(); const waiting = host.watch(watchSpec()).then(result => { done(result); return result; });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    expect(records(host)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBeUndefined();
    expect(native.spawn).not.toHaveBeenCalled();
    expect(observers[0]!.stop).toHaveBeenCalledOnce();
  });

  test("watch detects busy evidence within the one-second window and never submits Python", async () => {
    vi.useFakeTimers();
    const { host, native, observers } = setup();
    const waiting = host.watch(watchSpec());
    await vi.advanceTimersByTimeAsync(999);
    observers[0]!.emit(wave());
    const record = await waiting;
    expect(record).toMatchObject({ id: "watch-1", kind: "watch", state: "running", notification: "explicit", delivery: "pending", detached: true });
    observers[0]!.emit(wave("wave-1", "succeeded"));
    expect(await host.waitForResult("watch-1", 0)).toMatchObject({ state: "succeeded" });
    expect(observers[0]!.stop).toHaveBeenCalledOnce();
    expect(native.spawn).not.toHaveBeenCalled();
  });

  test("seeded watch is immediate, exact-targeted and defensive; repeat watch reuses representative", async () => {
    const { host, native, observers, observerFactory } = setup();
    const seeds = ["cell-a", "__scratch__"];
    const input = watchSpec({ seedBusyCells: seeds });
    const record = (await host.watch(input))!;
    seeds.push("mutated"); input.target.sessionId = "mutated";
    expect(record).toMatchObject({ state: "running", detached: true });
    expect(observers[0]!.options.seedBusyCells).toEqual(["cell-a", "__scratch__"]);
    expect(observers[0]!.options.target).toEqual({ url: target.url, path: target.path, sessionId: target.sessionId });
    record.errors.push("bad"); record.target.path = "bad";
    expect(await host.watch(watchSpec({ id: "duplicate" }))).toMatchObject({ id: "watch-1", errors: [], target });
    expect(observerFactory).toHaveBeenCalledOnce();
    expect(native.spawn).not.toHaveBeenCalled();
  });

  test("concurrent watches share one pool, but exact captured sessions have independent observers", async () => {
    const { host, observers, observerFactory } = setup();
    const first = host.watch(watchSpec());
    const secondOwner = { sessionId: "other-pi", anchorId: "other-task" };
    const second = host.watch(watchSpec({ id: "watch-2", owner: secondOwner }));
    expect(observerFactory).toHaveBeenCalledOnce();
    observers[0]!.emit(wave());
    expect(await first).toMatchObject({ id: "watch-1" });
    expect(await second).toMatchObject({ id: "watch-2" });
    const anotherTarget = { ...target, sessionId: "another-kernel" };
    await host.watch(watchSpec({ id: "other-kernel", target: anotherTarget, seedBusyCells: ["busy"] }));
    expect(observerFactory).toHaveBeenCalledTimes(2);
    observers[0]!.emit(wave("wave-1", "succeeded"));
    expect(observers[0]!.stop).toHaveBeenCalledOnce();
    expect(observers[1]!.stop).not.toHaveBeenCalled();
  });

  test("all-mode never invents tasks from idle or terminal replay, dedupes each wave and registers the next", () => {
    const { host, observers, native } = setup();
    host.observeAll(owner, [target], true);
    expect(records(host)).toEqual([]);
    observers[0]!.emit(wave("historical", "failed", { errors: ["old"] }));
    expect(records(host)).toEqual([]);
    observers[0]!.emit(wave()); observers[0]!.emit(wave());
    host.observeAll(owner, [target], true);
    expect(records(host)).toHaveLength(1);
    expect(records(host)[0]).toMatchObject({ id: "auto-1", notification: "automatic", delivery: "pending", detached: true });
    observers[0]!.emit(wave("wave-1", "succeeded"));
    observers[0]!.emit(wave("wave-1", "succeeded"));
    expect(records(host)).toHaveLength(1);
    observers[0]!.emit(wave("wave-2"));
    expect(records(host)).toHaveLength(2);
    expect(native.spawn).not.toHaveBeenCalled();
  });

  test.each(["explicit", "unsubscribed", "not-subscribed"] as const)("native %s representation prevents automatic duplicates for the whole wave", async mode => {
    const { host, observers, native } = setup();
    host.start(spec({ subscribed: mode !== "not-subscribed" })); await flush();
    if (mode === "unsubscribed") host.unsubscribe(owner, "exec-1");
    host.observeAll(owners("new-anchor"), [target], true);
    expect(observers).toHaveLength(1);
    observers[0]!.emit(wave());
    native.executions()[0]!.child.close();
    observers[0]!.emit(wave()); // descendants may still be running after native success
    observers[0]!.emit(wave("wave-1", "succeeded"));
    expect(records(host, [owner.anchorId, "new-anchor"])).toHaveLength(1);
    expect(host.get(owner, "exec-1").notification).toBe(mode === "explicit" ? "explicit" : "none");
    observers[0]!.emit(wave("wave-2"));
    expect(records(host, [owner.anchorId, "new-anchor"])).toHaveLength(2);
  });

  test.each([true, false])("explicit watch unsubscribed/subscribed:false stays represented in all-mode (%s)", async subscribed => {
    const { host, observers } = setup();
    await host.watch(watchSpec({ subscribed, seedBusyCells: ["cell-a"] }));
    if (subscribed) host.unsubscribe(owner, "watch-1");
    host.observeAll(owner, [target], true);
    observers[0]!.emit(wave("seeded-wave"));
    observers[0]!.emit(wave("seeded-wave", "succeeded"));
    expect(records(host)).toHaveLength(1);
    expect(host.get(owner, "watch-1")).toMatchObject({ notification: "none", delivery: "suppressed" });
  });

  test("automatic unsubscribe suppresses only reporting, not observation or subsequent independent waves", () => {
    const { host, observers } = setup();
    host.observeAll(owner, [target], true); observers[0]!.emit(wave());
    host.unsubscribe(owner, "auto-1");
    observers[0]!.emit(wave()); observers[0]!.emit(wave("wave-1", "succeeded"));
    host.markQueued("auto-1");
    expect(records(host)).toHaveLength(1);
    expect(host.get(owner, "auto-1")).toMatchObject({ state: "succeeded", notification: "none", delivery: "suppressed" });
    observers[0]!.emit(wave("wave-2"));
    expect(records(host)).toHaveLength(2);
  });

  test("policy rebind reuses pools; disabling all-mode retains active explicit watches until completion", async () => {
    const { host, observers, observerFactory } = setup();
    await host.watch(watchSpec({ seedBusyCells: ["cell-a"] }));
    host.observeAll(owner, [target], true);
    host.observeAll(owner, [target], true);
    expect(observerFactory).toHaveBeenCalledOnce();
    host.observeAll(owner, [], false);
    expect(observers[0]!.stop).not.toHaveBeenCalled();
    observers[0]!.emit(wave("seeded-wave", "succeeded"));
    expect(observers[0]!.stop).toHaveBeenCalledOnce();
    host.observeAll(owner, [target], true);
    expect(observerFactory).toHaveBeenCalledTimes(2);
    host.observeAll(owner, [], false);
    expect(observers[1]!.stop).toHaveBeenCalledOnce();
    observers[1]!.emit(wave("late-callback"));
    expect(records(host)).toHaveLength(1);
  });

  test("watch dedupe is exact-owner: sibling anchors share observation but never receive each other's records", async () => {
    const { host, observers, observerFactory } = setup();
    await host.watch(watchSpec({ seedBusyCells: ["cell-a"] }));
    const sibling = owners("sibling-anchor");
    const record = await host.watch(watchSpec({ id: "sibling-watch", owner: sibling }));
    expect(record).toMatchObject({ id: "sibling-watch", owner: sibling, state: "running" });
    expect(() => host.get(sibling, "watch-1")).toThrow(/Unknown execution/u);
    expect(await host.watch(watchSpec({ id: "sibling-repeat", owner: sibling }))).toMatchObject({ id: "sibling-watch" });
    host.observeAll(owners("policy-anchor"), [target], true);
    expect(records(host, [owner.anchorId, sibling.anchorId, "policy-anchor"])).toHaveLength(2);
    expect(observerFactory).toHaveBeenCalledOnce();
    observers[0]!.emit(wave("seeded-wave", "succeeded"));
  });

  test("watch seeds replace an idle policy observer, keep policy refs, and suppress a raced automatic notification", async () => {
    const { host, observers, observerFactory } = setup();
    const policyOwner = owners("policy-anchor");
    host.observeAll(policyOwner, [target], true);
    const record = await host.watch(watchSpec({ seedBusyCells: ["cell-a"] }));
    expect(record).toMatchObject({ id: "watch-1", kind: "watch", notification: "explicit", state: "running" });
    expect(observerFactory).toHaveBeenCalledTimes(2);
    expect(observers[0]!.stop).toHaveBeenCalledOnce();
    expect(observers[1]!.options.seedBusyCells).toEqual(["cell-a"]);
    expect(records(host, [policyOwner.anchorId])).toEqual([expect.objectContaining({ notification: "none", delivery: "suppressed" })]);
    observers[0]!.emit(wave("obsolete"));
    expect(records(host, [owner.anchorId, policyOwner.anchorId])).toHaveLength(2);
    observers[1]!.emit(wave("seeded-wave", "succeeded"));
    expect(observers[1]!.stop).not.toHaveBeenCalled(); // retained policy reference
    observers[1]!.emit(wave("next-wave"));
    expect(records(host, [policyOwner.anchorId]).filter(record => record.notification === "automatic")).toHaveLength(1);
  });

  test("a retained terminal wave is history: watch waits for fresh evidence or yields undefined at 1s", async () => {
    vi.useFakeTimers();
    const { host, observers, native } = setup();
    host.observeAll(owners("policy-anchor"), [target], true);
    observers[0]!.emit(wave("history", "succeeded"));
    const settled = vi.fn();
    const waiting = host.watch(watchSpec()).then(result => { settled(result); return result; });
    observers[0]!.emit(wave("history", "succeeded"));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBeUndefined();
    expect(records(host)).toEqual([]);
    const fresh = host.watch(watchSpec({ id: "fresh-watch" }));
    await vi.advanceTimersByTimeAsync(500);
    observers[0]!.emit(wave("fresh-wave"));
    expect(await fresh).toMatchObject({ id: "fresh-watch", owner, state: "running", notification: "explicit" });
    expect(native.spawn).not.toHaveBeenCalled();
  });
});

test("owner listeners are session-scoped, errors isolated, and replaceable without cancelling children", async () => {
  const { host, native } = setup();
  const stale = vi.fn(() => { throw new Error("stale adapter"); });
  const unrelated = vi.fn(); const next = vi.fn();
  const unsubscribe = host.subscribeOwner(owner.sessionId, stale);
  host.subscribeOwner("other-pi", unrelated);
  expect(() => host.start(spec())).not.toThrow(); await flush();
  expect(stale).toHaveBeenCalled(); expect(unrelated).not.toHaveBeenCalled();
  unsubscribe(); const count = stale.mock.calls.length;
  host.subscribeOwner(owner.sessionId, next);
  native.executions()[0]!.child.close();
  expect(next).toHaveBeenCalled(); expect(stale).toHaveBeenCalledTimes(count);
  expect(native.executions()[0]!.child.kill).not.toHaveBeenCalled();
});

test("target keys normalize loopback URLs but retain canonical path and captured session identity", () => {
  expect(executionTargetKey({ ...target, url: "http://localhost:2718/", path: "/alias.py" })).toBe(executionTargetKey(target));
  expect(executionTargetKey({ ...target, sessionId: "another" })).not.toBe(executionTargetKey(target));
  expect(executionTargetKey(targets("another"))).not.toBe(executionTargetKey(target));
  for (const state of ["starting", "running", "reconnecting"] as const) expect(isExecutionTerminal(state)).toBe(false);
  for (const state of ["succeeded", "failed", "interrupted", "unknown"] as const) expect(isExecutionTerminal(state)).toBe(true);
});

test("process singleton is stable and inert on retrieval (never dispose the shared singleton)", () => {
  // No global stubs, symbol deletion, network calls, starts or cleanup of a host
  // potentially shared with other workers/extensions in this process.
  const first = ownExecutions();
  expect(first).toBeInstanceOf(ExecutionHost);
  expect(ownExecutions()).toBe(first);
});
