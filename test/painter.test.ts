import { expect, test, vi } from "vitest";
import { Painter, marker } from "../src/ui/painter.js";
import { row as notebookRow } from "../src/ui/notebook-frame.js";
import { getCapabilities, getCellDimensions, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { NotebookState } from "../src/core/notebook.js";
import { outputRows } from "../src/ui/outputs.js";
import type { LiveCharts } from "../src/ui/live-charts.js";

function fakeTui(screen: string[]) {
  const writes: string[] = [];
  const tui = {
    screen,
    getScreenLines() { return [...this.screen]; },
    doRender() {},
    terminal: { rows: screen.length, write: (d: string) => { writes.push(d); } },
  };
  return { tui, writes };
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
const placements = (w: string) => [...w.matchAll(/a=p,i=(\d+)/gu)].map((m) => Number(m[1]));
const deletes = (w: string) => [...w.matchAll(/a=d,d=i,i=(\d+)/gu)].map((m) => Number(m[1]));
const uploads = (w: string) => [...w.matchAll(/a=t,f=100,q=2,i=(\d+)/gu)].map((m) => Number(m[1]));

test("empty-bar output images and live charts use the full body width and local content origin", () => {
  const caps = getCapabilities(); const dimensions = getCellDimensions();
  const { tui, writes } = fakeTui(Array.from({ length: 30 }, () => ""));
  const p = Painter.for(tui)!;
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  const nb = new NotebookState(); nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["pass"], names: ["_"] });
  const cell = nb.cells.get("a")!;
  const opts = { width: 46, pad: "", bar: "", imageRows: 100 };
  const limits = { textLines: 10, tableRows: 1 };
  try {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    setCellDimensions({ widthPx: 9, heightPx: 18 });
    cell.output = { kind: "image", text: "image", image: { mime: "image/png", data: PNG } };
    const rows = outputRows(cell, theme, opts, limits);
    expect(rows[0]!.text.startsWith("\x1b_G")).toBe(true);
    expect(rows[0]!.text).toMatch(/[,;]c=46[,;]/u);
    expect(rows[0]!.image).toMatchObject({ index: 0, height: rows.length, alt: "[image png: scroll until it fits on screen]" });
    expect(rows.slice(1).every(row => row.text === "")).toBe(true);
    tui.screen[1] = notebookRow(rows[0]!.text, 48, theme);
    expect(tui.screen[1]!.startsWith(" \x1b_G")).toBe(true);
    const state = vi.fn((_output, _figure, geometry) => {
      const slot = p.add(geometry); p.present(slot, PNG);
      return { status: "ready", geometry, slot };
    });
    const live = { state, lines: (ready: { slot: number; geometry: { rows: number } }) => p.lines(ready.slot, ready.geometry.rows) } as unknown as LiveCharts;
    cell.output = { kind: "chart", text: "chart", plotly: "{}" };
    const chart = outputRows(cell, theme, { ...opts, live }, limits);
    expect(state.mock.calls[0]![2].cols).toBe(46);
    expect(chart[0]!.image).toMatchObject({ index: 0, height: chart.length, alt: "[chart: scroll until it fits on screen]", live: { output: cell.output, geometry: state.mock.calls[0]![2] } });
    expect(chart.slice(1).every(row => row.text === "")).toBe(true);
    tui.screen[1] = notebookRow(chart[0]!.text, 48, theme);
    writes.length = 0; tui.doRender();
    expect(writes.join("")).toContain("\x1b[2;2H");
    expect(outputRows(cell, theme, opts, limits)[0]!.text).toBe("static image (live charts are off)");
    const prefixed = outputRows(cell, theme, { ...opts, pad: "\x1b[31m界\x1b[0m", bar: "界", live }, limits);
    expect(state.mock.calls[1]![2].cols).toBe(41);
    expect(prefixed[0]!.text.startsWith("\x1b[31m界\x1b[0m界 ")).toBe(true);
  } finally { p.retire(); setCapabilities(caps); setCellDimensions(dimensions); }
});

test("notebook-local image placement shares the one-column content origin", () => {
  const { tui, writes } = fakeTui(["", "", "", ""]);
  const p = Painter.for(tui)!;
  const slot = p.add({ cols: 8, rows: 2 });
  p.present(slot, PNG);
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  tui.screen[1] = notebookRow(marker(slot), 46, theme);
  tui.doRender();
  expect(writes.at(-1)).toContain("\x1b[2;2H");
  p.retire();
});

