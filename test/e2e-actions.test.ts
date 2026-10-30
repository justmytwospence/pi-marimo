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
import { callFunction, fileText } from "../src/core/table-rpc.js";
import { MarimoWatcher } from "../src/core/watcher.js";
import { OwnServers } from "../src/servers.js";
import { runCells, setUiValues } from "../src/ui/interrupt.js";
import { markCell, unmarkSelection } from "../src/ui/lens-mark.js";
import { runScratch, type ScratchEvent } from "../src/ui/scratch.js";
import { notebookKey } from "../src/ui/identity.js";
import { NotebookView } from "../src/ui/view.js";

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

// Only this generated fixture is driven by the keyboard test, never a discovered user notebook.
const KEYBOARD_NOTEBOOK = `import marimo

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
def _(mo):
    enabled = mo.ui.checkbox(value=False, label="enabled")
    enabled
    return (enabled,)


@app.cell
def _(n, enabled):
    keyboard_result = n.value * 2 + int(enabled.value)
    keyboard_result
    return (keyboard_result,)


@app.cell
def _(mo):
    cities = mo.ui.table(
        [{"city": "Oslo", "population": 11}, {"city": "Rome", "population": 22}],
        selection="multi", label="Cities",
    )
    cities
    return (cities,)


@app.cell
def _(cities):
    selection_count = len(cities.value)
    selection_count
    return (selection_count,)


if __name__ == "__main__":
    app.run()
`;

test.skipIf(!live)("keyboard controls update kernel values; table cursor, full value, copy and selection agree", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-marimo-keyboard-")));
  const file = join(dir, "keyboard.py");
  writeFileSync(file, KEYBOARD_NOTEBOOK);
  const server = await servers.start({ command: ["marimo"], file, cwd: dir, timeoutMs: 60_000 });
  const sessionId = await headless.attach(server.url, file);
  const watcher = new MarimoWatcher({ io: nodeIo(), cwd: dir, pollMs: 300, onChange: () => undefined });
  watcher.start();
  let view: NotebookView | undefined;
  try {
    const f = await until(() => watcher.followed().find(o => o.attachment.path === file && o.connection === "connected" && o.notebook.ready));
    expect(f.attachment.sessionId).toBe(sessionId);
    const nb = f.notebook;
    await runCells(f.attachment, nb.ordered().map(c => ({ id: c.id, code: c.code })));
    const result = await until(() => nb.ordered().find(c => c.code.includes("keyboard_result =") && scalarResult(c.output) === "6"));
    const count = await until(() => nb.ordered().find(c => c.code.includes("selection_count =") && scalarResult(c.output) === "0"));
    const slider = await until(() => nb.ordered().find(c => c.code.includes("n = mo.ui.slider") && c.output?.widgets?.some(w => w.kind === "slider")));
    const checkbox = await until(() => nb.ordered().find(c => c.code.includes("enabled = mo.ui.checkbox") && c.output?.widgets?.some(w => w.kind === "checkbox")));
    const table = await until(() => nb.ordered().find(c => c.code.includes("cities = mo.ui.table") && c.output?.table?.objectId));
    const writes: string[] = [];
    const mutations: Promise<void>[] = [];
    const rpcCalls: Array<{ fn: string; args: unknown; result: Promise<unknown> }> = [];
    view = new NotebookView(
      { requestRender: () => {}, terminal: { rows: 32, write: (text: string) => writes.push(text) } } as ConstructorParameters<typeof NotebookView>[0],
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      notebookKey(f),
      {
        followed: () => [f], interrupt: async () => {}, openInBrowser: () => {},
        setWidget: (followed, cell, widget, value) => {
          followed.notebook.setUserValue(cell.id, widget.objectId, widget.label, value);
          mutations.push(setUiValues(followed.attachment, [widget.objectId], [value]));
        },
        table: {
          call: (followed, id, fn, args) => {
            const result = callFunction(followed, id, fn, args);
            rpcCalls.push({ fn, args, result });
            return result;
          },
          file: fileText,
        },
        setTableSelection: (followed, cell, id, value) => {
          followed.notebook.setUserValue(cell.id, id, "table selection", value);
          mutations.push(setUiValues(followed.attachment, [id], [value]));
        },
      },
      () => {},
    );
    const screen = () => view!.render(120).join("\n");
    const press = (key: string) => { view!.handleInput(key); screen(); };
    // Move the notebook cursor using keys, rather than injecting a private view state.
    const goTo = (id: string) => {
      press("g");
      for (let i = 0; i < nb.order.indexOf(id); i++) press("j");
      expect(view!.snapshot().cursor).toBe(id);
    };
    screen();
    goTo(slider.id);
    press("\r"); // Enter on a control cell enters widget mode, not source editing.
    expect(view.snapshot().widget).toMatchObject({ cell: slider.id, index: 0 });
    press("l");
    await Promise.all(mutations);
    await until(() => scalarResult(result.output) === "8", 30_000, () => result);
    press("\r"); // Type a slider value through the real dock editor.
    press("\x7f");
    press("7");
    press("\r");
    await Promise.all(mutations);
    await until(() => scalarResult(result.output) === "14", 30_000, () => result);
    press("\t");
    expect(view.snapshot().widget).toMatchObject({ cell: checkbox.id, index: 0 });
    press(" ");
    await Promise.all(mutations);
    await until(() => scalarResult(result.output) === "15", 30_000, () => result);
    press("\x1b[Z");
    expect(view.snapshot().widget).toMatchObject({ cell: slider.id, index: 0 });
    press("\x1b");
    expect(view.snapshot().widget).toBeUndefined();

    goTo(table.id);
    press("t");
    expect(view.snapshot().table).toMatchObject({ cell: table.id, objectId: table.output!.table!.objectId });
    press("l"); // population column
    press("s"); // A real server-side sort, not fixture-supplied rows.
    await until(() => rpcCalls.some(call => call.fn === "search"));
    await Promise.all(rpcCalls.map(call => call.result));
    expect(rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ fn: "search", args: expect.objectContaining({ sort: [{ by: "population", descending: false }] }) }),
    ]));
    expect(screen()).toContain("Rome");
    press("j"); // Rome, population 22
    expect(scalarResult(count.output)).toBe("0");
    expect(mutations).toHaveLength(3); // Cursor movement and sorting never select rows.
    const tableState = view.snapshot().table;
    press("v");
    expect(view.snapshot().message?.text).toBe("22");
    press("\x1b");
    expect(view.snapshot().message).toBeUndefined();
    expect(view.snapshot().table).toEqual(tableState);
    press("y");
    expect(writes.at(-1)).toBe(`\x1b]52;c;${Buffer.from("22").toString("base64")}\x07`);
    press(" ");
    await Promise.all(mutations);
    await until(() => scalarResult(count.output) === "1", 30_000, () => count);
    const events: ScratchEvent[] = [];
    const selected = await runScratch(f.attachment, 'print(cities.value == [{"city": "Rome", "population": 22}])', undefined, event => events.push(event));
    expect(selected.success).toBe(true);
    expect(events).toContainEqual({ stream: "stdout", text: "True" });
    press(" ");
    await Promise.all(mutations);
    await until(() => scalarResult(count.output) === "0", 30_000, () => count);
    press("\x1b");
    expect(view.snapshot().table).toBeUndefined();
  } finally {
    view?.dispose();
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
