// What the notebook view calls a cell, and its outline badges. A cell's id
// is never shown: a cell is its name, what it defines that others use, or what it shows.
import { markdownText } from "../core/markdown.ts";
import type { Cell, NotebookState } from "../core/notebook.ts";
import { outputLeaves, type CellOutput } from "../core/output.ts";
import { truncate } from "../core/notebook.ts";
import { cellBadges, renderBadge } from "./status.ts";
import type { FrameTheme } from "../frame.ts";

const MAX_TITLE = 40;

const codeLines = (code: string): string[] => code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/** A cell that only imports: every variable it defines is a module (or, values unknown, most of its lines are imports). */
function isImports(nb: NotebookState, cell: Cell, defs: string[]): boolean {
  if (defs.length && defs.every((d) => nb.values.has(d))) return defs.every((d) => nb.values.get(d)?.datatype === "module");
  const lines = codeLines(cell.code);
  return lines.length > 0 && lines.filter((l) => /^(?:import|from)\s/u.test(l)).length * 2 >= lines.length;
}

const names = (list: string[]): string => `${list.slice(0, 2).join(", ")}${list.length > 2 ? ` +${list.length - 2}` : ""}`;

const firstCodeLine = (code: string): string => code.split("\n").find((l) => l.trim())?.trim() ?? "";

/** An output the view only knows is interactive (marimo's own elements it cannot draw). */
const interactive = (o: NonNullable<Cell["output"]>): boolean => o.kind === "chart" && !o.vega && !o.plotly && !o.image && o.text.startsWith("[interactive");

/** The words for what a cell's output is, when it is not text. */
function shows(cell: Cell): string | undefined {
  const o = cell.output;
  if (!o) return undefined;
  if (interactive(o)) return "output";
  if (o.kind === "image" || o.kind === "chart") return "chart";
  if (o.kind === "table") return "table";
  if (o.kind === "widgets" || (o.widgets?.length && !o.text.trim())) return "controls";
  return undefined;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
/** A Vega or Plotly title: a string, lines of one, or `{ text }`. */
const titleText = (v: unknown): string => {
  const t = obj(v)?.text ?? v;
  return (Array.isArray(t) ? t.filter((s) => typeof s === "string").join(" ") : typeof t === "string" ? t : "").replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim();
};

/** A Vega-Lite spec's title, else "y by x" from its first encoding (layers, facets and concatenations included). */
function vegaName(spec: Json): string {
  const views: Json[] = [];
  const walk = (s: Json | undefined, depth: number) => {
    if (!s || depth > 4) return;
    views.push(s);
    for (const key of ["layer", "hconcat", "vconcat", "concat"]) { const list = s[key]; if (Array.isArray(list)) walk(obj(list[0]), depth + 1); }
    walk(obj(s.spec), depth + 1);
  };
  walk(spec, 0);
  for (const v of views) { const t = titleText(v.title); if (t) return t; }
  for (const v of views) {
    const enc = obj(v.encoding);
    if (!enc) continue;
    const axis = (ch: string): string => { const e = obj(enc[ch]); return e ? titleText(e.title) || (typeof e.field === "string" ? e.field : "") : ""; };
    const x = axis("x"), y = axis("y");
    if (x || y) return x && y ? `${y} by ${x}` : x || y;
  }
  return "";
}

/** A Plotly figure's title, else "y by x" from its axis titles. */
function plotlyName(fig: Json): string {
  const layout = obj(fig.layout) ?? {};
  const t = titleText(layout.title);
  if (t) return t;
  const x = titleText(obj(layout.xaxis)?.title), y = titleText(obj(layout.yaxis)?.title);
  return x && y ? `${y} by ${x}` : x || y;
}

const chartNames = new WeakMap<object, string>();
/** The name a chart gives itself, from the first leaf whose spec has one. */
function chartName(o: CellOutput): string {
  const known = chartNames.get(o);
  if (known !== undefined) return known;
  let name = "";
  for (const leaf of outputLeaves(o)) {
    try {
      const spec = leaf.vega ? obj(JSON.parse(leaf.vega)) : undefined;
      const fig = leaf.plotly ? obj(JSON.parse(leaf.plotly)) : undefined;
      name = (spec ? vegaName(spec) : "") || (fig ? plotlyName(fig) : "");
    } catch { /* A spec that does not parse names nothing. */ }
    if (name) break;
  }
  chartNames.set(o, name);
  return name;
}

const lastCodeLine = (code: string): string => codeLines(code).at(-1) ?? "";
/** The variable a cell's last line displays: `df`, or one wrapped in `mo.ui.table(df)` and the like. */
function displayed(code: string): string | undefined {
  const line = lastCodeLine(code);
  const m = /^([A-Za-z_]\w*)$/u.exec(line) ?? /^mo\.ui\.(?:table|dataframe|data_explorer|altair_chart|plotly)\(\s*([A-Za-z_]\w*)\s*[,)]/u.exec(line);
  return m && m[1] !== "_" ? m[1] : undefined;
}

const bare = (name: string): string => name.replace(/^_+/u, "") || name;

/** What a chart or table is called: the chart's own title, else the variable the cell displays, else the kind. */
function outputName(cell: Cell): string | undefined {
  const word = shows(cell);
  if (word !== "chart" && word !== "table") return word;
  const titled = word === "chart" ? chartName(cell.output!) : "";
  const shown = displayed(cell.code);
  return titled || (shown ? bare(shown) : word);
}

/** The first line of prose a cell shows, when it reads as words (not a bare number or repr). */
function shownText(cell: Cell): string | undefined {
  const o = cell.output;
  if (!o || o.kind !== "text" || o.severity) return undefined;
  const line = o.text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/u, "").replace(/\s+/gu, " ").trim()).find(Boolean);
  return line && /\p{L}{3}/u.test(line) ? line : undefined;
}

