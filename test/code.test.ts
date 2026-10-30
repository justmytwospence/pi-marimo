import { describe, expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { codeRows, expandTabs, scrollCode } from "../src/ui/code.js";
import { diffLines } from "../src/ui/rows.js";

describe("code viewport", () => {
  it("keeps every logical line including trailing blanks", () => {
    const source = Array.from({ length: 10001 }, (_, i) => `line ${i}`).join("\n") + "\n\n";
    const rows = codeRows(source, { width: 80 });
    expect(rows).toHaveLength(10004);
    expect(rows.at(-1)?.sourceLine).toBe(10002);
    expect(rows.at(-3)?.text).toBe("line 10000");
  });
  it("reaches long tails, clamps after resize/edit and leaves arrows in headers", () => {
    const state = { offset: 2001 };
    let rows = codeRows("x".repeat(2001) + "TAIL", { width: 4, state });
    expect(rows[1]?.text).toBe("TAIL");
    expect(rows[0]?.text).toContain("▾");
    rows = codeRows("abc", { width: 80, state });
    expect(state.offset).toBe(0);
    expect(rows[1]?.text).toBe("abc");
    scrollCode(state, -8, 10); expect(state.offset).toBe(0);
    scrollCode(state, 80, 10); expect(state.offset).toBe(10);
  });
  it("expands tabs only for display, including consecutive and leading tabs", () => {
    expect(expandTabs("\t\tx\t", 4)).toBe("        x   ");
    expect(expandTabs("界\tx", 4)).toBe("界  x");
    expect(expandTabs("é\tx", 4)).toBe("é   x");
    const rows = codeRows("\x1b[31ma\tb\x1b[0m", { width: 4 });
    expect(stripTerminalSequences(rows[1]!.text)).toBe("a   ");
    expect(visibleWidth(rows[1]!.text)).toBe(4);
  });
  it("sizes numbers from total lines and fold expands completely", () => {
    const source = Array(101).fill("x").join("\n");
    expect(codeRows(source, { lineNumbers: true })[1]?.text).toBe("  1 x");
    expect(codeRows(source, { folded: true })).toHaveLength(4);
    expect(codeRows(source, { folded: false })).toHaveLength(102);
  });
  it("does not truncate changed diff lines and shares the viewport", () => {
    const after = "x".repeat(2100) + "TAIL";
    expect(diffLines("before", after).join("\n")).toContain("TAIL");
    expect(diffLines("before", after, { width: 8, offset: 2100 }).every(line => visibleWidth(line) <= 8)).toBe(true);
  });
});
