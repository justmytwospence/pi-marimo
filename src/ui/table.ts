// A marimo table as a text grid for the notebook view: frozen, scrolled and hidden columns, data
// types, column summaries with sparklines, sort marks, selection marks, cell styles, justification,
// a cursor, and a footer that says which rows these are. It is drawn from a `TableData` (the page
// marimo sent, or the one the table's `search` function returned) and a `TableRender` (the view's
// cursor, sort and selection). Row and column cards show what a grid cell cannot.
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TableData } from "../core/output.js";
import type { ColumnSummaries } from "../core/table-rpc.js";
import type { PaneTheme } from "./outline.js";
import { clean, oneLine } from "./text.js";

// Strip control strings before folding whitespace (C1 controls can be whitespace too).
// Only producer labels/values cross this boundary; identifiers and rendered ANSI stay raw.
const display = (text: string): string => oneLine(clean(
  // pi-tui's stripper recognizes only some CSI final bytes; also remove movement/device CSI.
  text.replace(/(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/gu, ""),
));

export type Summaries = ColumnSummaries;

export interface TableRender {
  focused: boolean;
  cursorRow?: number;
  cursorCol?: number;
  colOffset: number;
  selected: ReadonlySet<string>;
  /** `${rowId}\0${column}` */
  selectedCells?: ReadonlySet<string>;
  sort: Array<{ by: string; descending: boolean }>;
  summaries?: Summaries;
  status?: string;
  columnWidths?: ReadonlyMap<string, number>;
  query?: string;
  filterColumns?: ReadonlySet<string> | readonly string[];
  selectedCount?: number;
  loading?: boolean;
  error?: string;
  rowIdOf(i: number): string;
  /** Absolute index of the first row shown. */
  firstRow: number;
  totalRows?: number | "many";
}

const MAX_COLUMN = 28;
const MAX_WRAPPED = 40;
const WRAP_LINES = 3;
const SEP = "  ";
const BLOCKS = "▁▂▃▄▅▆▇█";

const SGR = (on: string, off: string) => (text: string): string => `\x1b[${on}m${text}\x1b[${off}m`;
const inverse = SGR("7", "27");
const italic = SGR("3", "23");
const underline = SGR("4", "24");
const boldSgr = SGR("1", "22");

const fieldKind = (t: TableData, column: string): string => t.fieldTypes?.[column]?.kind ?? "";
const isNumber = (t: TableData, column: string): boolean => {
  const kind = fieldKind(t, column);
  if (kind) return kind === "integer" || kind === "number";
  return t.numeric[t.columns.indexOf(column)] === true;
};
const isTemporal = (kind: string): boolean => kind === "date" || kind === "datetime" || kind === "time";

/** The columns in the order they are drawn and moved through: frozen left, the scrolling ones, frozen right. */
export function columnGroups(t: TableData): { left: string[]; middle: string[]; right: string[] } {
  const left = (t.freezeLeft ?? []).filter((c) => t.columns.includes(c));
  const right = (t.freezeRight ?? []).filter((c) => t.columns.includes(c) && !left.includes(c));
  const middle = t.columns.filter((c) => !left.includes(c) && !right.includes(c));
  return { left, middle, right };
}

export function orderedColumns(t: TableData): string[] {
  const g = columnGroups(t);
  return [...g.left, ...g.middle, ...g.right];
}

/** One value as text, with how it should be styled. */
function format(value: unknown, kind: string): { text: string; style?: "null" | "yes" | "no" } {
  if (value === null || value === undefined) return { text: "NULL", style: "null" };
  if (typeof value === "boolean") return { text: value ? "✓" : "✗", style: value ? "yes" : "no" };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { text: String(value) };
    const whole = kind === "integer" || (kind !== "number" && Number.isInteger(value));
    return { text: whole ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 4 }) };
  }
  if (typeof value === "string") return { text: display(value) };
  return { text: display(JSON.stringify(value) ?? "") };
}

