import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { TableData } from "../src/core/output.js";
import { parseFilter } from "../src/ui/table-session.js";
import { columnCard, layoutTable, measureColumn, rowCard, tableGrid, tableLines, tableViewport, type TableRender } from "../src/ui/table.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/gu, "");

const data = (extra: Partial<TableData> = {}): TableData => ({
  columns: ["name", "n", "ok"],
  numeric: [false, true, false],
  rows: [],
  records: [
    { name: "alpha", n: 709000, ok: true, _marimo_row_id: "r0" },
    { name: "b", n: 2, ok: false, _marimo_row_id: "r1" },
    { name: "c", n: null, ok: true, _marimo_row_id: "r2" },
  ],
  fieldTypes: { name: { kind: "string", dtype: "object" }, n: { kind: "integer", dtype: "int64" }, ok: { kind: "boolean", dtype: "bool" } },
  totalRows: 30,
  pageSize: 3,
  ...extra,
});
const view = (extra: Partial<TableRender> = {}): TableRender => ({ focused: false, colOffset: 0, selected: new Set(), sort: [], rowIdOf: (i) => `r${i}`, firstRow: 0, ...extra });

test("a borderless grid has styled headers, types and body; values are formatted by kind", () => {
  const lines = tableLines(data(), 60, theme, 10, view());
  expect(lines[0]).toContain("name");
  expect(lines[1]).toContain("int64");
  expect(lines[2]).toContain("alpha");
  expect(lines.join("\n")).not.toMatch(/[│┃─┼]/u);
  const text = lines.join("\n");
  expect(text).toContain("709,000");
  expect(text).toContain("✓");
  expect(text).toContain("✗");
  expect(text).toMatch(/\x1b\[3m\s*NULL/u);
  expect(lines.at(-1)).toBe("rows 1–3 of 30 · page 1 of 10 · cols 1–3 of 3");
  for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
});

test("frozen row headers stay while the window scrolls, with ◂ and ▸", () => {
  const columns = Array.from({ length: 8 }, (_, i) => `column_${i}`);
  const record = Object.fromEntries([["Index0", 0], ...columns.map((c) => [c, `${c}-value`])]);
  const t: TableData = { columns, numeric: columns.map(() => false), rows: [], records: [record], rowHeaders: ["Index0"], totalRows: 1 };
  const first = tableLines(t, 50, theme, 5, view({ colOffset: 0 })).join("\n");
  expect(first).toContain("▸");
  expect(first).not.toContain("◂");
  const scrolled = tableLines(t, 50, theme, 5, view({ colOffset: 2 })).join("\n");
  expect(scrolled).toContain("Index0");
  expect(scrolled).toContain("◂");
  expect(scrolled).not.toContain("column_0");
  expect(scrolled).toMatch(/cols \d+–\d+ of 8/u);
});

test("sort marks: ↓ for one sort, with priorities for two", () => {
  expect(tableLines(data(), 60, theme, 5, view({ sort: [{ by: "n", descending: true }] }))[0]).toContain("n ↓");
  const two = tableLines(data(), 60, theme, 5, view({ sort: [{ by: "n", descending: true }, { by: "name", descending: false }] }))[0]!;
  expect(two).toContain("↓1");
  expect(two).toContain("↑2");
});

test("the cursor cell is inverse; the selection column shows ☑ for a selected row id", () => {
  const lines = tableLines(data({ selection: "multi" }), 60, theme, 5, view({ focused: true, cursorRow: 0, cursorCol: 1, selected: new Set(["r1"]) }));
  expect(lines.join("\n")).toContain("\x1b[7m");
  const body = lines.map(plain);
  expect(body.find((l) => l.includes("alpha"))).toMatch(/▸☐1/u);
  expect(body.find((l) => /\bb\b/u.test(l))).toMatch(/☑2/u);
});

test("summaries add a sparkline row for a numeric column", () => {
  const summaries = { stats: { n: { min: 2, max: 90 } }, bins: { n: [1, 5, 9, 2].map((count, i) => ({ bin_start: i, bin_end: i + 1, count })) }, counts: {} };
  const lines = tableLines(data(), 60, theme, 5, view({ summaries }));
  expect(lines.join("\n")).toMatch(/[▁▂▃▄▅▆▇█]{3}/u);
  expect(lines.join("\n")).toContain("2–90");
});

test("cell styles colour a cell", () => {
  const t = data({ cellStyles: { r0: { n: { color: "#ff0000", fontWeight: "bold" } } } });
  expect(tableLines(t, 60, theme, 5, view()).join("\n")).toContain("\x1b[38;2;255;0;0m");
});

test("the row card lists every column, the hidden ones too; the column card its stats", () => {
  const t = data({ hidden: ["secret"], records: [{ name: "alpha", n: 1, ok: true, secret: "x", _marimo_row_id: "r0" }] });
  const card = rowCard(t, 0, 50, theme, 4);
  expect(card[0]).toBe("row 5");
  expect(card.join("\n")).toContain("secret");
  expect(card.join("\n")).toContain("alpha");
  const col = columnCard(t, "n", { stats: { n: { min: 1, max: 5, nulls: 0 } }, bins: {}, counts: {} }, [["a", 4], ["b", 2]], 40, theme);
  expect(col[0]).toBe("n · int64");
  expect(col.join("\n")).toContain("top values");
});

test("parseFilter reads the filter syntax", () => {
  expect(parseFilter("n", "integer", "> 5")).toMatchObject({ operator: ">", value: 5, negate: false });
  expect(parseFilter("n", "integer", "1..10")).toMatchObject({ operator: "between", value: { min: 1, max: 10 } });
  expect(parseFilter("name", "string", "in a, b")).toMatchObject({ operator: "in", value: ["a", "b"] });
  expect(parseFilter("name", "string", "null")).toMatchObject({ operator: "is_null" });
  expect(parseFilter("name", "string", "!latte")).toMatchObject({ operator: "contains", value: "latte", negate: true });
  expect(parseFilter("name", "string", "> x")).toEqual({ error: "> needs a number or date column" });
  expect(parseFilter("n", "integer", "> x")).toEqual({ error: "not a number: x" });
});


test("layout is terminal-column accurate, including gutter, wide and combining characters", () => {
  const t = data({ columns: ["界", "é", "n"], numeric: [false, false, true], records: [{ "界": "東京", "é": "café", n: 12 }], fieldTypes: undefined });
  const v = view({ columnWidths: new Map([["界", 8], ["é", 6], ["n", 4]]) });
  const grid = tableGrid(t, 40, theme, 10, v);
  expect(grid.layout).toEqual(layoutTable(t, 40, v));
  expect(grid.layout.columns.map(c => [c.start, c.end, c.width])).toEqual([[4, 12, 8], [14, 20, 6], [22, 26, 4]]);
  const header = plain(grid.lines[0]!);
  for (const c of grid.layout.columns) {
    const prefix = header.slice(0, header.indexOf(c.column));
    expect(visibleWidth(prefix)).toBe(c.start + (c.column === "n" ? 3 : 0));
    expect(c.end - c.start).toBe(c.width);
  }
  expect(grid.rowAt.filter(r => r !== undefined)).toEqual([0]);
});

test("width overrides precede notebook widths and measured defaults", () => {
  const t = data({ widths: { name: 80 }, freezeLeft: ["name"], freezeRight: ["ok"] });
  expect(layoutTable(t, 100).columns[0]).toMatchObject({ column: "name", width: 10, frozen: "left" });
  const layout = layoutTable(t, 24, view({ columnWidths: new Map([["name", 8], ["n", 4], ["ok", 4]]) }));
  expect(layout.columns.map(c => c.column)).toEqual(["name", "n", "ok"]);
  expect(layout.columns.at(-1)).toMatchObject({ frozen: "right" });
  expect(layout.columns.at(-1)!.end).toBeLessThanOrEqual(24);
});

test("viewport pins headers and footer and moves whole wrapped rows to reveal the cursor", () => {
  const t = data({ columns: ["name"], numeric: [false], fieldTypes: undefined, wrapped: ["name"], records: Array.from({ length: 10 }, (_, i) => ({ name: `row ${i} long text here` })), totalRows: undefined });
  const v = view({ focused: true, cursorRow: 7, cursorCol: 0, columnWidths: new Map([["name", 8]]) });
  const grid = tableViewport(t, 38, 10, theme, v, 0);
  expect(grid.lines).toHaveLength(10);
  expect(grid.lines[0]).toContain("name");
  expect(grid.rowOffset).toBeGreaterThan(0);
  expect(grid.rowAt.filter(r => r === 7)).toHaveLength(3);
  expect(grid.lines.slice(-grid.footerRows).join(" ")).toContain("total unknown");
  expect(grid.lines.join("")).not.toContain("%");
  expect(grid.rowAt[0]).toBeUndefined();
  expect(grid.lines.join("")).toContain("█");
  const resized = tableViewport(t, 38, 12, theme, v, 999);
  expect(resized.rowOffset).toBeLessThanOrEqual(7);
  expect(resized.rowAt).toContain(7);
});

test("header, stripe, notebook style, active cell and selection have independent styling", () => {
  const styledTheme = { ...theme, bg: (color: string, text: string) => `\x1b[${color === "selectedBg" ? "44" : "45"}m${text}\x1b[49m` };
  const grid = tableGrid(data({ selection: "multi-cell", cellStyles: { r1: { n: { backgroundColor: "#112233" } } } }), 70, styledTheme, 10,
    view({ focused: true, cursorRow: 1, cursorCol: 0, selectedCells: new Set(["r1\0n"]), filterColumns: new Set(["n"]), selectedCount: 1 }));
  expect(grid.lines[0]).toContain("\x1b[44m");
  expect(plain(grid.lines[0]!)).toContain("n ƒ");
  const row = grid.lines[grid.rowAt.indexOf(1)]!;
  expect(row).toContain("\x1b[45m");
  expect(row).toContain("\x1b[48;2;17;34;51m");
  expect(row).toContain("\x1b[7m");
  expect(row).toContain("\x1b[4m");
  expect(grid.lines.join("")).toContain("1 selected");
});

test("empty, loading, error and unknown totals remain honest and within dimensions", () => {
  const t = data({ records: [], totalRows: undefined });
  const grid = tableGrid(t, 60, theme, 10, view({ loading: true, error: "offline", query: "alpha", filterColumns: ["name"] }));
  expect(grid.lines.join("\n")).toContain("total unknown");
  expect(grid.lines.join("\n")).toContain("error: offline");
  expect(grid.lines.join("\n")).toContain("search: alpha");
  for (const width of [0, 1, 4, 12, 40, 80]) for (const height of [0, 1, 2, 4, 12]) {
    const result = tableViewport(data(), width, height, theme, view({ focused: true, cursorRow: 2, cursorCol: 1 }), 99);
    expect(result.lines.length).toBeLessThanOrEqual(height);
    expect(result.rowAt.length).toBe(result.lines.length);
    result.lines.forEach(line => expect(visibleWidth(line)).toBeLessThanOrEqual(width));
    if (height) expect(result.rowAt).toContain(2);
  }
});

test("wrapping is capped explicitly and missing hidden record values are unavailable", () => {
  const t = data({ columns: ["name"], numeric: [false], records: [{ name: "a very long wrapped value with many words" }], fieldTypes: undefined, wrapped: ["name"], hidden: ["secret"] });
  const grid = tableGrid(t, 30, theme, 10, view({ columnWidths: new Map([["name", 4]]) }));
  expect(grid.rowAt.filter(r => r === 0)).toHaveLength(3);
  expect(grid.lines[grid.rowAt.lastIndexOf(0)]).toContain("…");
  expect(rowCard(t, 0, 50, theme, 0).join(" ")).toContain("unavailable");
});


test("viewport reveals the active column and retains frozen context when it fits", () => {
  const columns = ["left", "a", "b", "c", "right"];
  const t = data({ columns, fieldTypes: undefined, numeric: [], records: [Object.fromEntries(columns.map(c => [c, c]))], freezeLeft: ["left"], freezeRight: ["right"] });
  const v = view({ focused: true, cursorRow: 0, cursorCol: 3, columnWidths: new Map(columns.map(c => [c, 6])) });
  const grid = tableViewport(t, 28, 8, theme, v, 0);
  expect(grid.layout.columns.map(c => c.column)).toEqual(["left", "c", "right"]);
  expect(grid.lines.join("")).toContain("\x1b[7m");
  const narrow = tableViewport(t, 6, 2, theme, { ...v, cursorCol: 0 }, 0);
  expect(narrow.layout.columns.map(c => c.column)).toEqual(["left"]);
});

const producerControls = [
  ["CSI", "\x1b[2J\x1b[999C"],
  ["SGR", "\x1b[31m\x1b[0m"],
  ["OSC 8", "\x1b]8;;https://evil.invalid/hidden\x1b\\\x1b]8;;\x1b\\"],
  ["OSC 52", "\x1b]52;c;hidden\x07"],
  ["DCS", "\x1bPhidden\n\t\x85payload\x1b\\"],
  ["C1 CSI", "\x9b2J\x9b31m"],
  ["C1 OSC", "\x9d52;c;hidden\x9c"],
  ["C1 DCS", "\x90hidden\n\t\x85payload\x9c"],
  ["C1 APC/PM/SOS", "\x9fhidden\x9c\x9ehidden\x9c\x98hidden\x9c"],
  ["controls", "\x00\x07\x08\x7f\x80\x85"],
];

const safetyTheme = {
  fg: (_: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  bg: (_: string, text: string) => `\x1b[44m${text}\x1b[49m`,
};

test.each(producerControls)("table producer %s is inert before measurement, wrapping and styling", (_, control) => {
  const fixture = (control: string) => {
    const text = (s: string) => `${s}${control}界é`;
    const column = text("column");
    const summaries = { stats: { [column]: { unique: text("unique"), min: text("min"), max: text("max") } }, bins: {}, counts: { [column]: [{ value: text("top"), count: 2 }] } };
    const t = data({
      columns: [column], numeric: [false], records: [{ [column]: text("value"), _marimo_row_id: "raw\x1b[31m" }],
      fieldTypes: { [column]: { kind: "string", dtype: text("dtype") } },
      wrapped: [column], label: text("label"), banner: text("banner"),
      cellStyles: { "raw\x1b[31m": { [column]: { color: "#123456" } } },
    });
    const v = view({ focused: true, cursorRow: 0, cursorCol: 0, summaries, query: text("query"), error: text("error"), status: text("status"),
      sort: [{ by: column, descending: false }], filterColumns: [column], selected: new Set(["raw\x1b[31m"]), rowIdOf: () => "raw\x1b[31m" });
    return { t, v, column, summaries };
  };
  const dirty = fixture(control!);
  const safe = fixture("");
  const snapshot = structuredClone({ t: dirty.t, v: { ...dirty.v, rowIdOf: undefined } });
  expect(measureColumn(dirty.t, dirty.column, dirty.v.sort)).toBe(measureColumn(safe.t, safe.column, safe.v.sort));
  for (const width of [12, 40, 120]) {
    const layout = layoutTable(dirty.t, width, dirty.v);
    expect(layout.columns.map(({ start, end, width }) => ({ start, end, width }))).toEqual(layoutTable(safe.t, width, safe.v).columns.map(({ start, end, width }) => ({ start, end, width })));
    expect(layout.columns[0]?.column).toBe(dirty.column);
    expect(tableLines(dirty.t, width, safetyTheme, 10, dirty.v)).toEqual(tableLines(safe.t, width, safetyTheme, 10, safe.v));
    expect(tableGrid(dirty.t, width, safetyTheme, 10, dirty.v).lines).toEqual(tableGrid(safe.t, width, safetyTheme, 10, safe.v).lines);
    expect(tableViewport(dirty.t, width, 20, safetyTheme, dirty.v, 0).lines).toEqual(tableViewport(safe.t, width, 20, safetyTheme, safe.v, 0).lines);
    expect(rowCard(dirty.t, 0, width, safetyTheme, 0)).toEqual(rowCard(safe.t, 0, width, safetyTheme, 0));
    expect(columnCard(dirty.t, dirty.column, dirty.summaries, [[`top${control}界é`, 2]], width, safetyTheme)).toEqual(columnCard(safe.t, safe.column, safe.summaries, [["top界é", 2]], width, safetyTheme));
  }
  expect(tableLines(dirty.t, 120, safetyTheme, 10, dirty.v).join("")).toContain("\x1b[38;2;18;52;86m");
  const fallback = (t: TableData, value: string) => ({ ...t, records: undefined, rows: [[value]] });
  expect(tableLines(fallback(dirty.t, `value${control}界é`), 80, safetyTheme, 10)).toEqual(tableLines(fallback(safe.t, "value界é"), 80, safetyTheme, 10));
  const numeric = (t: TableData, column: string): TableData => ({ ...t, fieldTypes: { [column]: { kind: "number", dtype: "number" } } });
  expect(tableLines(numeric(dirty.t, dirty.column), 120, safetyTheme, 10, dirty.v)).toEqual(tableLines(numeric(safe.t, safe.column), 120, safetyTheme, 10, safe.v));
  // rowIdOf is a function, so compare its identity separately from cloned serializable data.
  expect(dirty.t).toEqual(snapshot.t);
  expect({ ...dirty.v, rowIdOf: undefined }).toEqual({ ...snapshot.v, rowIdOf: undefined });
});

test("identical displayed column labels retain distinct raw lookups, widths and selection", () => {
  const a = "name\x1b[31m";
  const b = "name\x9b0m";
  const id = "row\x1b[31m";
  const t = data({ columns: [a, b], numeric: [], fieldTypes: undefined, selection: "multi-cell",
    records: [{ [a]: "first", [b]: "second", _marimo_row_id: id }],
    cellStyles: { [id]: { [b]: { color: "#123456" } } } });
  const v = view({ focused: true, cursorCol: 1, rowIdOf: () => id, selectedCells: new Set([`${id}\0${b}`]),
    columnWidths: new Map([[a, 7], [b, 9]]), sort: [{ by: b, descending: true }], filterColumns: [b] });
  const grid = tableGrid(t, 60, theme, 10, v);
  expect(grid.layout.columns.map(c => [c.column, c.width])).toEqual([[a, 7], [b, 9]]);
  expect(plain(grid.lines[0]!)).toContain("name ↓ ƒ");
  const body = grid.lines[grid.rowAt.indexOf(0)]!;
  expect(body).toContain("first");
  expect(body).toContain("second");
  expect(body).toContain("\x1b[38;2;18;52;86m");
  expect(body).toContain("\x1b[7m\x1b[4m");
  expect(rowCard(t, 0, 60, theme, 0).join(" ")).toContain("second");
  expect(Object.keys(t.records![0]!)).toEqual([a, b, "_marimo_row_id"]);
  expect(v.sort[0]!.by).toBe(b);
  expect(v.selectedCells!.has(`${id}\0${b}`)).toBe(true);
});

test("explicit backgrounds win over striping", () => {
  const themed = { ...theme, bg: (_: string, text: string) => `\x1b[45m${text}\x1b[49m` };
  const t = data({ columns: ["name"], numeric: [], fieldTypes: undefined, cellStyles: { r1: { name: { backgroundColor: "#123456" } } } });
  const grid = tableGrid(t, 40, themed, 10, view());
  const line = grid.lines[grid.rowAt.indexOf(1)]!;
  expect(line).toContain("\x1b[48;2;18;52;86m");
  expect(line).not.toContain("\x1b[45m");
});
