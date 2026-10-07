import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { insertState } from "../src/index.js";
import { headingsFromCode, isMarkdownCell, mdLiterals } from "../src/core/markdown.js";
import { NotebookState } from "../src/core/notebook.js";
import { snapshot, statusParts, statusText } from "../src/core/render.js";
import { SseParser } from "../src/core/sse.js";
import { normalize, within } from "../src/core/io.js";

const attachment = { url: "http://127.0.0.1:2799", sessionId: "s1", path: "/tmp/pmt/nb.py" };

function replay(file: string, until?: (op: string, data: any) => boolean): NotebookState {
  const nb = new NotebookState();
  const parser = new SseParser();
  for (const event of parser.push(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"))) {
    const message = JSON.parse(event.data);
    nb.apply(message.op, message.data);
    if (until?.(message.op, message.data)) break;
  }
  return nb;
}

describe("markdown", () => {
  test("headings come from mo.md literals, not comments or fences", () => {
    const code = [
      "# a python comment",
      'mo.md(r"""',
      "    # Data loading",
      "    Some *text*.",
      "    ```python",
      "    # not a heading",
      "    ```",
      "    ## **Model** fit ##",
      '    """)',
    ].join("\n");
    expect(headingsFromCode(code)).toEqual([{ level: 1, text: "Data loading" }, { level: 2, text: "Model fit" }]);
  });

  test("single-quoted and f-string literals", () => {
    expect(headingsFromCode('mo.md(f"## Results for {name}")')).toEqual([{ level: 2, text: "Results for {name}" }]);
    expect(mdLiterals("x = mo.md('### A \\'quoted\\' title')")).toEqual(["### A 'quoted' title"]);
  });

  test("markdown cells", () => {
    expect(isMarkdownCell('mo.md("""\n# Title\n""")')).toBe(true);
    expect(isMarkdownCell('mo.md("# Title")\nx = 1')).toBe(false);
  });
});

describe("notebook state from a recorded stream", () => {
  test("tracks the running cell and its section", () => {
    // Stop while lEQa (under "## Slow model fit") is running.
    const nb = replay("kiosk-run.sse", (op, data) => op === "cell-op" && data.cell_id === "lEQa" && data.status === "running");
    const run = nb.running();
    expect(run?.cell.id).toBe("lEQa");
    expect(run?.section).toEqual(["Data loading", "Slow model fit"]);
    expect(nb.queued()).toBe(1);
  });

  test("after the run: errors, defs, idle", () => {
    const nb = replay("kiosk-run.sse");
    expect(nb.running()).toBeUndefined();
    expect(nb.errors().map((c) => [c.id, c.error])).toEqual([["PKri", "ZeroDivisionError: division by zero"]]);
    expect(nb.defs.get("lEQa")).toEqual(["y"]);
    expect(nb.sectionPath("vblA")).toEqual(["Data loading"]);
  });

  test("document transactions: browser edits, creates, reorders", () => {
    const nb = replay("kiosk-run.sse");
    nb.apply("notebook-document-transaction", {
      transaction: {
        source: "frontend",
        changes: [
          { type: "set-code", cellId: "vblA", code: "time.sleep(1)\nx = 2" },
          { type: "create-cell", cellId: "new1", code: 'mo.md("## Plots")', name: "", config: { disabled: false }, after: "lEQa" },
        ],
      },
    });
    expect(nb.order).toEqual(["Hbol", "MJUe", "vblA", "bkHC", "lEQa", "new1", "PKri"]);
    expect(nb.edited(nb.cells.get("vblA")!)).toBe(true);
    expect(nb.sectionPath("PKri")).toEqual(["Data loading", "Plots"]);
    const text = snapshot(nb, attachment, { seenSeq: 0 });
    expect(text).toContain("vblA: defines x -- edited, not rerun; changed by the user in the browser");
    expect(snapshot(nb, attachment, { seenSeq: nb.seq })).not.toContain("changed by the user");
  });
});

describe("render", () => {
  test("status line while running", () => {
    const nb = replay("kiosk-run.sse", (op, data) => op === "cell-op" && data.cell_id === "lEQa" && data.status === "running");
    const since = nb.running()!.since!;
    expect(statusText(statusParts(nb, attachment, "connected", since + 12_400))).toBe(
      "marimo: nb.py · running Data loading › Slow model fit (12s) · 1 queued",
    );
    expect(statusText(statusParts(nb, attachment, "disconnected"))).toBe("marimo: nb.py · disconnected");
    expect(statusText(statusParts(nb, attachment, "connected", since + 1000, 2))).toBe(
      "marimo: nb.py · running Data loading › Slow model fit (1s) · 1 queued · +2 open",
    );
  });

  test("snapshot outline", () => {
    const text = snapshot(replay("kiosk-run.sse"), attachment);
    expect(text).toContain("# Data loading  [MJUe]");
    expect(text).toContain("## Slow model fit  [bkHC]");
    expect(text).toContain("  PKri: defines z -- ERROR ZeroDivisionError: division by zero");
    expect(text).toContain("Kernel: 1 cell with errors.");
  });

  test("a long queue is counted, not listed", () => {
    const nb = new NotebookState();
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    nb.apply("kernel-ready", { cell_ids: ids, codes: ids.map((id) => `${id} = 1`), names: [], configs: [] });
    for (const id of ids.slice(1)) nb.apply("cell-op", { cell_id: id, status: "queued", timestamp: 1 });
    nb.apply("cell-op", { cell_id: "c0", status: "running", timestamp: 1 });
    const text = snapshot(nb, attachment, { maxCells: 10, now: 2000 });
    expect(text).toContain("Kernel: running c0, 19 queued.");
    expect(text).not.toContain("-- queued");
    expect(text).toContain("  c0: c0 = 1 -- RUNNING 1s\n  … 19 more cells");
  });

  test("stale on most cells is said once", () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: ["a", "b", "c"], codes: ["a = 1", "b = a", "c = b"], names: [], configs: [] });
    for (const id of ["a", "b"]) nb.apply("cell-op", { cell_id: id, stale_inputs: true });
    const text = snapshot(nb, attachment);
    expect(text).toContain("Kernel: 2 of 3 cells stale (inputs changed, not rerun).");
    expect(text).not.toContain("-- stale");
  });

  test("large notebooks fold quiet cells", () => {
    const nb = new NotebookState();
    const ids = Array.from({ length: 80 }, (_, i) => `c${i}`);
    nb.apply("kernel-ready", { cell_ids: ids, codes: ids.map((id, i) => (i % 20 === 0 ? `mo.md("# Part ${i / 20}")` : `${id} = ${i}`)), names: [], configs: [] });
    nb.apply("cell-op", { cell_id: "c45", status: "running", timestamp: 1 });
    const text = snapshot(nb, attachment, { maxCells: 40, now: 3000 });
    expect(text).toContain("# Part 2  [c40]\n  … 4 more cells\n  c45: c45 = 45 -- RUNNING 2s\n  … 14 more cells\n# Part 3");
  });
});

describe("turn state placement", () => {
  test("after the turn's prompt, at the same place on every request of the turn", () => {
    const block = { role: "custom", timestamp: 0 };
    const prompt = { role: "user", timestamp: 5 };
    const first = insertState([{ role: "user", timestamp: 1 }, { role: "assistant" }, prompt], block, undefined);
    expect(first.messages.indexOf(block)).toBe(3);
    expect(first.anchor).toBe(5);
    // Later in the turn: tool results and a steering message follow; the block stays put.
    const later = insertState([{ role: "user", timestamp: 1 }, { role: "assistant" }, prompt, { role: "assistant" }, { role: "toolResult" }, { role: "user", timestamp: 9 }], block, first.anchor);
    expect(later.messages.indexOf(block)).toBe(3);
  });
});

test("paths", () => {
  expect(within("/a/b/c.py", "/a")).toBe(true);
  expect(within("/a/b/c.py", "/a/")).toBe(true);
  expect(within("/ab/c.py", "/a")).toBe(false);
  expect(normalize("../x/./y.py", "/a/b")).toBe("/a/x/y.py");
});