/** A column's value on row `i`: from the parsed records, else the text rows. */
function valueAt(t: TableData, i: number, column: string): { text: string; style?: "null" | "yes" | "no" } {
  if (t.records) {
    const record = t.records[i];
    return record && Object.hasOwn(record, column) ? format(record[column], fieldKind(t, column)) : { text: "unavailable" };
  }
  return { text: display(t.rows[i]?.[t.columns.indexOf(column)] ?? "") };
}

const rowCount = (t: TableData): number => t.records?.length ?? t.rows.length;

function align(text: string, width: number, how: "left" | "center" | "right"): string {
  const cell = truncateToWidth(text, width, "…");
  const fill = Math.max(0, width - visibleWidth(cell));
  if (how === "right") return `${" ".repeat(fill)}${cell}`;
  if (how === "center") return `${" ".repeat(Math.floor(fill / 2))}${cell}${" ".repeat(fill - Math.floor(fill / 2))}`;
  return `${cell}${" ".repeat(fill)}`;
}

const justify = (t: TableData, column: string): "left" | "center" | "right" => t.justify?.[column] ?? (isNumber(t, column) ? "right" : "left");

const sortMark = (sort: TableRender["sort"], column: string): string => {
  const i = sort.findIndex((s) => s.by === column);
  if (i < 0) return "";
  return ` ${sort[i]!.descending ? "↓" : "↑"}${sort.length > 1 ? String(i + 1) : ""}`;
};

function capOf(t: TableData, column: string): number {
  const px = t.widths?.[column];
  if (px) return Math.max(3, Math.round(px / 8));
  return t.wrapped?.includes(column) ? MAX_WRAPPED : MAX_COLUMN;
}

/** Uncapped measurement of the rendered header/types and current page, also used by fit. */
export function measureColumn(t: TableData, column: string, sort: TableRender["sort"] = []): number {
  let w = visibleWidth(display(column)) + visibleWidth(sortMark(sort, column));
  const dtype = t.fieldTypes?.[column]?.dtype;
  if (dtype && t.show?.types !== false) w = Math.max(w, visibleWidth(display(dtype)));
  for (let i = 0; i < rowCount(t); i++) w = Math.max(w, visibleWidth(valueAt(t, i, column).text));
  return Math.max(1, w);
}

/** Which columns fit at this width: the frozen ones, and the scrolled window starting at `colOffset`. */
export interface TableLayout {
  /** Half-open terminal-column bounds, shared by rendering and hit testing. */
  columns: Array<{ column: string; start: number; end: number; width: number; frozen?: "left" | "right" }>;
  gutter: { start: number; end: number; width: number };
  hiddenBefore: number;
  hiddenAfter: number;
}

