// Opt-in against a real marimo: PI_MARIMO_LIVE_TEST=1 and `marimo` on PATH. What the view does to a
// notebook, end to end: Pi starts the server, opens the notebook without a browser, runs its cells,
// sets a widget, runs Python in the scratchpad, and (when marimo-lens is installed) marks a cell.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { EditCellService } from "../src/core/edit-cell.js";
import { PackageClient } from "../src/core/packages.js";
import { HeadlessSessions } from "../src/core/headless.js";
import { nodeIo } from "../src/core/node-io.js";
import type { CellOutput } from "../src/core/output.js";
import { MarimoWatcher } from "../src/core/watcher.js";
import { OwnServers } from "../src/servers.js";
import { runCells, setUiValues } from "../src/ui/interrupt.js";
import { markCell, unmarkSelection } from "../src/ui/lens-mark.js";
import { runScratch, type ScratchEvent } from "../src/ui/scratch.js";

const live = (() => {
  if (process.env.PI_MARIMO_LIVE_TEST !== "1") return false;
  try {
    execFileSync("marimo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!live)("package-list-read-only in a disposable fixture session", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-marimo-package-list-")));
  const file = join(dir, "packages.py");
  writeFileSync(file, NOTEBOOK);
  const server = await servers.start({ command: ["marimo"], file, cwd: dir, timeoutMs: 60_000 });
  const sessionId = await headless.attach(server.url, file);
  const watcher = new MarimoWatcher({ io: nodeIo(), cwd: dir, pollMs: 300, onChange: () => undefined });
  watcher.start();
  let client: PackageClient | undefined;
  try {
    const followed = await until(() => watcher.followed().find(f => f.attachment.path === file && f.connection === "connected" && f.notebook.ready));
    client = new PackageClient({
      target: followed.attachment, filename: file, notebook: followed.notebook,
      isCurrent: () => watcher.followed().some(f => f.notebook === followed.notebook && f.attachment.sessionId === sessionId),
      isConnected: () => followed.connection === "connected", executeOnce: runScratch, reconcile: () => undefined,
      timeoutMs: 30_000,
    });
    // Deliberately no install/upgrade/remove here, even on disposable notebooks:
    // the Python environment itself can be shared with the developer's server.
    const snapshot = await client.list();
    expect(snapshot.fingerprint.filename).toBe(file);
    expect(snapshot.fingerprint.pid).toBeGreaterThan(0);
    expect(snapshot.fingerprint.executable.startsWith("/")).toBe(true);
    expect(snapshot.packages).toEqual(expect.arrayContaining([expect.objectContaining({ name: "marimo", version: expect.any(String) })]));
  } finally {
    client?.dispose();
    await watcher.stop();
  }
}, 120_000);

const NOTEBOOK = `import marimo

app = marimo.App()


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    n = mo.ui.slider(0, 10, value=3, label="n")
    n
    return (n,)


@app.cell
def _(n):
    doubled = n.value * 2
    print(f"doubled={doubled}")
    doubled
    return (doubled,)


if __name__ == "__main__":
    app.run()
`;

const servers = new OwnServers();
const headless = new HeadlessSessions();
afterAll(() => {
  headless.closeAll();
  servers.stopAll();
});

// marimo renders scalar results as <pre>; ordered HTML preserves these as code blocks,
// not prose in output.text. Require a single result block, not a substring elsewhere.
function scalarResult(output: CellOutput | undefined): string | undefined {
  if (output?.blocks?.length !== 1) return undefined;
  const leaf = output.blocks[0]!.output;
  return leaf.kind === "text" && leaf.text === "" && leaf.codeBlocks?.length === 1
    ? leaf.codeBlocks[0]!.source : undefined;
}

async function until<T>(check: () => T | undefined | false, ms = 30_000, diagnostic?: () => unknown): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out${diagnostic ? `: ${JSON.stringify(diagnostic())}` : ""}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.skipIf(!live)("a notebook Pi starts: run, set a widget, run Python, mark a cell", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-marimo-actions-")));
  const file = join(dir, "nb.py");
  writeFileSync(file, NOTEBOOK);
  const server = await servers.start({ command: ["marimo"], file, cwd: dir, timeoutMs: 60_000 });
  const sessionId = await headless.attach(server.url, file);
  const watcher = new MarimoWatcher({ io: nodeIo(), cwd: dir, pollMs: 300, onChange: () => undefined });
  watcher.start();
  try {
    const f = await until(() => watcher.followed().find((o) => o.attachment.path === file && o.connection === "connected" && o.notebook.ready));
    expect(f.attachment.sessionId).toBe(sessionId);
    const nb = f.notebook;
    await runCells(f.attachment, nb.ordered().map((c) => ({ id: c.id, code: c.code })));
    const doubled = await until(() => nb.ordered().find((c) => c.code.includes("doubled =") && scalarResult(c.output) === "6"), 30_000, () => nb.ordered());
    // Terminal parsing is asynchronous: an output event need not have flushed stdout yet.
    await until(() => doubled.console?.some(line => line.stream === "stdout" && line.text === "doubled=6"), 30_000, () => doubled);
    const slider = await until(() => nb.ordered().map((c) => c.output?.widgets?.[0]).find((w) => w?.kind === "slider"));
    expect(slider).toMatchObject({ label: "n", initial: 3, start: 0, stop: 10 });
    await setUiValues(f.attachment, [slider.objectId], [7]);
    await until(() => scalarResult(doubled.output) === "14", 30_000, () => doubled);
    await until(() => doubled.console?.some(line => line.stream === "stdout" && line.text === "doubled=14"), 30_000, () => doubled);
    expect(doubled.console?.some(line => line.text === "doubled=6")).toBe(false);
    expect(doubled.lastRunMs).toBeGreaterThanOrEqual(0);

    const events: ScratchEvent[] = [];
    const result = await runScratch(f.attachment, "print(n.value + 1)", undefined, (e) => events.push(e));
    expect(events).toContainEqual({ stream: "stdout", text: "8" });
    expect(result.success).toBe(true);

    const lens = await until(() => nb.lens.present, 10_000).catch(() => false);
    if (!lens) {
      console.log("pi-marimo e2e: no Lens mounted in this marimo; the mark part was skipped");
      return;
    }
    const label = await markCell(f, doubled, "why 14?");
    const selection = nb.lens.selections().find((s) => s.label === label);
    expect(selection).toMatchObject({ note: "why 14?", cells: [doubled.id] });
    await unmarkSelection(f, selection!.id);
    await until(() => !nb.lens.selections().some((s) => s.id === selection!.id));
  } finally {
    await watcher.stop();
  }
}, 120_000);

