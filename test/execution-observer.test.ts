import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ExecutionWaveObserver, type WaveSnapshot } from "../src/core/execution-observer.js";
import type { Cancellable, Io, StreamEnd } from "../src/core/io.js";
import { SseParser } from "../src/core/sse.js";

const target = { url: "http://example.invalid:2799", path: "/tmp/notebook.py", sessionId: "selected-session" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const done = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { done, resolve, reject };
}

class FakeIo implements Io {
  registryEntries = vi.fn(async () => { throw new Error("No discovery allowed"); });
  getJson = vi.fn(async () => { throw new Error("No HTTP requests allowed"); });
  postJson = vi.fn(async () => { throw new Error("No kernel mutations allowed"); });
  realpath = vi.fn(async (path: string) => path);
  streams: Array<ReturnType<typeof deferred<StreamEnd>> & { url: string; headers: Record<string, string>; send: (text: string) => void; cancel: ReturnType<typeof vi.fn> }> = [];
  stream = vi.fn((url: string, headers: Record<string, string>, send: (text: string) => void): Cancellable<StreamEnd> => {
    const result = deferred<StreamEnd>();
    const cancel = vi.fn(() => result.resolve({ ok: true }));
    this.streams.push({ ...result, url, headers, send, cancel });
    return { done: result.done, cancel };
  });
  sleep = vi.fn((ms: number): Cancellable<void> => {
    const result = deferred<void>();
    const timer = setTimeout(() => result.resolve(), ms);
    return { done: result.done, cancel: () => { clearTimeout(timer); result.resolve(); } };
  });
  send(op: string, data: unknown = {}, index = this.streams.length - 1) {
    this.streams[index]!.send(`data: ${JSON.stringify({ op, data })}\n\n`);
  }
  cell(id: string, status?: string, extra: Record<string, unknown> = {}) {
    this.send("cell-op", { cell_id: id, status, ...extra });
  }
  error(id: string, type = "exception", msg = "boom") {
    this.cell(id, undefined, { output: { channel: "marimo-error", data: [{ type, msg, exception_type: "ValueError" }] } });
  }
  end(run_id: string | null = null) { this.send("completed-run", { run_id }); }
}

const observers: ExecutionWaveObserver[] = [];
function setup(options: Partial<ConstructorParameters<typeof ExecutionWaveObserver>[0]> = {}) {
  const io = new FakeIo();
  const changes: WaveSnapshot[] = [];
  let id = 0;
  const observer = new ExecutionWaveObserver({ target, io, token: "", now: Date.now, id: () => `wave-${++id}`, onChange: snapshot => changes.push(snapshot), ...options });
  observers.push(observer);
  return { io, observer, changes, wave: () => observer.snapshot().wave! };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => {
  for (const observer of observers.splice(0)) observer.stop();
  vi.useRealTimers();
});
const tick = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

