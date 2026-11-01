import { CURSOR_MARKER, renderFakeCursor, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { compositePalette, Palette, paletteBounds } from "../src/ui/palette.js";
import { paletteCommands } from "../src/ui/keys.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const type = (palette: Palette, text: string) => { for (const c of text) palette.input(c); };

test("fuzzy matching searches labels, category, description and shortcuts; empty query preserves registry order", () => {
  const p = new Palette("notebook");
  expect(p.matches().map(c => c.id)).toEqual(paletteCommands("notebook").map(c => c.id));
  type(p, "run all");
  expect(p.matches()[0]?.id).toBe("run-all");
  p.state.query = "";
  type(p, "Ctrl+P");
  expect(p.matches()).toEqual([]); // The palette cannot select itself.
  p.state.query = "";
  type(p, "Fuzzy-find");
  expect(p.matches()).toEqual([]);
  p.state.query = "";
  type(p, "kernel interrupt");
  expect(p.matches().map(c => c.id)).toContain("interrupt");
  p.state.query = "";
  type(p, "environment install");
  expect(p.matches()).toEqual([]); // Unavailable package actions aren't suggested in notebook mode.
  const packages = new Palette("packages");
  type(packages, "environment install");
  expect(packages.matches().map(c => c.id)).toContain("pkg-add");
});

test("query editing, no-match Enter, Unicode deletion and cancel cannot execute anything", () => {
  const p = new Palette("notebook");
  type(p, "xqzunlikely");
  expect(p.matches()).toHaveLength(0);
  expect(p.input("\r")).toBeUndefined();
  p.input("完");
  expect(p.state.query).toBe("xqzunlikely完");
  p.input("\x7f");
  expect(p.state.query).toBe("xqzunlikely");
  p.input("\x1b[112;5:3u"); // Kitty Ctrl+P release
  expect(p.state.query).toBe("xqzunlikely");
  p.input("\x1b[112;5:2u"); // Held Ctrl+P repeat cannot execute or change the query.
  expect(p.state.query).toBe("xqzunlikely");
  expect(p.input("\x10")).toBeUndefined();
  expect(p.input("\x1b")).toEqual({ kind: "cancel" });
});

test.each([
  { key: "n", raw: "\x0e", code: 110, delta: 1 },
  { key: "j", raw: "\x0a", code: 106, delta: 1 },
  { key: "p", raw: "\x10", code: 112, delta: -1 },
  { key: "k", raw: "\x0b", code: 107, delta: -1 },
])("Ctrl+$key navigates without executing or editing the query across terminal protocols", ({ raw, code, delta }) => {
  const p = new Palette("notebook");
  type(p, "run");
  p.render(76, 12, theme);
  for (const data of [raw, `\x1b[${code};5u`, `\x1b[27;5;${code}~`, `\x1b[${code};5:2u`]) {
    p.state.selected = 1;
    expect(p.input(data)).toBeUndefined();
    expect(p.state.selected).toBe(1 + delta);
    expect(p.state.query).toBe("run");
  }
  expect(p.input(`\x1b[${code};5:3u`)).toBeUndefined();
  expect(p.state.selected).toBe(1 + delta); // Key release never moves twice.
  p.state.selected = delta > 0 ? p.matches().length - 1 : 0;
  const edge = p.state.selected;
  p.input(raw);
  expect(p.state.selected).toBe(edge);
  p.state.query = "no-matches-unique";
  expect(p.input(raw)).toBeUndefined();
  expect(p.state.selected).toBe(0);
  expect(p.state.scroll).toBe(0);
});

test("arrows and Tab navigate results while j/k remain search text; paging and resize clamp selection", () => {
  const p = new Palette("notebook");
  p.render(90, 12, theme);
  p.input("\x1b[B");
  expect(p.state.selected).toBe(1);
  p.input("\t");
  expect(p.state.selected).toBe(2);
  p.input("\x1b[A");
  expect(p.state.selected).toBe(1);
  p.input("\x1b[Z");
  expect(p.state.selected).toBe(0);
  p.input("\x1b[6~");
  expect(p.state.selected).toBeGreaterThan(1);
  expect(p.state.scroll).toBeGreaterThan(0);
  p.input("\x1b[5~");
  expect(p.state.selected).toBe(0);
  p.input("j");
  expect(p.state.query).toBe("j");
  expect(p.state.selected).toBe(0);
  p.input("k");
  expect(p.state.query).toBe("jk");
  p.state.query = "";
  p.state.selected = 1000;
  p.state.scroll = 1000;
  p.render(46, 4, theme);
  expect(p.state.selected).toBeLessThan(p.matches().length);
  p.state.query = "no-matches-unique";
  p.render(46, 12, theme);
  expect(p.state.selected).toBe(0);
  expect(p.state.scroll).toBe(0);
});

test.each([24, 46, 90, 180])("rendering and hit testing stay within %i columns across viewport sizes", width => {
  const p = new Palette("notebook");
  for (const height of [3, 12, 90]) {
    const lines = p.render(width, height, theme);
    expect(lines).toHaveLength(height);
    for (const row of lines) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    expect(p.selectAt(1, 0)).toBeUndefined();
    expect(p.selectAt(-1, 1)).toBeUndefined();
    expect(p.selectAt(width, 1)).toBeUndefined();
    expect(p.selectAt(1, height - 1)).toBeUndefined();
    if (height >= 12) expect(p.selectAt(2, 3)?.id).toBe(p.matches()[p.state.scroll]?.id);
  }
  type(p, "no-matches-unique");
  expect(p.render(width, 12, theme).join("\n")).toContain("No matching commands".slice(0, width));
  expect(p.selectAt(2, 3)).toBeUndefined();
  expect(p.render(0, 12, theme)).toEqual([]);
});

test("palette state can be restored without retaining styled output or sharing mutable state", () => {
  const p = new Palette("packages");
  type(p, "upgrade");
  const saved = { ...p.state };
  const restored = new Palette("packages", saved);
  expect(restored.state).toEqual(saved);
  restored.input("\x7f");
  expect(p.state).toEqual(saved);
  expect(restored.render(90, 12, theme).join("\n")).toContain("Command palette");
});

test.each([
  [180, 60, { left: 52, top: 14, width: 76, height: 16 }],
  [100, 28, { left: 12, top: 4, width: 76, height: 16 }],
  [46, 12, { left: 2, top: 1, width: 42, height: 10 }],
  [24, 7, { left: 2, top: 0, width: 20, height: 7 }],
  [8, 2, { left: 0, top: 0, width: 8, height: 2 }],
  [1, 1, { left: 0, top: 0, width: 1, height: 1 }],
  [0, 0, undefined],
] as const)("bounds for %i × %i", (width, height, expected) => {
  expect(paletteBounds(width, height)).toEqual(expected);
  if (expected) {
    expect(expected.left + expected.width).toBeLessThanOrEqual(width);
    expect(expected.top + expected.height).toBeLessThanOrEqual(height);
  }
  expect(paletteBounds(width, height)).toEqual(expected);
});

test("bounds sanitize nonfinite and fractional dimensions", () => {
  expect(paletteBounds(Infinity, 10)).toBeUndefined();
  expect(paletteBounds(10, NaN)).toBeUndefined();
  expect(paletteBounds(-1, 5)).toBeUndefined();
  expect(paletteBounds(8.9, 2.9)).toEqual({ left: 0, top: 0, width: 8, height: 2 });
});

test("normal hierarchy and stable height across filtering", () => {
  const p = new Palette("notebook");
  const initial = p.render(60, 12, theme);
  expect(initial[0]).toContain("Command palette");
  expect(initial[0]).toContain(`${p.matches().length} commands`);
  expect(initial[1]).toContain("> ");
  expect(initial[2]).toMatch(/^├─+┤$/u);
  expect(initial[3]).toContain("› ");
  expect(initial[9]).toContain(p.matches()[0].description.slice(0, 30));
  expect(initial[10]).toContain("Esc close");
  expect(initial[11]).toMatch(/^╰─+╯$/u);
  p.state.query = "run all";
  expect(p.render(60, 12, theme)).toHaveLength(12);
  p.state.query = "xqzunlikely";
  const empty = p.render(60, 12, theme);
  expect(empty).toHaveLength(12);
  expect(empty[3]).toContain("No matching commands");
  expect(empty[9]).toBe(`│ ${" ".repeat(56)} │`);
  expect(p.render(24, 7, theme)[0]).toContain("Command palette");
});

test("compact fallback reserves only available rows and resets hit geometry", () => {
  const p = new Palette("notebook");
  for (let height = 1; height <= 6; height++) {
    const rows = p.render(16, height, theme);
    expect(rows).toHaveLength(height);
    expect(rows[0]).toContain("> ");
    expect(rows.join("\n")).not.toContain("Command palette");
    if (height >= 2) expect(p.selectAt(0, 1)?.id).toBe(p.matches()[p.state.scroll]?.id);
    if (height >= 3) expect(p.selectAt(0, height - 1)).toBeUndefined();
    for (const row of rows) expect(visibleWidth(row)).toBe(16);
  }
  p.wheel(10);
  p.render(16, 2, theme);
  expect(p.state.scroll).toBe(p.state.selected);
  p.render(16, 1, theme);
  expect(p.selectAt(0, 1)).toBeUndefined();
  p.render(16, 4, theme);
  expect(p.selectAt(0, 1)?.id).toBe(p.matches()[p.state.scroll]?.id);
  expect(p.render(0, 4, theme)).toEqual([]);
  expect(p.selectAt(0, 1)).toBeUndefined();
  expect(p.render(4, 0, theme)).toEqual([]);
});

test("cursor and column clipping handle wide, combining and styled content", () => {
  const p = new Palette("notebook");
  p.input("界".repeat(300));
  expect(Array.from(p.state.query)).toHaveLength(256);
  for (const width of [1, 2, 8, 24, 34, 48, 76]) {
    for (const focused of [true, false]) {
      const rows = p.render(width, 9, theme, focused);
      expect(rows.every(row => visibleWidth(row) === width)).toBe(true);
      const all = rows.join("");
      expect(all.split(CURSOR_MARKER).length - 1).toBe(Number(focused));
      if (focused) expect(all).toContain(CURSOR_MARKER + renderFakeCursor(" "));
      else expect(all).not.toContain(renderFakeCursor(" "));
    }
  }
  p.state.query = "\x1b[31m界e\u0301界\x1b[0m";
  const rows = p.render(24, 7, theme);
  expect(rows.every(row => visibleWidth(row) === 24)).toBe(true);
  expect(rows[1]).toContain(CURSOR_MARKER + renderFakeCursor(" "));
});

test("only result interiors are clickable, including scrolled first and last results", () => {
  const p = new Palette("notebook");
  p.render(48, 10, theme);
  p.wheel(8);
  p.render(48, 10, theme);
  const start = p.state.scroll;
  for (const [x, y] of [[0, 3], [1, 3], [46, 3], [47, 3], [2, 0], [2, 1], [2, 2], [2, 7], [2, 8], [2, 9], [2, 10]]) {
    expect(p.selectAt(x, y)).toBeUndefined();
  }
  expect(p.selectAt(2, 3)?.id).toBe(p.matches()[start]?.id);
  expect(p.selectAt(45, 6)?.id).toBe(p.matches()[start + 3]?.id);
});

test("composition clears card cells, preserves surrounding ANSI and OSC content, and strips background markers", () => {
  const link = "\x1b]8;;https://example.com\x07";
  const close = "\x1b]8;;\x07";
  const base = [`${CURSOR_MARKER}abcdefghij${CURSOR_MARKER}`, `\x1b[31mab界${link}cdefgh${close}\x1b[0m`, "untouched"];
  const copy = [...base];
  const result = compositePalette(base, ["XY"], { left: 3, top: 0, width: 4, height: 2 }, 10);
  expect(base).toEqual(copy);
  expect(result).not.toBe(base);
  expect(result.join("")).not.toContain(CURSOR_MARKER);
  expect(sliceByColumn(result[0], 0, 10, true).replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/gu, "")).toBe("abcXY  hij");
  expect(visibleWidth(result[1])).toBe(10);
  expect(sliceByColumn(result[1], 3, 4, true).replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/gu, "").trim()).toBe("");
  expect(result[2]).toBe("untouched");
  const short = compositePalette([], ["x"], { left: 1, top: 2, width: 2, height: 2 }, 5);
  expect(short).toHaveLength(4);
  expect(short.slice(0, 2)).toEqual(["", ""]);
  expect(visibleWidth(short[2])).toBe(5);
});

test("styled wide labels and long shortcuts fit, align right and omit metadata on narrow cards", () => {
  const p = new Palette("notebook");
  const command = { ...p.matches()[0], label: "\x1b[31m界e\u0301界界label\x1b[0m", group: "Execution", keys: ["ctrl+shift+alt+pageDown", "ctrl+pageUp"] };
  p.matches = () => [command];
  expect(p.render(76, 7, theme)[0]).toContain("1 command ");
  expect(p.render(76, 7, theme)[0]).not.toContain("1 commands");
  for (const width of [24, 34, 48, 76]) {
    const row = p.render(width, 7, theme)[3];
    expect(visibleWidth(row)).toBe(width);
    expect(row).toContain("界");
    if (width < 34) expect(row).not.toContain("Ctrl");
    else expect(row).toContain("Ctrl");
    if (width < 48) expect(row).not.toContain("Execution");
    else expect(row).toContain("Execution");
  }
  const row = p.render(76, 7, theme)[3];
  expect(row.indexOf("Ctrl")).toBeGreaterThan(row.indexOf("Execution"));
});
