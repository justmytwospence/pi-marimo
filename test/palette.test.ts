import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { Palette } from "../src/ui/palette.js";
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
  p.input("\x1b[112;5:2u"); // Held Ctrl+P repeat
  expect(p.state.query).toBe("xqzunlikely");
  expect(p.input("\x10")).toEqual({ kind: "cancel" });
  expect(p.input("\x1b")).toEqual({ kind: "cancel" });
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
    expect(p.selectAt(-1, 2)).toBeUndefined();
    expect(p.selectAt(width, 2)).toBeUndefined();
    expect(p.selectAt(1, height - 1)).toBeUndefined();
    if (height >= 12) expect(p.selectAt(1, 2)?.id).toBe(p.matches()[p.state.scroll]?.id);
  }
  type(p, "no-matches-unique");
  expect(p.render(width, 12, theme).join("\n")).toContain("No matching commands".slice(0, width));
  expect(p.selectAt(1, 2)).toBeUndefined();
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