test("the chart's rows are text to the renderer; after a render the painter places the frame where the marker is", () => {
  const { tui, writes } = fakeTui(["", "", "", "", "", ""]);
  const p = Painter.for(tui)!;
  const slot = p.add({ cols: 10, rows: 3 });
  const lines = p.lines(slot, 3);
  expect(lines).toEqual([marker(slot), "", ""]);
  expect(lines.join("")).not.toContain("\x1b_G");
  p.present(slot, PNG);
  expect(uploads(writes.join(""))).toHaveLength(1);
  expect(placements(writes.join(""))).toHaveLength(0);
  tui.screen[2] = `│ ▍ ${marker(slot)}`;
  tui.doRender();
  const placed = writes.at(-1)!;
  expect(placed).toContain("\x1b[3;5H");
  expect(placements(placed)).toHaveLength(1);
  // Nothing moved: the next render writes nothing.
  writes.length = 0;
  tui.doRender();
  expect(writes).toEqual([]);
});

test("a new frame goes to the other image, placed on top, and the old placement is removed only afterwards", () => {
  vi.useFakeTimers();
  try {
    const { tui, writes } = fakeTui(["", "", ""]);
    const p = Painter.for(tui)!;
    const slot = p.add({ cols: 10, rows: 2 });
    p.present(slot, PNG);
    tui.screen[0] = marker(slot);
    tui.doRender();
    const first = placements(writes.join(""))[0]!;
    writes.length = 0;
    p.present(slot, PNG.replace("AAAA", "BBBB"));
    const swap = writes.join("");
    const second = uploads(swap)[0]!;
    expect(second).not.toBe(first);
    expect(placements(swap)).toEqual([second]);
    expect(deletes(swap)).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(deletes(writes.join(""))).toEqual([first]);
    // The renderer's own image clears are noticed: the frame is placed again (and uploaded again when the data went).
    writes.length = 0;
    tui.terminal.write("\x1b_Ga=d,d=A,q=2\x1b\\");
    tui.doRender();
    expect(uploads(writes.join(""))).toEqual([second]);
    expect(placements(writes.join(""))).toEqual([second]);
  } finally { vi.useRealTimers(); }
});

test("scrolled partly off the bottom the placement is cropped; with the marker gone it is removed", () => {
  const { tui, writes } = fakeTui(["", "", "", ""]);
  const p = Painter.for(tui)!;
  const slot = p.add({ cols: 10, rows: 4 });
  p.present(slot, PNG);
  tui.screen[2] = marker(slot);
  tui.doRender();
  expect(writes.at(-1)).toMatch(/r=2,x=0,y=0,w=10,h=5,/u);
  tui.screen[2] = "";
  tui.doRender();
  expect(deletes(writes.at(-1)!)).toHaveLength(1);
});

test("a transcript chart under an overlay is taken away and comes back when the overlay closes; a chart inside the overlay stays", () => {
  const { tui, writes } = fakeTui(["", "", "", ""]);
  (tui as any).renderedOverlayLayouts = [];
  const p = Painter.for(tui)!;
  const base = p.add({ cols: 10, rows: 2 });
  const inView = p.add({ cols: 10, rows: 2 }, "overlay");
  p.present(base, PNG);
  p.present(inView, PNG);
  tui.screen[0] = marker(base);
  tui.screen[2] = marker(inView);
  tui.doRender();
  expect(placements(writes.join(""))).toHaveLength(2);
  writes.length = 0;
  (tui as any).renderedOverlayLayouts = [{ row: 0, col: 0, width: 80, height: 4 }];
  tui.doRender();
  expect(deletes(writes.join(""))).toHaveLength(1);
  expect(placements(writes.join(""))).toHaveLength(0);
  writes.length = 0;
  (tui as any).renderedOverlayLayouts = [];
  tui.doRender();
  expect(placements(writes.join(""))).toHaveLength(1);
});