/** One authoritative layout, measured in terminal columns rather than JS characters. */
export function layoutTable(t: TableData, width: number, view?: TableRender): TableLayout {
  width = Math.max(0, Math.floor(width));
  const groups = columnGroups(t);
  const before = Math.max(0, Math.min(Math.floor(view?.colOffset ?? 0), Math.max(0, groups.middle.length - 1)));
  const left = [...new Set([...(t.rowHeaders ?? []), ...groups.left])];
  const right = groups.right.filter(c => !left.includes(c));
  const desired = (c: string) => {
    const override = view?.columnWidths?.get(c);
    if (override !== undefined) return Math.max(4, Math.min(120, Math.round(override)));
    if (t.widths?.[c]) return Math.max(3, Math.min(120, Math.round(t.widths[c]! / 8)));
    return Math.min(capOf(t, c), Math.max(measureColumn(t, c, view?.sort ?? []), visibleWidth(display(c) + sortMark(view?.sort ?? [], c)) + (new Set(view?.filterColumns ?? []).has(c) ? 2 : 0)));
  };
  const digits = String((view?.firstRow ?? 0) + rowCount(t)).length;
  const gutterWidth = Math.min(width, Math.max(4, digits + (t.selection ? 5 : 3)));
  const room = Math.max(0, width - gutterWidth);
  const fixed = [...left, ...right];
  const middle: string[] = [];
  const size = (cols: string[]) => cols.reduce((sum, c) => sum + desired(c), 0) + Math.max(0, cols.length - 1) * 2;
  for (const c of groups.middle.slice(before)) {
    if (middle.length && size([...fixed, ...middle, c]) > room) break;
    middle.push(c);
  }
  let names = [...left, ...middle, ...right];
  // At very narrow widths retain the scrolled column before decorative/frozen context.
  const cursor = view?.focused ? orderedColumns(t)[view.cursorCol ?? 0] : undefined;
  const active = cursor && names.includes(cursor) ? cursor : middle[0] ?? names[0];
  while (names.length > 1 && names.length * 3 - 2 > room) {
    let remove = names.length - 1;
    while (names[remove] === active) remove--;
    names.splice(remove, 1);
  }
  if (!room) names = [];
  const widths = names.map(desired);
  let excess = widths.reduce((a, b) => a + b, 0) + Math.max(0, names.length - 1) * 2 - room;
  while (excess > 0 && widths.some(w => w > 1)) {
    const largest = widths.indexOf(Math.max(...widths));
    widths[largest]!--;
    excess--;
  }
  let x = gutterWidth;
  const columns = names.map((column, i) => {
    const w = widths[i]!;
    const entry = { column, start: x, end: x + w, width: w, ...(left.includes(column) ? { frozen: "left" as const } : right.includes(column) ? { frozen: "right" as const } : {}) };
    x += w + 2;
    return entry;
  });
  const shownMiddle = columns.filter(c => groups.middle.includes(c.column)).length;
  return { columns, gutter: { start: 0, end: gutterWidth, width: gutterWidth }, hiddenBefore: before, hiddenAfter: Math.max(0, groups.middle.length - before - shownMiddle) };
}

/** Compatibility helper; layoutTable also accounts for the row-number gutter. */
export function visibleColumns(t: TableData, width: number, colOffset: number, sort: TableRender["sort"] = [], _shown = rowCount(t)): { left: string[]; middle: string[]; right: string[]; before: number; after: number } {
  const layout = layoutTable(t, width, { focused: false, colOffset, sort, selected: new Set(), firstRow: 0, rowIdOf: String });
  const groups = columnGroups(t);
  const names = layout.columns.map(c => c.column);
  return { left: groups.left.filter(c => names.includes(c)), middle: groups.middle.filter(c => names.includes(c)), right: groups.right.filter(c => names.includes(c)), before: layout.hiddenBefore, after: layout.hiddenAfter };
}

const hex = (value: string): [number, number, number] | undefined => {
  const v = value.trim();
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(v);
  if (m) return [parseInt(m[1]! + m[1]!, 16), parseInt(m[2]! + m[2]!, 16), parseInt(m[3]! + m[3]!, 16)];
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(v);
  if (m) return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/iu.exec(v);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
};

/** A cell's CSS-ish style (marimo's `style_cell`) as terminal attributes. */
function styled(text: string, style: Record<string, unknown> | undefined): string {
  if (!style) return text;
  let out = text;
  const fg = typeof style.color === "string" ? hex(style.color) : undefined;
  const bg = typeof style.backgroundColor === "string" ? hex(style.backgroundColor) : undefined;
  if (fg) out = `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m${out}\x1b[39m`;
  if (bg) out = `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m${out}\x1b[49m`;
  const weight = style.fontWeight;
  if (weight === "bold" || (typeof weight === "number" && weight >= 600) || (typeof weight === "string" && Number(weight) >= 600)) out = boldSgr(out);
  if (style.fontStyle === "italic") out = italic(out);
  if (typeof style.textDecoration === "string" && style.textDecoration.includes("underline")) out = underline(out);
  return out;
}

