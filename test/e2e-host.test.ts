// Opt-in against a real marimo server (released or main): PI_MARIMO_LIVE_TEST=1. On a host-capable
// marimo (main) it also checks the host protocol path; PI_MARIMO_LIVE_MARIMO picks the marimo command.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { findHost, resetHostCache } from "../src/core/hosts.js";
import { ownHeadlessSessions } from "../src/core/headless.js";
import { interruptKernel, runCells } from "../src/core/kernel.js";
import { nodeIo } from "../src/core/node-io.js";
import { MarimoWatcher } from "../src/core/watcher.js";
import { MARIMO, marimoAvailable } from "./live-marimo.js";

const NOTEBOOK = `import marimo

app = marimo.App()


@app.cell
def _():
    import time
    return (time,)


@app.cell
def _(time):
    time.sleep(1)
    y = 1
    print("hello")
    return (y,)


@app.cell
def _(y):
    z = y + 1
    z
    return (z,)


if __name__ == "__main__":
    app.run()
`;

const port = 27800 + Math.floor(Math.random() * 150);
let server: ChildProcess | undefined;
afterAll(() => { server?.kill(); });

async function until<T>(check: () => T | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 150));
  }
}

test.skipIf(!marimoAvailable())("follows, runs and interrupts a notebook on this marimo (host path when it has one)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-marimo-host-")));
  const file = join(dir, "nb.py");
  writeFileSync(file, NOTEBOOK);
  server = spawn(MARIMO[0]!, [...MARIMO.slice(1), "edit", file, "--headless", "--no-token", "--port", String(port)], { cwd: dir, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 600; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  await ownHeadlessSessions().attach(url, file);
  const watcher = new MarimoWatcher({ io: nodeIo(), cwd: dir, extraUrls: [url], pollMs: 300, onChange: () => {} });
  watcher.start();
  try {
    const f = await until(() => watcher.followed().find((o) => o.connection === "connected" && o.notebook.ready && o.notebook.order.length === 3));
    expect(f.notebook.ordered().map((c) => c.code.split("\n")[0])).toEqual(["import time", "time.sleep(1)", "z = y + 1"]);

    resetHostCache();
    const host = f.attachment.notebookId ? await findHost(url) : undefined;
    const target = { url, sessionId: f.attachment.sessionId, ...(f.attachment.notebookId ? { notebookId: f.attachment.notebookId } : {}) };
    const [, slow, last] = f.notebook.ordered();

    // Run everything through whichever path this marimo supports.
    await runCells(target, f.notebook.ordered().map((c) => ({ id: c.id, code: c.code })));
    await until(() => f.notebook.cells.get(last!.id)?.output?.codeBlocks?.some((b) => b.source === "2"));
    expect(f.notebook.cells.get(slow!.id)?.console?.some((l) => l.text.includes("hello"))).toBe(true);

    // And an interrupt, which must be accepted (a run of the slow cell is in flight or just ended).
    await runCells(target, [{ id: slow!.id, code: slow!.code }]);
    await interruptKernel(target);
    // A marimo chosen through PI_MARIMO_LIVE_MARIMO is the host-protocol one: it must have been used.
    if (process.env.PI_MARIMO_LIVE_MARIMO) expect(host?.url).toContain("/api/marimo/v1");
    else if (host) expect(host.url).toContain("/api/marimo/v1");
  } finally {
    await watcher.stop();
  }
}, 180_000);
