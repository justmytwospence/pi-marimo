import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { moveStateBreakpoint } from "../src/index.js";
import { headingsFromCode, isMarkdownCell, mdLiterals } from "../src/core/markdown.js";
import { NotebookState } from "../src/core/notebook.js";
import { snapshot, statusParts, statusText } from "../src/core/render.js";
import { SseParser } from "../src/core/sse.js";
import { within } from "../src/core/watcher.js";

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
  });

  test("snapshot outline", () => {
    const text = snapshot(replay("kiosk-run.sse"), attachment);
    expect(text).toContain("# Data loading  [MJUe]");
    expect(text).toContain("## Slow model fit  [bkHC]");
    expect(text).toContain("  PKri: defines z -- ERROR ZeroDivisionError: division by zero");
    expect(text).toContain("Kernel: 1 cell with errors.");
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

describe("prompt cache breakpoint", () => {
  test("moves Pi's last-message mark to the block before the state block", () => {
    const payload = {
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
        { role: "user", content: [{ type: "text", text: "<marimo_notebook_state path=...>", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      ],
    };
    const out = moveStateBreakpoint(structuredClone(payload)) as typeof payload;
    expect((out.messages[2].content[0] as any).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect((out.messages[3].content[0] as any).cache_control).toBeUndefined();
    expect(JSON.stringify(out).match(/cache_control/g)).toHaveLength(2);
    expect(moveStateBreakpoint({ messages: [{ role: "user", content: "no state" }] })).toBeUndefined();
  });
});

test("within", () => {
  expect(within("/a/b/c.py", "/a")).toBe(true);
  expect(within("/ab/c.py", "/a")).toBe(false);
});
