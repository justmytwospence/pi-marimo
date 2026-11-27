// Live tests run marimo from PATH or PI_MARIMO_LIVE_MARIMO (e.g. `uvx --from git+... marimo`).
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { onTestFinished } from "vitest";
import { HeadlessSessions } from "../src/core/headless.js";
import { hostForServer, readHostRecords } from "../src/core/hosts.js";
import { hostsDir, nodeIo, registryDir } from "../src/core/node-io.js";
import { listSessions, serverUrls } from "../src/core/registry.js";
import { SessionDecoder, SseParser } from "../src/core/sse.js";
import { sameServer } from "../src/core/touch.js";
import { MarimoWatcher } from "../src/core/watcher.js";
import { freePort } from "../src/servers.js";

export const marimoEnabled = () => process.env.PI_MARIMO_LIVE_TEST === "1";
const marimoCommand = () => process.env.PI_MARIMO_LIVE_MARIMO?.split(" ").filter(Boolean) ?? ["marimo"];

const STDERR_LIMIT = 4096;
const STOP_MS = 2000;

async function bounded<T>(work: Promise<T>, ms: number, timeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout()), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function launch(command: readonly string[], args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) {
  const [bin, ...prefix] = command;
  if (!bin) throw new Error("live marimo requested but no executable was configured");
  // As in OwnServers: uv/uvx may wrap marimo, so signal only this child's process group.
  const child = spawn(bin, [...prefix, ...args], { cwd, env, detached: true, stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
  const exited = new Promise<string>((resolve) => {
    child.once("error", (error) => resolve(`could not run ${bin}: ${error.message}`));
    child.once("exit", (code, signal) => resolve(signal ? `signal ${signal}` : `exit ${code}`));
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const diagnostic = (message: string) => new Error(`${message}\nstderr tail: ${stderr.trim() || "(empty)"}`);
  const signalGroup = (signal: NodeJS.Signals | 0) => {
    if (!child.pid) return false;
    try { return process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return false;
    }
  };
  if (input !== undefined) {
    // A failed spawn or early exit is reported by the child, not by a write to its closed stdin.
    child.stdin!.on("error", () => {});
    child.stdin!.end(input);
  }
  return { closed, exited, diagnostic, signalGroup, async stop() {
    signalGroup("SIGTERM");
    await bounded(closed, STOP_MS, () => diagnostic("waiting for graceful fixture shutdown")).catch(() => {});
    // A wrapper can close first, leaving a kernel in its group. Kill any remainder even then.
    signalGroup("SIGKILL");
    await bounded(closed, STOP_MS, () => diagnostic("fixture child did not close after SIGKILL"));
  } };
}

/** One test's files, private discovery state, connections and child process groups. */
class LiveMarimo {
  readonly dir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  readonly io: ReturnType<typeof nodeIo>;
  private readonly children = new Set<ReturnType<typeof launch>>();
  private readonly headless = new HeadlessSessions();
  private readonly streams: Array<ReturnType<LiveMarimo["io"]["stream"]>> = [];
  private watcher?: MarimoWatcher;
  private server?: ReturnType<typeof launch>;
  private disposePromise?: Promise<void>;
  private deadline = 0;
  url = "";

  constructor(private readonly command: readonly string[]) {
    if (process.platform === "win32") throw new Error("live marimo fixtures require POSIX process groups");
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-marimo-live-")));
    this.env = {
      ...process.env, HOME: this.dir, XDG_STATE_HOME: join(this.dir, "state"),
      XDG_CONFIG_HOME: join(this.dir, "config"), XDG_CACHE_HOME: join(this.dir, "cache"),
    };
    delete this.env.MARIMO_TOKEN;
    this.io = nodeIo({ registryDir: registryDir(this.env), fetch: (input, init) => fetch(input, {
      ...init, signal: init?.signal ? AbortSignal.any([this.signal, init.signal]) : this.signal,
    }) });
  }

  private launch(args: string[], input?: string) {
    this.signal.throwIfAborted();
    const owned = launch(this.command, args, this.dir, this.env, input);
    this.children.add(owned);
    void owned.closed.then(() => { if (!owned.signalGroup(0)) this.children.delete(owned); });
    return owned;
  }

  async start(path: string, timeoutMs = 60_000): Promise<string> {
    this.signal.throwIfAborted();
    const port = await freePort();
    this.signal.throwIfAborted();
    if (this.url) throw new Error("a live fixture owns only one server");
    this.url = `http://127.0.0.1:${port}`;
    this.deadline = Date.now() + timeoutMs;
    this.server = this.launch(["edit", path, "--host", "127.0.0.1", "--port", String(port), "--headless", "--no-token", "--skip-update-check"]);
    await this.ready("HTTP and server registry", async (signal) => {
      if (!(await serverUrls(this.io)).some((url) => sameServer(url, this.url))) return false;
      try {
        const res = await fetch(`${this.url}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
        await res.body?.cancel();
        return res.ok;
      } catch { return false; }
    });
    return this.url;
  }

  /** All startup phases share a deadline. Check child exit even during an async probe. */
  async ready<T>(phase: string, probe: (signal: AbortSignal) => T | false | undefined | Promise<T | false | undefined>): Promise<T> {
    const server = this.server;
    if (!server) throw new Error("start the live fixture before waiting for readiness");
    const remaining = Math.max(0, this.deadline - Date.now());
    const waiting = new AbortController();
    const signal = AbortSignal.any([this.signal, waiting.signal]);
    const prefix = `live marimo waiting for ${phase}`;
    const loop = async () => {
      for (;;) {
        signal.throwIfAborted();
        const value = await probe(signal);
        if (value) return value;
        await delay(100, undefined, { signal });
      }
    };
    try {
      return await bounded(Promise.race([loop(), server.exited.then(async (reason) => {
        // Give the pipe a chance to deliver the last stderr after the exit event.
        await bounded(server.closed, 100, () => new Error("stderr still open")).catch(() => {});
        throw server.diagnostic(`${prefix}: ${reason}`);
      })]), remaining, () => server.diagnostic(`${prefix}: readiness timed out`));
    } finally { waiting.abort(); }
  }

  private async registered(file: string, sessionId: string, requireNotebookId = false): Promise<void> {
    await this.ready(`file/session registration (${file}, ${sessionId}${requireNotebookId ? ", host notebook id" : ""})`, async () => {
      const sessions = await listSessions(this.io, this.url);
      const session = sessions.find((entry) => entry.sessionId === sessionId);
      return session !== undefined && (!requireNotebookId || !!session.notebookId) &&
        await this.io.realpath(resolve(this.dir, session.path)) === file;
    });
  }

  async attach(file: string, options: { requireNotebookId?: boolean } = {}): Promise<string> {
    const waitMs = Math.min(15_000, Math.max(1, this.deadline - Date.now()));
    const id = await this.ready(`headless kernel (${file})`, () => this.headless.attach(this.url, file, undefined, waitMs)
      .catch((error: unknown) => { throw this.server!.diagnostic(`live marimo headless attach failed: ${String(error)}`); }));
    await this.registered(file, id, options.requireNotebookId);
    return id;
  }

  async openBrowser(file: string, sessionId: string): Promise<void> {
    this.signal.throwIfAborted();
    // Stand in for the browser: the main consumer creates and holds the session, not a kiosk.
    const query = new URLSearchParams({ session_id: sessionId, file });
    const parser = new SseParser();
    const decoder = new SessionDecoder();
    let kernelReady = false;
    const stream = this.io.stream(`${this.url}/sse?${query}`, { Accept: "text/event-stream" }, (text) => {
      for (const event of parser.push(text)) for (const message of decoder.decode(event)) {
        if (message.op === "kernel-ready") kernelReady = true;
      }
    });
    this.streams.push(stream);
    let ended = false;
    void stream.done.then(() => { ended = true; });
    await this.ready(`browser kernel (${file}, ${sessionId})`, () => {
      if (ended) throw this.server!.diagnostic(`live marimo browser stream ended for ${file}`);
      return kernelReady;
    });
    await this.registered(file, sessionId);
  }

  watch(onChange: () => void = () => {}): MarimoWatcher {
    this.signal.throwIfAborted();
    if (this.watcher) throw new Error("a live fixture owns only one watcher");
    this.watcher = new MarimoWatcher({ io: this.io, cwd: this.dir, pollMs: 300, onChange });
    this.watcher.start();
    return this.watcher;
  }

  follow(file: string, sessionId: string) {
    const watcher = this.watcher;
    if (!watcher) throw new Error("start the live fixture watcher before following a file");
    return this.ready(`watcher kernel (${file}, ${sessionId})`, () => watcher.followed().find((f) =>
      sameServer(f.attachment.url, this.url) && f.attachment.path === file &&
      f.attachment.sessionId === sessionId && f.connection === "connected" && f.notebook.ready));
  }

  findHost = async (url: string) => hostForServer(await readHostRecords(hostsDir(this.env)), url);

  async runPair(sessionId: string, code: string): Promise<void> {
    // The browser consumer id keys /api/sessions, but the CLI takes the stable id in its value.
    const sessions = await listSessions(this.io, this.url);
    const stableId = sessions.find((session) => session.sessionId === sessionId)?.pairSessionId;
    if (!stableId) throw this.server!.diagnostic(`live marimo pair execute: no stable session id for ${sessionId}`);
    // In default JSON mode the CLI puts failure details on stdout, which the fixture discards.
    const run = this.launch(["pair", "execute", "--url", this.url, "--session", stableId, "--code-file", "-", "--stream"], code);
    const reason = await bounded(run.exited, 30_000, () => run.diagnostic("live marimo pair execute timed out"));
    await bounded(run.closed, STOP_MS, () => run.diagnostic("live marimo pair execute did not close"));
    if (reason !== "exit 0") throw run.diagnostic(`live marimo pair execute failed: ${reason}`);
  }

  dispose(): Promise<void> {
    return this.disposePromise ??= this.cleanup();
  }

  private async cleanup(): Promise<void> {
    this.abort.abort(new Error("live marimo fixture disposed"));
    for (const stream of this.streams) stream.cancel();
    this.headless.closeAll();
    const stopped = await Promise.allSettled([
      this.watcher?.stop(),
      ...this.streams.map((stream) => bounded(stream.done, STOP_MS, () => new Error("fixture browser stream did not close"))),
      ...[...this.children].map((child) => child.stop()),
    ]);
    const problems = stopped.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (problems.length) throw new AggregateError(problems, `live marimo cleanup failed; fixture retained at ${this.dir}: ${problems.join("; ")}`);
    await rm(this.dir, { recursive: true, force: true });
  }
}

export function liveMarimoFixture(command = marimoCommand()): LiveMarimo {
  const fixture = new LiveMarimo(command);
  onTestFinished(() => fixture.dispose());
  return fixture;
}