/** The cell-private names (`_verdict`, `def _at`) a cell defines at top level, without their underscore;
 * none when it also defines a public one. */
function privateNames(code: string): string[] {
  const found: string[] = [];
  for (const line of code.split("\n")) {
    const m = /^(?:(?:async\s+)?def|class)\s+(\w+)/u.exec(line) ?? /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/u.exec(line);
    if (!m) continue;
    if (!m[1]!.startsWith("_")) return [];
    if (!found.includes(bare(m[1]!))) found.push(bare(m[1]!));
  }
  return found;
}

/** A cell's title: its name; `imports`; the variables others use; what it shows (a chart's title, the table it displays);
 * its other variables; the prose it shows; its cell-private names; its first line of code. */
export function cellTitle(nb: NotebookState, cell: Cell): string {
  if (nb.isMarkdown(cell)) {
    const heading = nb.headings(cell)[0];
    if (heading) return truncate(heading.text, MAX_TITLE);
    return truncate((markdownText(cell.code) ?? cell.code).replace(/\s+/gu, " ").trim() || "(empty)", MAX_TITLE);
  }
  if (cell.name && cell.name !== "_") return truncate(cell.name, MAX_TITLE);
  const defs = nb.defs.get(cell.id) ?? [];
  if (isImports(nb, cell, defs)) return "imports";
  const used = defs.filter((d) => (nb.usedBy.get(d) ?? []).some((id) => id !== cell.id));
  if (used.length) return truncate(names(used), MAX_TITLE);
  const word = outputName(cell);
  if (word) return truncate(word, MAX_TITLE);
  if (defs.length) return truncate(names(defs), MAX_TITLE);
  const own = privateNames(cell.code);
  if (own.length) return truncate(shownText(cell) ?? names(own), MAX_TITLE);
  return truncate(firstCodeLine(cell.code) || "(empty)", MAX_TITLE);
}

/** The cell's section path without its own headings. */
export function sectionOf(nb: NotebookState, cellId: string): string[] {
  const cell = nb.cells.get(cellId);
  const path = nb.sectionPath(cellId);
  return cell ? path.slice(0, Math.max(0, path.length - nb.headings(cell).length)) : path;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The shape of a cell's output (`450×4`, `chart`, `4 inputs`), or nothing. */
export function outputShape(cell: Cell): string {
  const o = cell.output;
  if (!o) return "";
  if (o.kind === "table") {
    const t = o.table;
    if (!t) return "table";
    const rows = t.totalRows === "many" ? "many" : (t.totalRows ?? t.rows.length).toLocaleString("en-US");
    return `${rows}×${(t.totalColumns ?? t.columns.length).toLocaleString("en-US")}`;
  }
  if (o.kind === "image") return "image";
  if (interactive(o)) return "interactive";
  if (o.kind === "chart") return "chart";
  if (o.widgets?.length && (o.kind === "widgets" || !o.text.trim())) return plural(o.widgets.length, "input");
  return "";
}

/** Unconstrained badges for callers without an outline width; otherwise the output's shape. */
export function cellBadge(nb: NotebookState, cell: Cell, now: number, theme: FrameTheme): string {
  const badges = cellBadges(nb, cell, now);
  return badges.length ? badges.map((badge) => renderBadge(badge, theme)).join(" ") : theme.fg("dim", outputShape(cell));
}