describe("execution wave observation", () => {
  test("structured error metadata is bounded without hiding the terminal failure", () => {
    const { io, observer, wave } = setup(); observer.start();
    for (let i = 0; i < 40; i++) {
      const id = `cell-${i}`;
      io.cell(id, "running");
      for (let n = 0; n < 8; n++) io.error(id, "exception", `${n}: ${"x".repeat(10_000)}`);
      io.cell(id, "idle");
    }
    io.end("bounded");
    expect(wave().state).toBe("failed");
    expect(wave().errors).toHaveLength(32);
    expect(wave().errors.every(error => error.length <= 642)).toBe(true);
  });
  test("construction is inert; start is idempotent and uses only the exact read-only kiosk target", () => {
    const captured = { ...target };
    const { io, observer } = setup({ target: captured, token: "test-token" });
    captured.sessionId = "another-session";
    expect(observer.snapshot()).toEqual({ connection: "stopped" });
    expect(io.stream).not.toHaveBeenCalled();
    expect(io.sleep).not.toHaveBeenCalled();
    observer.start();
    observer.start();
    expect(io.stream).toHaveBeenCalledTimes(1);
    const request = io.streams[0]!;
    const url = new URL(request.url);
    expect(url.pathname).toBe("/sse");
    expect(Object.fromEntries(url.searchParams)).toEqual({ session_id: target.sessionId, file: target.path, kiosk: "true", access_token: "test-token" });
    expect(request.headers.Accept).toBe("text/event-stream");
    expect(observer.snapshot().connection).toBe("connecting");
    io.send("kernel-ready");
    expect(observer.snapshot().connection).toBe("connected");
    expect(io.registryEntries).not.toHaveBeenCalled();
    expect(io.getJson).not.toHaveBeenCalled();
    expect(io.postJson).not.toHaveBeenCalled();
  });

  test("recorded kiosk run waits for scratch idle AND the live final completed-run", () => {
    const { io, observer, wave } = setup();
    observer.start();
    const fixture = readFileSync(new URL("./fixtures/kiosk-run.sse", import.meta.url), "utf8");
    const messages = new SseParser().push(fixture).map(event => JSON.parse(event.data));
    const final = messages.findLastIndex(message => message.op === "completed-run");
    const scratchIdle = messages.findLastIndex(message => message.op === "cell-op" && message.data.cell_id === "__scratch__" && message.data.status === "idle");
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      io.send(message.op, message.data);
      if (i < final && observer.snapshot().wave) expect(wave().endedAt).toBeUndefined();
      if (i === scratchIdle - 1) expect(wave().busyCells).toEqual(["__scratch__"]);
      if (i === scratchIdle) expect(wave().busyCells).toEqual([]);
    }
    expect(wave()).toMatchObject({ id: "wave-1", state: "failed", busyCells: [], errors: ["PKri: ZeroDivisionError: division by zero"], blocked: [], startedAt: 1000, endedAt: 1000 });
  });

  test.each([null, "unrelated-completion-id"])("does not correlate cell run IDs with completion ID %j", run_id => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "queued", { run_id: "cell-run" });
    io.cell("a", "running", { run_id: "cell-run" });
    io.cell("a", "idle", { run_id: null });
    expect(wave().state).toBe("running");
    io.end(run_id);
    expect(wave().state).toBe("succeeded");
  });

  test("initial merged replay idle/error state and kernel-ready never create a wave", async () => {
    const { io, observer, changes } = setup();
    observer.start();
    io.send("kernel-ready", { cell_ids: ["a"] });
    io.cell("a", "idle");
    io.error("a");
    io.error("child", "ancestor-prevented");
    await tick(60_000);
    expect(observer.snapshot().wave).toBeUndefined();
    expect(changes.every(snapshot => snapshot.wave === undefined)).toBe(true);
  });

  test("a terminal boundary cannot finish queued descendants or an internal scratch participant", () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("fit", "running");
    io.cell("child", "queued");
    io.cell("__scratch__", "running");
    io.cell("fit", "idle");
    io.end("too-early");
    expect(wave().busyCells).toEqual(["child", "__scratch__"]);
    io.cell("child", "running");
    io.cell("child", "idle");
    io.cell("__scratch__", "idle");
    expect(wave().endedAt).toBeUndefined();
    io.end("final");
    expect(wave().state).toBe("succeeded");
  });

  test("errors are wave-local, repeated failure counts, and an unrelated historical error does not", () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.error("unrelated");
    for (let run = 1; run <= 2; run++) {
      io.cell("a", "queued");
      io.cell("a", "running");
      io.error("a");
      io.cell("a", "idle");
      io.end(`end-${run}`);
      expect(wave()).toMatchObject({ id: `wave-${run}`, state: "failed", errors: ["a: ValueError: boom"] });
    }
    io.cell("a", "queued");
    expect(wave().errors).toEqual([]);
    io.cell("a", "running");
    io.cell("a", "idle");
    io.end("success");
    expect(wave().state).toBe("succeeded");
  });

  test.each(["ancestor-prevented", "ancestor-stopped"])("%s descendants are blocked, never successful", type => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("child", "queued");
    io.error("child", type);
    io.cell("child", "idle");
    io.end();
    expect(wave()).toMatchObject({ state: "failed", blocked: ["child"], errors: [] });
  });

  test("structured interruption is distinct from an exception whose message mentions interruption", () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("__scratch__", "running");
    io.error("__scratch__", "exception", "interruption");
    io.cell("__scratch__", "idle");
    io.end();
    expect(wave().state).toBe("failed");
    io.cell("__scratch__", "running");
    io.error("__scratch__", "interruption");
    io.cell("__scratch__", "idle");
    io.end();
    expect(wave()).toMatchObject({ state: "interrupted", errors: ["__scratch__: interrupted"] });
  });

  test("merged busy replay excludes old structured errors using output timestamps", () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running", { timestamp: 10, output: { channel: "marimo-error", timestamp: 9, data: [{ type: "exception", msg: "old" }] } });
    expect(wave().errors).toEqual([]);
    io.cell("a", "idle", { timestamp: 11 });
    io.end();
    expect(wave().state).toBe("succeeded");
  });

  test("same-status updates retain this run's error evidence until an actual busy transition", () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running", { timestamp: 10 });
    io.error("a");
    io.cell("a", "running", { timestamp: 11 });
    expect(wave().errors).toEqual(["a: ValueError: boom"]);
    io.cell("a", "idle", { timestamp: 12 });
    io.end();
    expect(wave().state).toBe("failed");
  });

  test("missing terminal boundary becomes unknown after 30s nonbusy; output does not reset grace", async () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running");
    io.cell("a", "idle");
    await tick(29_000);
    io.cell("a", undefined, { output: { channel: "output", data: "late output" } });
    expect(wave().endedAt).toBeUndefined();
    await tick(1000);
    expect(wave()).toMatchObject({ state: "unknown", endedAt: 31_000, errors: ["Completion was not observed; inspect the notebook before continuing."] });
    io.end("late");
    expect(wave().state).toBe("unknown");
  });

  test.each(["queued", "running"])("never duration-times-out observed %s work, and resets quiet grace on new busy evidence", async status => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", status);
    await tick(600_000);
    expect(wave().state).toBe("running");
    io.cell("a", "idle");
    await tick(29_999);
    io.cell("child", status);
    await tick(60_000);
    expect(wave().endedAt).toBeUndefined();
    io.cell("child", "idle");
    await tick(29_999);
    expect(wave().endedAt).toBeUndefined();
    io.end();
    expect(wave().state).toBe("succeeded");
  });

  test("seeded busy evidence waits through replayed idle without inventing a terminal event", async () => {
    const { io, observer, wave } = setup({ seedBusyCells: ["a", "a", "__scratch__"] });
    expect(wave().busyCells).toEqual(["a", "__scratch__"]);
    expect(io.sleep).not.toHaveBeenCalled();
    observer.start();
    io.send("kernel-ready");
    io.cell("a", "idle");
    io.cell("__scratch__", "idle");
    await tick(30_000);
    expect(wave().state).toBe("unknown");
  });

  test("seed busy plus a subsequently observed live terminal boundary can complete", () => {
    const { io, observer, wave } = setup({ seedBusyCells: ["a"] });
    observer.start();
    io.cell("a", "idle");
    io.end();
    expect(wave().state).toBe("succeeded");
  });

  test("duplicate terminal notifications do not finish twice; new busy work gets a new identity", () => {
    const { io, observer, wave, changes } = setup();
    observer.start();
    io.cell("a", "running");
    io.cell("a", "idle");
    io.end("one");
    const count = changes.length;
    io.end("one");
    io.end(null);
    expect(changes).toHaveLength(count);
    io.cell("a", "running");
    io.cell("a", "idle");
    io.end("one");
    expect(wave()).toMatchObject({ id: "wave-2", state: "running" });
    io.end("two");
    expect(wave()).toMatchObject({ id: "wave-2", state: "succeeded" });
    expect(changes.filter(snapshot => snapshot.wave?.endedAt !== undefined)).toHaveLength(2);
  });

  test("stale cell timestamps cannot resurrect busy work or erase current busy state", () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running", { timestamp: 10 });
    io.cell("a", "idle", { timestamp: 9 });
    expect(wave().busyCells).toEqual(["a"]);
    io.cell("a", "idle", { timestamp: 11 });
    io.end();
    io.cell("a", "running", { timestamp: 10 });
    expect(wave().id).toBe("wave-1");
  });

  test("snapshots and listener snapshots are defensive copies; listener errors are isolated", () => {
    const changed = vi.fn((snapshot: WaveSnapshot) => {
      snapshot.wave?.busyCells.push("fake");
      snapshot.wave?.errors.push("fake");
      snapshot.wave?.blocked.push("fake");
      if (snapshot.wave) snapshot.wave.state = "failed";
      throw new Error("listener failed");
    });
    const { io, observer, wave } = setup({ onChange: changed });
    expect(() => observer.start()).not.toThrow();
    io.cell("a", "running");
    const snapshot = observer.snapshot();
    snapshot.connection = "stopped";
    snapshot.wave!.id = "mutated";
    snapshot.wave!.busyCells.push("bad");
    expect(wave()).toMatchObject({ id: "wave-1", state: "running", busyCells: ["a"], errors: [], blocked: [] });
    expect(observer.snapshot().connection).toBe("connecting");
    io.cell("a", "idle");
    expect(() => io.end()).not.toThrow();
    expect(wave().state).toBe("succeeded");
  });
});

