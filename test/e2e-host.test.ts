// Opt-in against a real marimo server (released or main): PI_MARIMO_LIVE_TEST=1. On a host-capable
// marimo (main) it also checks the host protocol path; PI_MARIMO_LIVE_MARIMO picks the marimo command.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { interruptKernel, runCells } from "../src/core/kernel.js";
import { PairInbox } from "../src/core/pair-inbox.js";
import { liveMarimoFixture, marimoEnabled } from "./live-marimo.js";

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

async function until<T>(check: () => T | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 150));
  }
}

test.skipIf(!marimoEnabled())("follows, runs and interrupts a notebook on this marimo (host path when it has one)", async () => {
  const fixture = liveMarimoFixture();
  const file = join(fixture.dir, "nb.py");
  writeFileSync(file, NOTEBOOK);
  // Only the pinned host lane requires the host protocol.
  const requireHost = process.env.PI_MARIMO_REQUIRE_HOST === "1";
  const url = await fixture.start(file);
  const sessionId = await fixture.attach(file, { requireNotebookId: requireHost });
  fixture.watch();
  const f = await fixture.follow(file, sessionId);
  await fixture.ready("watched notebook document", () => f.notebook.order.length === 3);
  expect(f.notebook.ordered().map((c) => c.code.split("\n")[0])).toEqual(["import time", "time.sleep(1)", "z = y + 1"]);

  // Resolve the private host record before running.
  const host = requireHost
    ? await fixture.ready("host protocol registration", () => fixture.findHost(url))
    : f.attachment.notebookId ? await fixture.findHost(url) : undefined;
  if (requireHost) expect(f.attachment.notebookId).toBeTruthy();
  const findHost = async () => host;
  const target = { url, sessionId: f.attachment.sessionId, ...(f.attachment.notebookId ? { notebookId: f.attachment.notebookId } : {}) };
  const [, slow, last] = f.notebook.ordered();

  // Run everything through whichever path this marimo supports.
  await runCells(target, f.notebook.ordered().map((c) => ({ id: c.id, code: c.code })), undefined, undefined, findHost);
  await until(() => f.notebook.cells.get(last!.id)?.output?.codeBlocks?.some((b) => b.source === "2"));
  expect(f.notebook.cells.get(slow!.id)?.console?.some((l) => l.text.includes("hello"))).toBe(true);

  // And an interrupt, which must be accepted (a run of the slow cell is in flight or just ended).
  await runCells(target, [{ id: slow!.id, code: slow!.code }], undefined, undefined, findHost);
  await interruptKernel(target, undefined, undefined, findHost);
  if (host && f.attachment.notebookId) {
    // Pi attaches as an agent: marimo lists it on the notebook.
    const inbox = new PairInbox({ onMessage: () => {}, identity: "pi-marimo-e2e", findHost });
    onTestFinished(() => inbox.dispose());
    inbox.sync([{ serverUrl: url, notebookId: f.attachment.notebookId, path: file }]);
    try {
      await until(() => inbox.attachedKeys().length === 1, 15_000);
      const res = await fetch(`${host.url}/notebooks/${f.attachment.notebookId}/events?types=attachment`, {
        headers: { Authorization: `Bearer ${host.token}`, Accept: "text/event-stream" },
        signal: AbortSignal.any([fixture.signal, AbortSignal.timeout(15_000)]),
      });
      expect(res.ok).toBe(true);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (!text.includes("event: ready")) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      expect(text).toContain("event: ready");
      expect(text).toContain('"identity":"pi-marimo-e2e"');
      expect(text).toContain('"kind":"agent"');
      expect(text).toContain('"name":"Pi"');
    } finally { inbox.dispose(); }
  }
  if (host) expect(host.url).toContain("/api/marimo/v1");
}, 180_000);