/** A sparkline of `width` blocks over bin counts. */
export function sparkline(counts: number[], width: number): string {
  if (!counts.length || width < 1) return "";
  const cells = Array.from({ length: width }, (_, i) => {
    const from = Math.floor((i * counts.length) / width);
    const to = Math.max(from + 1, Math.floor(((i + 1) * counts.length) / width));
    return Math.max(...counts.slice(from, to));
  });
  const top = Math.max(...cells, 1);
  return cells.map((c) => BLOCKS[Math.min(7, Math.round((c / top) * 7))]).join("");
}

const compact = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const s = display(String(v));
  return /^\d{4}-\d\d-\d\dT/u.test(s) ? s.slice(0, 10) : s;
};

/** The two summary lines (a chart, and the range or a count) of a column. */
function summaryCells(t: TableData, column: string, s: Summaries, width: number): [string, string] {
  const kind = fieldKind(t, column);
  const stats = s.stats[column] ?? {};
  const bins = s.bins[column] ?? [];
  if (kind === "boolean") {
    const nulls = Number(stats.nulls ?? 0);
    return [`✓${compact(stats.true)} ✗${compact(stats.false)}`, nulls > 0 ? `${compact(nulls)} null` : ""];
  }
  if (kind === "integer" || kind === "number" || isTemporal(kind)) {
    const chart = bins.length ? sparkline(bins.map((b) => b.count), width) : "";
    const range = stats.min === undefined && stats.max === undefined ? "" : `${compact(stats.min)}${isTemporal(kind) ? " → " : "–"}${compact(stats.max)}`;
    return [chart, range];
  }
  const top = (s.counts[column] ?? []).reduce<{ value: unknown; count: number } | undefined>((best, c) => (!best || c.count > best.count ? c : best), undefined);
  return [top ? `${display(String(top.value))} ${compact(top.count)}` : "", stats.unique !== undefined ? `${compact(stats.unique)} unique` : ""];
}

export interface Grid {
  lines: string[];
  /** Page-local row for each body line; undefined for pinned chrome. */
  rowAt: Array<number | undefined>;
  headerRows: number;
  footerRows: number;
  layout: TableLayout;
}