// Explicitly approved disposable-fixture exception: never edit an existing notebook.
const SAVE_NOTEBOOK = `import marimo

app = marimo.App()


@app.cell
def _():
    save_probe = 1
    save_probe
    return (save_probe,)


if __name__ == "__main__":
    app.run()
`;

test.skipIf(!live)("save API: save-only, canonical source, explicit run, and stale-source conflict", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-marimo-save-")));
  const file = join(dir, "save-fixture.py");
  writeFileSync(file, SAVE_NOTEBOOK);
  const server = await servers.start({ command: ["marimo"], file, cwd: dir, timeoutMs: 60_000 });
  const sessionId = await headless.attach(server.url, file);
  const watcher = new MarimoWatcher({ io: nodeIo(), cwd: dir, pollMs: 300, onChange: () => undefined });
  watcher.start();
  let editor: EditCellService | undefined;
  try {
    const followed = await until(() => watcher.followed().find((f) => f.attachment.path === file && f.connection === "connected" && f.notebook.ready));
    expect(followed.attachment.sessionId).toBe(sessionId);
    const nb = followed.notebook;
    const target = followed.attachment;
    const initialRun = await runScratch(target, `import marimo._code_mode as cm
async with cm.get_context() as ctx:
    for cell_id in ${JSON.stringify(nb.order)}:
        ctx.run_cell(cell_id)
`, undefined, () => {});
    expect(initialRun.success).toBe(true);
    const cell = await until(() => nb.ordered().find((c) => c.code.includes("save_probe =") && scalarResult(c.output) === "1" && c.status === "idle"), 30_000, () => nb.ordered());
    const original = cell.code;

    // Read the code-mode document, not just the service's local state.
    const inspect = async () => {
      const events: ScratchEvent[] = [];
      const result = await runScratch(target, `import json
import marimo._code_mode as cm
async with cm.get_context() as ctx:
    print("save-fixture:" + json.dumps({"code": ctx.cells[${JSON.stringify(cell.id)}].code}))
`, undefined, (event) => events.push(event));
      if (!result.success) throw new Error(events.filter((event) => event.stream === "stderr").map((event) => event.text).reverse().join("\n") || JSON.stringify(result));
      const line = events.find((event) => event.stream === "stdout" && event.text.startsWith("save-fixture:"));
      expect(line).toBeDefined();
      return JSON.parse(line!.text.slice("save-fixture:".length)) as { code: string };
    };
    editor = new EditCellService({
      target,
      notebook: nb,
      isCurrent: () => watcher.followed().some((f) => f.notebook === nb && f.attachment.path === file && f.attachment.sessionId === sessionId && f.connection === "connected"),
      reconcile: async () => {
        const canonical = await inspect();
        const current = nb.cells.get(cell.id);
        if (current) current.code = canonical.code;
      },
      timeoutMs: 30_000,
    });

    expect((await inspect()).code).toBe(original);
    const receipt = await editor.saveCell(cell.id, "save_probe = 2\nsave_probe\n", original);
    expect(receipt.requestId).toEqual(expect.any(String));
    expect(receipt.canonicalCode.trim()).toBe("save_probe = 2\nsave_probe");
    expect(cell.code).toBe(receipt.canonicalCode);
    expect((await inspect()).code).toBe(receipt.canonicalCode);
    expect(scalarResult(cell.output)).toBe("1");

    await editor.runSavedCell(cell.id, receipt.canonicalCode);
    await until(() => scalarResult(cell.output) === "2" && cell.status === "idle", 30_000, () => cell);
    expect((await inspect()).code).toBe(receipt.canonicalCode);

    await expect(editor.saveCell(cell.id, "save_probe = 999\nsave_probe", original)).rejects.toThrow(/changed elsewhere/i);
    expect((await inspect()).code).toBe(receipt.canonicalCode);
    expect(cell.code).toBe(receipt.canonicalCode);
    expect(scalarResult(cell.output)).toBe("2");
  } finally {
    editor?.dispose();
    await watcher.stop();
  }
}, 120_000);