test("while a full-screen view is open, images Pi places in the transcript are taken away after each render, the view's own stay", () => {
  const { tui, writes } = fakeTui(["", ""]);
  const p = Painter.for(tui)!;
  // Opening wipes at once, before the view draws anything.
  p.setExclusive(true);
  expect(writes.join("")).toContain("a=d,d=a");
  writes.length = 0;
  tui.doRender();
  expect(writes).toEqual([]);
  // A transcript image: its placements go after the render.
  tui.terminal.write("\x1b_Ga=T,f=100,i=5;AAAA\x1b\\");
  tui.doRender();
  expect(deletes(writes.at(-1)!)).toEqual([5]);
  expect(writes.join("")).not.toContain("a=d,d=a");
  // The view's own image (and its re-placement) stays; a transcript one in the same write still goes.
  p.setViewImages([7]);
  writes.length = 0;
  tui.terminal.write("\x1b_Ga=T,f=100,q=2,C=1,c=60,r=13,i=7,m=1;AAAA\x1b\\\x1b_Gm=0;BB\x1b\\");
  tui.terminal.write("\x1b_Ga=p,q=2,i=7\x1b\\");
  tui.doRender();
  expect(writes.slice(2)).toEqual([]);
  tui.terminal.write("\x1b_Ga=p,q=2,i=7\x1b\\\x1b_Ga=p,q=2,i=5\x1b\\");
  tui.doRender();
  expect(deletes(writes.at(-1)!)).toEqual([5]);
  // An image without an id cannot be told apart: everything goes.
  tui.terminal.write("\x1b_Ga=T,f=100;AAAA\x1b\\");
  tui.doRender();
  expect(writes.at(-1)).toContain("a=d,d=a");
  p.setExclusive(false);
  writes.length = 0;
  tui.terminal.write("\x1b_Ga=T,f=100,i=5;AAAA\x1b\\");
  tui.doRender();
  expect(writes).toEqual(["\x1b_Ga=T,f=100,i=5;AAAA\x1b\\"]);
});

test("a reload's painter retires the earlier one: its charts go and it stops drawing", () => {
  const { tui, writes } = fakeTui(["", ""]);
  const first = Painter.for(tui)!;
  const slot = first.add({ cols: 10, rows: 2 });
  first.present(slot, PNG);
  tui.screen[0] = marker(slot);
  tui.doRender();
  // A fresh copy of the module would make its own class; retiring is how it hands over.
  first.retire();
  expect(writes.at(-1)).toMatch(/a=d,d=I/u);
  writes.length = 0;
  tui.doRender();
  expect(writes).toEqual([]);
  const second = Painter.for(tui)!;
  expect(second).not.toBe(first);
  expect(Painter.for(tui)).toBe(second);
});

test("an image Pi drew is placed again when Pi rewrites a row it covers (the chat beside a docked notebook)", () => {
  const { tui, writes } = fakeTui(["chat │ ▍ \x1b_Ga=T,f=100,q=2,C=1,c=60,r=3,i=42;AAAA\x1b\\", "chat │ ▍", "chat │ ▍", "chat"]);
  Painter.for(tui);
  // Pi rewrites the row under the image only.
  tui.terminal.write("\x1b[2;1H\x1b[2Kchat more │ ▍");
  writes.length = 0;
  tui.doRender();
  expect(writes.join("")).toContain("\x1b[1;10H\x1b_Ga=p,i=42,p=7,c=60,r=3,C=1,q=2");
  // A frame that touches no covered row places nothing.
  writes.length = 0;
  tui.terminal.write("\x1b[4;1H\x1b[2Kchat");
  tui.doRender();
  expect(writes).toEqual(["\x1b[4;1H\x1b[2Kchat"]);
});

test("a chart's marker is still found when the line is restyled around it (the docked notebook dimmed while the chat has focus)", async () => {
  const { faintColumns } = await import("../src/ui/split-layout.js");
  const { tui, writes } = fakeTui(["", "", ""]);
  const p = Painter.for(tui)!;
  const slot = p.add({ cols: 10, rows: 2 });
  p.present(slot, PNG);
  tui.screen[1] = faintColumns(`chat │ ▍ ${marker(slot)}`, 5, 40);
  tui.doRender();
  expect(writes.at(-1)).toContain("\x1b[2;10H");
  expect(placements(writes.at(-1)!)).toHaveLength(1);
});
