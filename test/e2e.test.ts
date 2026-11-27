// Opt-in against a real marimo server: PI_MARIMO_LIVE_TEST=1 and `marimo` on PATH.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { liveMarimoFixture, marimoEnabled } from "./live-marimo.js";

const NOTEBOOK = `import marimo

app = marimo.App()


@app.cell
def _():
    import marimo as mo
    import time
    return mo, time


@app.cell
def _(mo):
    mo.md("""
    # Loading
    """)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Slow step
    """)
    return


@app.cell
def _(time):
    time.sleep(3)
    y = 1
    return (y,)


if __name__ == "__main__":
    app.run()
`;

async function until<T>(check: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.skipIf(!marimoEnabled())("follows the notebooks open under the cwd, the most recently used one current", async () => {
  const fixture = liveMarimoFixture();
  const { dir } = fixture;
  const runAll = (sessionId: string) => fixture.runPair(sessionId, "import marimo._code_mode as cm\nasync with cm.get_context() as ctx:\n    for c in ctx.cells:\n        ctx.run_cell(c.id)\n");
  const file = join(dir, "nb.py");
  const other = join(dir, "other.py");
  const hidden = join(dir, ".worktrees", "branch", "nb.py");
  writeFileSync(file, NOTEBOOK);
  writeFileSync(other, NOTEBOOK.replace("## Slow step", "## Other step"));
  mkdirSync(join(dir, ".worktrees", "branch"), { recursive: true });
  writeFileSync(hidden, NOTEBOOK);
  const url = await fixture.start(dir);
  await Promise.all([
    fixture.openBrowser(file, "browser1"),
    fixture.openBrowser(other, "browser2"),
    fixture.openBrowser(hidden, "browser3"),
  ]);

  let changes = 0;
  const watcher = fixture.watch(() => changes++);
  await Promise.all([fixture.follow(file, "browser1"), fixture.follow(other, "browser2")]);
  // The checkout under a hidden directory is left out.
  expect([watcher.attachment!.path, ...watcher.others().map((o) => o.path)].sort()).toEqual([file, other]);
  expect(watcher.notebook.order).toHaveLength(4);

  const [running] = await Promise.all([
    until(() => {
      const r = watcher.notebook.running();
      return r?.section.length === 2 ? r : undefined;
    }),
    runAll("browser1"),
  ]);
  expect(watcher.attachment?.path).toBe(file);
  expect(running.section).toEqual(["Loading", "Slow step"]);
  await until(() => watcher.notebook.defs.get(running.cell.id)?.includes("y") && !watcher.notebook.running());
  expect(changes).toBeGreaterThan(3);

  // Running the other notebook makes it current.
  await Promise.all([
    until(() => watcher.attachment?.path === other && watcher.notebook.running()?.section.join() === "Loading,Other step"),
    runAll("browser2"),
  ]);
  await until(() => !watcher.notebook.running());

  // An edit typed in the browser reaches us (marimo does not echo it to the
  // browser's own id), and makes its notebook current again.
  expect(watcher.seesBrowserEdits).toBe(true);
  const html = await (await fetch(`${url}/?file=${encodeURIComponent(file)}`, { signal: fixture.signal })).text();
  const serverToken = /marimo-server-token data-token="([^"]+)"/.exec(html)?.[1];
  if (!serverToken) throw new Error("fixture page has no server token");
  const edit = await fetch(`${url}/api/document/transaction`, {
    method: "POST",
    signal: fixture.signal,
    headers: { "Content-Type": "application/json", "Marimo-Session-Id": "browser1", "Marimo-Server-Token": serverToken },
    body: JSON.stringify({ changes: [{ type: "set-code", cellId: running.cell.id, code: "time.sleep(3)\ny = 2" }] }),
  });
  expect(edit.ok).toBe(true);
  const cell = await until(() => watcher.attachment?.path === file && watcher.notebook.cells.get(running.cell.id)?.editedBy === "frontend" && watcher.notebook.cells.get(running.cell.id));
  expect(watcher.notebook.edited(cell)).toBe(true);

  // This session's agent working in other.py keeps it current, even while the user runs nb.py.
  expect(watcher.touch([{ url: url.replace("127.0.0.1", "localhost"), file: "other.py" }])).toBe(true);
  expect(watcher.attachment?.path).toBe(other);
  await Promise.all([
    until(() => watcher.followed().find((f) => f.attachment.path === file)?.notebook.running()),
    runAll("browser1"),
  ]);
  expect(watcher.attachment?.path).toBe(other);
  await until(() => !watcher.followed().some((f) => f.notebook.running()));
  // By session id too; a target matching nothing changes nothing.
  expect(watcher.touch([{ url, session: "browser1" }])).toBe(true);
  expect(watcher.attachment?.path).toBe(file);
  expect(watcher.touch([{ url, file: "missing.py" }])).toBe(false);

  // Pinning follows exactly the pinned notebooks, the hidden one included.
  watcher.setMode({ kind: "pinned", paths: [other, hidden] });
  const paths = () => watcher.followed().map((f) => f.attachment.path).sort().join();
  await until(() => paths() === [hidden, other].sort().join() && watcher.followed().every((f) => f.connection === "connected"));
}, 120_000);
