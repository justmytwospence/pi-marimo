import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { stableKey } from "../src/activity.ts";
import { NotebookState } from "../src/core/notebook.ts";
import { NotebookSource } from "../src/ui/source.ts";
import type { Followed } from "../src/core/watcher.ts";

// Standalone consumers need no suite checkout. An explicitly supplied checkout is
// required to be complete: missing imports/files fail rather than silently skip.
const root = process.env.PI_PLUGINS_DIR;
describe.skipIf(!root)("explicit Pi Plugins integration", () => {
  const suitePath = (...parts: string[]) => resolve(root!, ...parts);
  it("keeps the notebook activity protocol identical to every suite copy", () => {
    const local = readFileSync(new URL("../src/activity.ts", import.meta.url), "utf8");
    for (const name of ["pi-bg", "pi-subagents", "pi-herdr", "pi-plan-mode"]) {
      expect(readFileSync(suitePath("packages", name, "src/activity.ts"), "utf8")).toBe(local);
    }
  });
  it("keeps pill implementations identical apart from their known header sentence", () => {
    const local = readFileSync(new URL("../src/pill.ts", import.meta.url), "utf8");
    const suite = readFileSync(suitePath("packages/pi-bg/src/pill.ts"), "utf8");
    // Only the sentence naming the other checkout differs, not arbitrary comments.
    const localHeader = "// pi-bg (in Pi Plugins, packages/pi-bg/src/pill.ts) keeps an identical copy; change it in both.";
    const suiteHeader = "// pi-marimo (its own repository, justmytwospence/pi-marimo) keeps an identical copy as src/pill.ts; change it in both.";
    expect(local).toContain(localHeader);
    expect(suite).toContain(suiteHeader);
    expect(local.replace(localHeader, "")).toBe(suite.replace(suiteHeader, ""));
  });
  it("feeds a real notebook producer to TasksDialog and targets the selected server", async () => {
    const { TasksDialog } = await import(pathToFileURL(suitePath("packages/pi-bg/src/dialog.ts")).href);
    const notebook = new NotebookState();
    notebook.apply("kernel-ready", { cell_ids: ["cell"], codes: ["x = 1"], names: ["_"] });
    notebook.apply("cell-op", { cell_id: "cell", status: "running" });
    const followed = { attachment: { path: "/w/nb.py", url: "http://fixture.invalid", sessionId: "s" }, notebook, connection: "connected", current: true } as Followed;
    const other = { ...followed, attachment: { ...followed.attachment, url: "http://other.invalid" } };
    const interrupt = vi.fn(async () => {}); const open = vi.fn(async () => {});
    const nb = new NotebookSource({ followed: () => [followed, other], interrupt, open, changed: () => {}, hostedChanged: () => {} });
    nb.update([followed, other], 100);
    const otherKey = nb.section.entries(100)[1]!.key;
    let result: any;
    const tui = { requestRender: () => {}, terminal: { rows: 27 } };
    const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
    const dialog = new TasksDialog(tui, theme, { sections: () => [nb.section], ownId: "bg", canFollow: false, initialKey: stableKey("marimo", otherKey) }, (picked: unknown) => { result = picked; });
    try {
      dialog.handleInput("x"); dialog.handleInput("x"); await Promise.resolve();
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(other);
      dialog.handleInput("\r"); expect(result.section).toBe(nb.section);
      await result.section.open(result.key, {});
      expect(open).toHaveBeenCalledExactlyOnceWith(otherKey, {});
    } finally { dialog.dispose(); }
  });
});