/** Wrap status at whole-token boundaries; never truncate a concatenated sentence. */
function statusLines(tokens: string[], width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    // A single over-wide token is wrapped, not silently cut off.
    const parts = wrapTextWithAnsi(token, width);
    for (const part of parts) {
      if (line && visibleWidth(line) + 3 + visibleWidth(part) > width) { lines.push(line); line = ""; }
      line += (line ? " · " : "") + part;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function tableGrid(t: TableData, width: number, theme: PaneTheme, maxRows: number, view?: TableRender): Grid {
  width = Math.max(0, Math.floor(width));
  const layout = layoutTable(t, width, view);
  const lines: string[] = [];
  const rowAt: Array<number | undefined> = [];
  const add = (line: string, row?: number) => { lines.push(truncateToWidth(line, width)); rowAt.push(row); };
  const dim = (s: string) => theme.fg("dim", s);
  const first = view?.firstRow ?? 0;
  const shown = Math.min(rowCount(t), Math.max(0, maxRows));
  const all = orderedColumns(t);
  const active = view?.focused ? all[view.cursorCol ?? 0] : undefined;
  const filters = new Set(view?.filterColumns ?? []);
  const join = (cell: (column: string, width: number) => string, gutter = "") =>
    align(gutter, layout.gutter.width, "right") + layout.columns.map(c => cell(c.column, c.width)).join(SEP);
  const background = (color: string, text: string) => theme.bg ? theme.bg(color, text) : text;
  if (t.label) add(theme.bold(display(t.label)));
  if (t.banner) add(theme.fg("warning", display(t.banner)));
  add(background("selectedBg", join((c, w) => {
    const mark = filters.has(c) ? " ƒ" : "";
    const label = align(display(c) + sortMark(view?.sort ?? [], c) + mark, w, justify(t, c));
    return c === active ? theme.fg("accent", underline(theme.bold(label))) : theme.bold(label);
  }, "# ")));
  if (t.show?.types !== false && t.fieldTypes) add(background("selectedBg", join((c, w) => dim(align(display(t.fieldTypes?.[c]?.dtype ?? ""), w, "left")))));
  if (view?.summaries) {
    for (const n of [0, 1] as const) add(join((c, w) => dim(align(summaryCells(t, c, view.summaries!, w)[n], w, "left"))));
  }
  const headerRows = lines.length;
  for (let i = 0; i < shown; i++) {
    const id = view?.rowIdOf(i) ?? String(t.records?.[i]?._marimo_row_id ?? first + i);
    const cursor = view?.focused && (view.cursorRow ?? 0) === i;
    const selected = view?.selected.has(id);
    const cells = new Map<string, string[]>();
    let height = 1;
    for (const {column: c, width: w} of layout.columns) {
      const value = valueAt(t, i, c);
      let parts = t.wrapped?.includes(c) && !value.style ? wrapTextWithAnsi(value.text, w) : [value.text];
      if (parts.length > WRAP_LINES) {
        parts = parts.slice(0, WRAP_LINES);
        parts[WRAP_LINES - 1] = truncateToWidth(parts[WRAP_LINES - 1]!, Math.max(0, w - 1)) + "…";
      }
      if (!parts.length) parts = [""];
      cells.set(c, parts);
      height = Math.max(height, parts.length);
    }
    for (let h = 0; h < height; h++) {
      const selection = t.selection === "multi" ? (selected ? "☑" : "☐") : t.selection === "single" ? (selected ? "●" : "○") : "";
      const gutter = h ? "" : `${cursor ? "▸" : " "}${selection}${first + i + 1}  `;
      const line = join((c, w) => {
        const value = valueAt(t, i, c);
        let cell = align(cells.get(c)![h] ?? "", w, justify(t, c));
        if (value.style === "null") cell = dim(italic(cell));
        else if (value.style === "yes") cell = theme.fg("success", cell);
        else if (value.style === "no") cell = dim(cell);
        // Apply stripes per cell so notebook backgrounds always win.
        const style = t.cellStyles?.[id]?.[c];
        if (i % 2 && !(typeof style?.backgroundColor === "string" && hex(style.backgroundColor))) cell = background("toolPendingBg", cell);
        cell = styled(cell, style);
        const chosen = view?.selectedCells?.has(`${id}\0${c}`);
        if (chosen) cell = underline(theme.fg("accent", cell));
        if (cursor && c === active) cell = inverse(cell);
        return cell;
      }, cursor || selected ? theme.fg("accent", gutter) : dim(gutter));
      add(line, i);
    }
  }
  if (!shown) add(dim(view?.loading ? "loading…" : "no rows"));
  const footerStart = lines.length;
  const total = view?.totalRows ?? t.totalRows;
  const range = shown ? `rows ${(first + 1).toLocaleString("en-US")}–${(first + shown).toLocaleString("en-US")}` : "rows 0";
  const tokens = [typeof total === "number" ? `${range} of ${total.toLocaleString("en-US")}` : `${range}, total unknown`];
  const size = t.pageSize ?? shown;
  if (t.pagination !== false && size > 0) tokens.push(`page ${Math.floor(first / size) + 1}${typeof total === "number" ? ` of ${Math.max(1, Math.ceil(total / size))}` : ""}`);
  const indices = layout.columns.map(c => all.indexOf(c.column)).filter(n => n >= 0);
  if (indices.length) tokens.push(`cols ${Math.min(...indices) + 1}–${Math.max(...indices) + 1} of ${all.length}`);
  if (layout.hiddenBefore) tokens.push(`◂ ${layout.hiddenBefore} hidden`);
  if (layout.hiddenAfter) tokens.push(`${layout.hiddenAfter} hidden ▸`);
  if (view?.selectedCount !== undefined || view?.selected.size) tokens.push(`${view?.selectedCount ?? view?.selected.size ?? 0} selected`);
  if (view?.query) tokens.push(`search: ${display(view.query)}`);
  if (filters.size) tokens.push(`filters: ${[...filters].map(display).join(", ")}`);
  for (const s of view?.sort ?? []) tokens.push(`sorted ${display(s.by)} ${s.descending ? "↓" : "↑"}`);
  if (view?.loading) tokens.push("loading…");
  if (view?.error) tokens.push(`error: ${display(view.error)}`);
  if (view?.status) tokens.push(display(view.status));
  for (const line of statusLines(tokens, width)) add(dim(line));
  return { lines, rowAt, headerRows, footerRows: lines.length - footerStart, layout };
}

/** A page-local body viewport; rowOffset is a logical row, never a wrapped-line offset. */
export function tableViewport(t: TableData, width: number, height: number, theme: PaneTheme, view: TableRender, rowOffset: number): Grid & { rowOffset: number } {
  height = Math.max(0, Math.floor(height));
  // Reserve a terminal column for a scrollbar describing this loaded page only.
  const bodyWidth = Math.max(0, width - (width > 1 ? 1 : 0));
  if (view.focused) {
    const column = orderedColumns(t)[view.cursorCol ?? 0];
    const middle = columnGroups(t).middle;
    const at = column === undefined ? -1 : middle.indexOf(column);
    if (at >= 0) {
      let colOffset = Math.min(view.colOffset, at);
      while (colOffset < at && !layoutTable(t, bodyWidth, { ...view, colOffset }).columns.some(c => c.column === column)) colOffset++;
      view = { ...view, colOffset };
    }
  }
  const grid = tableGrid(t, bodyWidth, theme, rowCount(t), view);
  const count = rowCount(t);
  const active = Math.max(0, Math.min(count - 1, view.cursorRow ?? 0));
  const groups: string[][] = Array.from({length: count}, () => []);
  grid.lines.forEach((line, i) => { const row = grid.rowAt[i]; if (row !== undefined) groups[row]!.push(line); });
  let offset = Math.max(0, Math.min(Math.max(0, count - 1), Math.floor(rowOffset)));
  const activeHeight = groups[active]?.length ?? 1;
  // Tiny views sacrifice types/summaries/status before hiding the active row.
  const headerCount = Math.min(grid.headerRows, Math.max(0, height - activeHeight));
  const footerCount = Math.min(grid.footerRows, Math.max(0, height - headerCount - activeHeight));
  const bodyHeight = Math.max(0, height - headerCount - footerCount);
  if (view.focused) {
    if (active < offset) offset = active;
    while (offset < active && groups.slice(offset, active + 1).reduce((n, r) => n + r.length, 0) > bodyHeight) offset++;
  }
  // On resize do not leave avoidable blank space below the final page row.
  while (offset > 0 && groups.slice(offset - 1).reduce((n, r) => n + r.length, 0) <= bodyHeight) offset--;
  const lines = grid.lines.slice(0, headerCount);
  const rowAt: Array<number | undefined> = Array(headerCount).fill(undefined);
  let used = 0;
  for (let row = offset; row < count && used < bodyHeight; row++) {
    const parts = groups[row]!;
    if (used && used + parts.length > bodyHeight) break;
    const take = Math.min(parts.length, bodyHeight - used);
    for (const line of parts.slice(0, take)) { lines.push(line); rowAt.push(row); used++; }
  }
  if (!count && used < bodyHeight) { lines.push(theme.fg("dim", view.loading ? "loading…" : "no rows")); rowAt.push(undefined); used++; }
  while (used < bodyHeight) { lines.push(""); rowAt.push(undefined); used++; }
  if (width > 1 && bodyHeight) {
    const top = count ? Math.floor(offset / count * bodyHeight) : 0;
    const visible = new Set(rowAt.filter((r): r is number => r !== undefined)).size;
    const thumb = Math.max(1, Math.round(visible / Math.max(1, count) * bodyHeight));
    for (let i = 0; i < bodyHeight; i++) {
      const at = headerCount + i;
      lines[at] = align(lines[at]!, Math.max(0, width - 1), "left") + theme.fg("dim", i >= top && i < top + thumb ? "█" : "░");
    }
  }
  if (footerCount) {
    lines.push(...grid.lines.slice(grid.lines.length - grid.footerRows, grid.lines.length - grid.footerRows + footerCount));
    rowAt.push(...Array<undefined>(footerCount).fill(undefined));
  }
  return { lines, rowAt, layout: grid.layout, headerRows: headerCount, footerRows: footerCount, rowOffset: offset };
}

export function tableLines(t: TableData, width: number, theme: PaneTheme, maxRows: number, view?: TableRender): string[] {
  return tableGrid(t, width, theme, maxRows, view).lines;
}

/** Every column of one row, wrapped, the frozen and hidden ones too. */
export function rowCard(t: TableData, rowIndex: number, width: number, theme: PaneTheme, absolute: number): string[] {
  const record = t.records?.[rowIndex];
  const names = [...(t.rowHeaders ?? []), ...(t.hidden ?? []), ...orderedColumns(t)];
  const unique = [...new Set(names)];
  const long = Math.max(1, ...unique.map((n) => visibleWidth(display(n))));
  const out = [theme.bold(`row ${absolute + 1}`)];
  for (const name of unique) {
    const value = record && Object.hasOwn(record, name) ? format(record[name], fieldKind(t, name)).text : valueAt(t, rowIndex, name).text;
    const room = Math.max(10, width - long - 2);
    const wrapped = wrapTextWithAnsi(value, room);
    (wrapped.length ? wrapped : [""]).forEach((line, i) => out.push(`${theme.fg("dim", align(i === 0 ? display(name) : "", long, "left"))}  ${line}`));
  }
  return out.map((l) => truncateToWidth(l, Math.max(1, width)));
}

const STAT_ORDER = ["total", "nulls", "unique", "min", "max", "mean", "median", "std", "p5", "p25", "p75", "p95", "true", "false"];

/** A column's statistics, distribution and most common values. */
export function columnCard(t: TableData, column: string, s: Summaries | undefined, top: Array<[string, number]> | undefined, width: number, theme: PaneTheme): string[] {
  const dtype = t.fieldTypes?.[column]?.dtype;
  const out = [theme.bold(`${display(column)}${dtype ? ` · ${display(dtype)}` : ""}`)];
  const stats = s?.stats[column] ?? {};
  for (const key of STAT_ORDER) {
    const v = stats[key];
    if (v !== null && v !== undefined) out.push(`${theme.fg("dim", key.padEnd(7))}  ${compact(v)}`);
  }
  const bins = s?.bins[column];
  if (bins?.length) out.push("", sparkline(bins.map((b) => b.count), Math.max(10, width)));
  const values = top ?? [];
  if (values.length) {
    const biggest = Math.max(1, ...values.map(([, n]) => n));
    out.push("", theme.fg("dim", "top values"));
    const nameWidth = Math.min(30, Math.max(...values.map(([v]) => visibleWidth(display(String(v))))));
    for (const [value, n] of values.slice(0, 10)) {
      out.push(`${align(display(String(value)), nameWidth, "left")}  ${String(n).padStart(6)}  ${"█".repeat(Math.max(1, Math.round((n / biggest) * 20)))}`);
    }
  }
  if (!s && !top) out.push(theme.fg("dim", "loading…"));
  return out.map((l) => truncateToWidth(l, Math.max(1, width)));
}