describe("stream uncertainty and lifetime", () => {
  test("disconnect preserves the wave and retries only the same exact target", async () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running", { timestamp: 10 });
    io.streams[0]!.resolve({ ok: true });
    await tick();
    expect(observer.snapshot()).toMatchObject({ connection: "reconnecting", wave: { id: "wave-1", state: "reconnecting", busyCells: ["a"] } });
    await tick(999);
    expect(io.streams).toHaveLength(1);
    await tick(1);
    expect(io.streams).toHaveLength(2);
    expect(io.streams[1]!.url).toBe(io.streams[0]!.url);
    io.send("kernel-ready", { session_id: "replacement-session" });
    expect(wave().state).toBe("reconnecting");
    io.cell("a", "running", { timestamp: 10 });
    expect(wave().state).toBe("running");
    io.cell("a", "idle", { timestamp: 11 });
    io.end("new-end");
    expect(wave()).toMatchObject({ id: "wave-1", state: "succeeded" });
  });

  test("reconnect idle plus terminal without renewed busy proof is uncertainty, not success", async () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running");
    io.streams[0]!.resolve({ ok: false, status: 404 });
    await tick(1000);
    io.send("kernel-ready");
    io.cell("a", "idle");
    io.end("unproven");
    expect(wave().state).toBe("reconnecting");
    await tick(29_000);
    expect(wave().state).toBe("unknown");
    expect(observer.snapshot().connection).toBe("stopped");
  });

  test("disconnected stale busy work becomes unknown after the retry budget", async () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("__scratch__", "running");
    io.streams[0]!.reject(new Error("lost transport"));
    await tick(30_000);
    expect(wave()).toMatchObject({ id: "wave-1", state: "unknown" });
    expect(observer.snapshot().connection).toBe("stopped");
    const requests = io.streams.length;
    await tick(60_000);
    expect(io.streams).toHaveLength(requests);
  });

  test("fresh busy after recovery is not timed out by the original disconnect deadline", async () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running");
    io.streams[0]!.resolve({ ok: true });
    await tick(1000);
    io.send("kernel-ready");
    io.cell("a", "running");
    await tick(90_000);
    expect(wave().state).toBe("running");
    expect(wave().endedAt).toBeUndefined();
  });

  test("old generation callbacks cannot change the wave or trigger additional retries", async () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running");
    io.streams[0]!.resolve({ ok: true });
    await tick();
    io.send("cell-op", { cell_id: "a", status: "idle" }, 0);
    io.send("completed-run", { run_id: "late" }, 0);
    expect(wave().busyCells).toEqual(["a"]);
    await tick(1000);
    io.cell("a", "running");
    io.send("cell-op", { cell_id: "bogus", status: "queued" }, 0);
    expect(wave().busyCells).toEqual(["a"]);
    observer.stop();
    const stopped = observer.snapshot();
    io.cell("a", "idle");
    io.end();
    await tick(60_000);
    expect(observer.snapshot()).toEqual(stopped);
    expect(io.streams).toHaveLength(2);
  });

  test("stop is idempotent, closes kiosk only, and cancels retry/grace timers", async () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running");
    io.cell("a", "idle");
    observer.stop();
    observer.stop();
    await tick(60_000);
    expect(io.streams[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(io.streams).toHaveLength(1);
    expect(wave().state).toBe("running");
    expect(observer.snapshot().connection).toBe("stopped");
    expect(io.postJson).not.toHaveBeenCalled();
  });

  test("stop while waiting for a reconnect cancels the pending retry", async () => {
    const { io, observer } = setup();
    observer.start();
    io.streams[0]!.resolve({ ok: false, status: 404 });
    await tick();
    observer.stop();
    await tick(60_000);
    expect(io.streams).toHaveLength(1);
    expect(observer.snapshot().connection).toBe("stopped");
  });

  test("a listener can stop synchronously without opening resources afterward", () => {
    let observer!: ExecutionWaveObserver;
    const fixture = setup({ onChange: () => observer.stop() });
    observer = fixture.observer;
    observer.start();
    expect(fixture.io.stream).not.toHaveBeenCalled();
    expect(observer.snapshot().connection).toBe("stopped");
  });

  test("restart invalidates old callbacks and requires fresh busy evidence", async () => {
    const { io, observer, wave } = setup();
    observer.start();
    io.cell("a", "running");
    observer.stop();
    observer.start();
    io.send("completed-run", {}, 0);
    io.cell("a", "idle");
    io.end();
    expect(wave().state).toBe("reconnecting");
    await tick(30_000);
    expect(wave().state).toBe("unknown");
  });

  test("HTTP refusal, explicit stream close, and synchronous stream failure stay bounded", async () => {
    const { io, observer, wave } = setup({ seedBusyCells: ["a"], graceMs: 2500, retryMs: 1000 });
    io.stream.mockImplementationOnce(() => { throw new Error("cannot open"); });
    observer.start();
    expect(wave().state).toBe("reconnecting");
    await tick(1000);
    io.streams[0]!.resolve({ ok: false, status: 403 });
    await tick(1000);
    io.streams[1]!.send('event: close\ndata: {"code":1000,"reason":"session replaced"}\n\n');
    await tick(500);
    expect(wave().state).toBe("unknown");
    expect(observer.snapshot().connection).toBe("stopped");
    expect(io.stream).toHaveBeenCalledTimes(3);
  });
});
