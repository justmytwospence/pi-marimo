import { describe, expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { codePanelRows, codeRows, expandTabs, scrollCode } from "../src/ui/code.js";
import { diffLines } from "../src/ui/rows.js";
import { CellConsole } from "../src/core/console.js";

describe("source panels", () => {
  const theme = {
    fg: (_: string, text: string) => `\x1b[37m${text}\x1b[39m`,
    bold: (text: string) => text,
    bg: (_: string, text: string) => `\x1b[48;2;12;34;56m${text}\x1b[49m`,
  };
  it.each([0, 1, 2, 3, 4, 5, 8, 20, 80])("pads every header, blank and body row to %i columns", width => {
    const rows = codePanelRows("\t界é\n\n  tail\n", { width, theme, blockId: "panel", lineNumbers: true });
    expect(rows.every(row => visibleWidth(row.text) === width)).toBe(true);
    expect(rows.every(row => row.blockId === "panel" && row.code)).toBe(true);
    expect(rows.filter(row => row.sourceLine !== undefined).map(row => row.sourceLine)).toEqual([0, 1, 2, 3]);
    expect(stripTerminalSequences(rows[1]!.text)).toBe(" ".repeat(width));
    expect(stripTerminalSequences(rows.at(-1)!.text)).toBe(" ".repeat(width));
  });
  it("uses a plain padded rectangle without a background function or theme", () => {
    for (const options of [{}, { theme: { fg: (_: string, s: string) => s, bold: (s: string) => s } }]) {
      const rows = codePanelRows("  x\n", { ...options, width: 12 });
      expect(rows.map(row => row.text)).toEqual(["  ▾ text    ", "            ", "    x       ", "            ", "            "]);
    }
    expect(codePanelRows("x").every(row => visibleWidth(row.text) === 80)).toBe(true);
  });
  it("omits only the header when disabled and keeps every line, inset and independent viewport", () => {
    const offsets = new Map([["pre", { offset: 2004 }]]);
    const rows = codePanelRows("x".repeat(2004) + "TAIL\n", { width: 8, blockId: "pre", header: false, codeOffsets: offsets });
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.sourceLine)).toEqual([undefined, 0, 1, undefined]);
    expect(rows[1]!.text).toBe("  TAIL  ");
    expect(rows.every(row => !row.text.includes("▾"))).toBe(true);
    expect(codePanelRows("x", { width: 0, header: false }).every(row => row.text === "")).toBe(true);
    expect(codePanelRows("x", { width: -1 }).every(row => row.text === "")).toBe(true);
  });
  it("retains leading whitespace, tab stops and wide/combining characters", () => {
    const rows = codePanelRows("\t界é\tx\n  end", { width: 20, tabstop: 4, header: false });
    expect(rows[1]!.text).toBe("      界é x         ");
    expect(rows[2]!.text).toBe("    end             ");
  });
  it("paints every actual terminal cell after nested ANSI foreground/background resets", async () => {
    const rows = codePanelRows("  \x1b[31mred\x1b[0m normal\x1b[49m tail\n\n界é\tZ\x1b[m end\x1b[0;39;49m!", { width: 36, theme, language: "python" });
    for (const row of rows) {
      const terminal = new CellConsole();
      try {
        await terminal.append({ data: row.text, channel: "stdout", mimetype: "text/plain" });
        const line = terminal.snapshot()[0]!;
        expect(visibleWidth(row.text)).toBe(36);
        expect(line.styles?.reduce((count, span) => count + span.width, 0)).toBe(36);
        expect(line.styles?.every(span => !span.bgDefault && span.bg === 0x0c2238)).toBe(true);
      } finally { terminal.dispose(); }
    }
  });
});

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
