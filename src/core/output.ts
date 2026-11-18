// What a cell printed, kept compact for the notebook view (never for the agent's snapshot): the
// last output as text (HTML stripped, images named), its table's first page and its widgets, and
// the current terminal console display.
import { serializeOuter } from "parse5";
import type { OutputNode } from "./html.ts";
import { progressFromNode, type ProgressTask } from "./progress.ts";
import { nutpieProgressFromNode } from "./sampler.ts";
import { componentProps, outputElements, parseOutputFragment, textContent } from "./html.ts";

export type OutputKind = "text" | "table" | "image" | "chart" | "widgets" | "other";

/** The rows a table output carries (marimo sends its first page), as text. */
export interface TableData {
  columns: string[];
  numeric: boolean[];
  rows: string[][];
  /** How many rows the whole table has (`many`: marimo did not count them). */
  totalRows?: number | "many";
  totalColumns?: number;
  /** The `<marimo-ui-element>` object id around the table: its kernel functions are called by it. Absent for HTML tables. */
  objectId?: string;
  /** The parsed rows, as marimo sent them (with `_marimo_row_id`). */
  records?: Array<Record<string, unknown>>;
  /** `data-field-types`: each column's kind (`integer`, `string`, `boolean`, `datetime`...) and dtype. */
  fieldTypes?: Record<string, { kind: string; dtype: string }>;
  /** Keys of a row that are no column (a pandas index). */
  rowHeaders?: string[];
  selection?: "single" | "multi" | "single-cell" | "multi-cell";
  initialValue?: unknown;
  pageSize?: number;
  pagination?: boolean;
  label?: string;
  banner?: string;
  hidden?: string[];
  freezeLeft?: string[];
  freezeRight?: string[];
  justify?: Record<string, "left" | "center" | "right">;
  wrapped?: string[];
  /** Pixel widths. */
  widths?: Record<string, number>;
  cellStyles?: Record<string, Record<string, Record<string, unknown>>>;
  show?: { summaries: boolean; types: boolean; search: boolean; filters: boolean; download: boolean; pageSize: boolean };
  /** Where the rows are, when marimo sent a file or data URL instead of inline JSON. */
  dataRef?: string;
  lazy?: boolean;
}

export type WidgetKind = "slider" | "number" | "range-slider" | "checkbox" | "switch" | "text" | "text-area" | "dropdown" | "radio" | "multiselect" | "button" | "date" | "other";

/** A marimo UI element in an output (`<marimo-ui-element object-id>`), with what the view needs to show and drive it. */
export interface Widget {
  objectId: string;
  kind: WidgetKind;
  /** The element's tag, `marimo-slider`. */
  tag: string;
  label: string;
  /** The value the element was created with (its current one may differ: NotebookState.uiValues). */
  initial: unknown;
  options: string[];
  start?: number;
  stop?: number;
  step?: number;
  steps: number[];
  disabled: boolean;
}

export interface StatItem { label?: string; value: string; caption?: string; direction?: "increase" | "decrease"; good?: boolean }
export type CalloutTone = "neutral" | "info" | "success" | "warn" | "danger";
export interface OutputContainer {
  type: "callout" | "disclosure";
  /** callout only */
  tone?: CalloutTone;
  /** The callout's title, or the section's header label (plain text). */
  title?: string;
  /** disclosure only: whether the HTML opens it. */
  open?: boolean;
  body?: CellOutput;
}

export interface CellOutput {
  kind: OutputKind;
  text: string;
  /** The same prose as `text`, as Markdown, for HTML outputs. */
  markdown?: string;
  /** `mo.stat` cards, one row of them. */
  stats?: StatItem[];
  /** Side-by-side prose columns, each as Markdown. */
  columns?: string[];
  /** A callout or a collapsible section around a nested output. */
  container?: OutputContainer;
  /** Internal: the flex row stats were found in, while merging them. */
  statRow?: string;
  /** Authoritative document-order display; scalar fields below are compatibility projections. */
  blocks?: Array<{ id: string; output: OutputLeaf }>;
  progress?: ProgressTask[];
  severity?: "error" | "warning";
  /** Complete sources, in document order; never subject to summary limits. */
  mermaid?: string[];
  codeBlocks?: Array<{ source: string; language?: string }>;
  /** A PNG the view can draw inline (base64, no data: prefix), when the output is small enough. */
  image?: { mime: "image/png"; data: string };
  /** A Vega or Vega-Lite spec (JSON text) the view can turn into `image`, for a chart. */
  vega?: string;
  /** A Plotly figure (JSON text with `data` and `layout`), likewise. */
  plotly?: string;
  /** A table's first page, when the output is a table. */
  table?: TableData;
  /** The UI elements the output shows. */
  widgets?: Widget[];
}

export type OutputLeaf = Omit<CellOutput, "blocks">;

export interface ConsoleLine {
  stream: "stdout" | "stderr";
  text: string;
  /** xterm column positions, including its configured Unicode width policy. */
  cells?: Array<{ column: number; width: number; text: string }>;
  severity?: "output" | "error" | "warning" | "stderr" | "progress";
  styles?: Array<{ column: number; width: number; bold: boolean; italic: boolean; underline: boolean; inverse: boolean; fgDefault: boolean; bgDefault: boolean; fg: number; bg: number; fgMode: number; bgMode: number }>;
}

const MAX_TEXT = 8_000;
/** Largest PNG kept for inline drawing, as base64 characters (about 1.5 MB of image). */
const MAX_IMAGE = 2_000_000;
/** Largest chart spec kept, in characters (Vega-Lite specs carry their data). */
const MAX_SPEC = 1_500_000;
const vegaOf = (spec: unknown): string | undefined => {
  const text = typeof spec === "string" ? spec : spec !== null && typeof spec === "object" ? JSON.stringify(spec) : "";
  return text.length > 1 && text.length <= MAX_SPEC && text.trimStart().startsWith("{") ? text : undefined;
};

const pngOf = (data: string): CellOutput["image"] | undefined => {
  const b64 = data.replace(/^data:image\/png;base64,/iu, "").replace(/\s+/gu, "");
  return b64.length > 0 && b64.length <= MAX_IMAGE && /^[A-Za-z0-9+/]+=*$/u.test(b64) ? { mime: "image/png", data: b64 } : undefined;
};


const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (whole, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[String(name).toLowerCase()] ?? whole;
  });
}

/** The JSON value starting at `from` in `text` (an object or array), found by balancing brackets outside strings. */
function jsonAt(text: string, from: number): { json: string; end: number } | undefined {
  let i = from;
  while (/\s/u.test(text[i] ?? "")) i++;
  const open = text[i];
  if (open !== "{" && open !== "[") return undefined;
  let depth = 0;
  let inString = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j]!;
    if (inString) {
      if (c === "\\") j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return { json: text.slice(i, j + 1), end: j + 1 };
  }
  return undefined;
}

/** A Plotly figure from marimo's HTML: `<marimo-plotly data-figure>` (mo.ui.plotly) or a figure's own `Plotly.newPlot(id, data, layout, ...)` page in an iframe. */
export function plotlyFrom(html: string): string | undefined {
  const attr = /<marimo-plotly\b[^>]*?\bdata-figure=(?:'([^']*)'|"([^"]*)")/iu.exec(html);
  if (attr) return vegaOf(decode(attr[1] ?? attr[2] ?? ""));
  const srcdoc = /<iframe\b[^>]*?\bsrcdoc=(?:'([^']*)'|"([^"]*)")/iu.exec(html);
  const page = srcdoc ? decode(srcdoc[1] ?? srcdoc[2] ?? "") : html;
  const call = /Plotly\.newPlot\(\s*(?:"[^"]*"|'[^']*')\s*,/u.exec(page);
  if (!call) return undefined;
  const data = jsonAt(page, call.index + call[0].length);
  if (!data || !data.json.startsWith("[")) return undefined;
  const after = /^\s*,/u.exec(page.slice(data.end));
  const layout = after ? jsonAt(page, data.end + after[0].length) : undefined;
  return vegaOf(`{"data":${data.json},"layout":${layout && layout.json.startsWith("{") ? layout.json : "{}"}}`);
}

/** HTML as plain text: block ends become newlines, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, "")
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre|\/ul|\/ol|\/table)\b[^>]*>/giu, "\n")
      .replace(/<\/t[dh]>/giu, "\t")
      .replace(/<[^>]*>/gu, ""),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

const clip = (text: string): string => (text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`);

/** The attributes of an opening tag, entity-decoded. */
export function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/gu;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1]!] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

function json(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLUMNS = 50;

export function cellText(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value) ?? "";
  const flat = text.replace(/\s+/gu, " ");
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : v === undefined || v === null ? fallback : Boolean(v));
const SELECTIONS = new Set(["single", "multi", "single-cell", "multi-cell"]);

/** A `<marimo-table>`'s first page (marimo double-encodes it: a JSON string of the JSON rows), its row count and its settings. */
export function marimoTable(html: string): { table?: TableData; totalRows?: number | "many" } | undefined {
  const found = /<marimo-table\b[^>]*>/iu.exec(html);
  const tag = found?.[0];
  if (!tag || !found) return undefined;
  const a = attributes(tag);
  const total = json(a["data-total-rows"]);
  const totalRows = typeof total === "number" && Number.isFinite(total) ? total : total === "too_many" ? "many" as const : undefined;
  let data = json(a["data-data"]);
  let dataRef: string | undefined;
  if (typeof data === "string") {
    if (data.trimStart().startsWith("[")) data = json(data);
    else if (data) dataRef = data;
  }
  const objects = Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r)) : [];
  const out: { table?: TableData; totalRows?: number | "many" } = totalRows !== undefined ? { totalRows } : {};
  const fieldTypes: Record<string, { kind: string; dtype: string }> = {};
  const types = json(a["data-field-types"]);
  if (Array.isArray(types)) {
    for (const entry of types) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const [kind, dtype] = Array.isArray(entry[1]) ? entry[1] : [];
      fieldTypes[entry[0]] = { kind: typeof kind === "string" ? kind : "string", dtype: typeof dtype === "string" ? dtype : "" };
    }
  }
  const typed = Object.keys(fieldTypes);
  if (!objects.length && !dataRef && !typed.length) return out;
  const hidden = strList(json(a["data-hidden-columns"])) ?? [];
  const first = objects[0] ?? {};
  const keys = Object.keys(first).filter((k) => !k.startsWith("_marimo"));
  const rowHeaders = typed.length ? keys.filter((k) => !(k in fieldTypes)) : [];
  const names = (typed.length ? typed : keys).filter((c) => !hidden.includes(c)).slice(0, MAX_TABLE_COLUMNS);
  const columnsTotal = json(a["data-total-columns"]);
  const selection = json(a["data-selection"]);
  const pageSize = json(a["data-page-size"]);
  const label = json(a["data-label"]);
  const banner = json(a["data-banner-text"]);
  const justify = json(a["data-text-justify-columns"]);
  const widths = json(a["data-column-widths"]);
  const styles = json(a["data-cell-styles"]);
  const objectId = (() => {
    let id: string | undefined;
    const re = /<marimo-ui-element\b([^>]*)>/giu;
    for (let m = re.exec(html.slice(0, found.index)); m; m = re.exec(html.slice(0, found.index))) id = attributes(m[1] ?? "")["object-id"] ?? id;
    return id;
  })();
  const kindOf = (c: string): string => fieldTypes[c]?.kind ?? "";
  const rows = objects.slice(0, MAX_TABLE_ROWS);
  const columnWidths = record(widths);
  const justified = record(justify);
  const table: TableData = {
    columns: names,
    numeric: names.map((c) => kindOf(c) === "integer" || kindOf(c) === "number"),
    rows: rows.map((r) => names.map((c) => cellText(r[c]))),
    ...(totalRows !== undefined ? { totalRows } : {}),
    ...(typeof columnsTotal === "number" && Number.isFinite(columnsTotal) ? { totalColumns: columnsTotal } : {}),
    ...(objectId ? { objectId } : {}),
    records: rows,
    ...(typed.length ? { fieldTypes } : {}),
    ...(rowHeaders.length ? { rowHeaders } : {}),
    ...(typeof selection === "string" && SELECTIONS.has(selection) ? { selection: selection as TableData["selection"] } : {}),
    ...(a["data-initial-value"] !== undefined ? { initialValue: json(a["data-initial-value"]) } : {}),
    ...(typeof pageSize === "number" && pageSize > 0 ? { pageSize } : {}),
    ...(typeof json(a["data-pagination"]) === "boolean" ? { pagination: json(a["data-pagination"]) as boolean } : {}),
    ...(typeof label === "string" && label ? { label: htmlToText(label).replace(/\s+/gu, " ").trim() } : {}),
    ...(typeof banner === "string" && banner ? { banner } : {}),
    ...(hidden.length ? { hidden } : {}),
    ...(strList(json(a["data-freeze-columns-left"]))?.length ? { freezeLeft: strList(json(a["data-freeze-columns-left"])) } : {}),
    ...(strList(json(a["data-freeze-columns-right"]))?.length ? { freezeRight: strList(json(a["data-freeze-columns-right"])) } : {}),
    ...(Object.keys(justified).length ? { justify: Object.fromEntries(Object.entries(justified).filter(([, v]) => v === "left" || v === "center" || v === "right")) as TableData["justify"] } : {}),
    ...(strList(json(a["data-wrapped-columns"]))?.length ? { wrapped: strList(json(a["data-wrapped-columns"])) } : {}),
    ...(Object.keys(columnWidths).length ? { widths: Object.fromEntries(Object.entries(columnWidths).filter((e): e is [string, number] => typeof e[1] === "number")) } : {}),
    ...(Object.keys(record(styles)).length ? { cellStyles: record(styles) as TableData["cellStyles"] } : {}),
    show: {
      summaries: flag(json(a["data-show-column-summaries"]), true),
      types: flag(json(a["data-show-data-types"]), true),
      search: flag(json(a["data-show-search"]), true),
      filters: flag(json(a["data-show-filters"]), true),
      download: flag(json(a["data-show-download"]), true),
      pageSize: flag(json(a["data-show-page-size-selector"]), true),
    },
    ...(dataRef ? { dataRef } : {}),
    ...(json(a["data-lazy"]) === true ? { lazy: true } : {}),
  };
  out.table = table;
  return out;
}

const NUMBER = /^-?[\d,]*\.?\d+(?:e[-+]?\d+)?%?$/iu;

/** The first HTML `<table>` (pandas, markdown tables) as rows; undefined without a body row. */
export function htmlTable(html: string): TableData | undefined {
  const table = /<table\b[\s\S]*?<\/table>/iu.exec(html)?.[0];
  if (!table) return undefined;
  const rows: Array<{ header: boolean; cells: string[] }> = [];
  for (const tr of table.match(/<tr\b[\s\S]*?<\/tr>/giu) ?? []) {
    const cells: string[] = [];
    const re = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/giu;
    for (let m = re.exec(tr); m; m = re.exec(tr)) cells.push(htmlToText(m[2] ?? "").replace(/\s+/gu, " ").trim());
    if (cells.length) rows.push({ header: /<th\b/iu.test(tr), cells });
  }
  const headerAt = rows.findIndex((r) => r.header);
  const header = headerAt === 0 ? rows[0]! : undefined;
  const all = header ? rows.slice(1) : rows;
  const body = all.slice(0, MAX_TABLE_ROWS);
  if (!body.length) return undefined;
  const width = Math.max(header?.cells.length ?? 0, ...body.map((r) => r.cells.length));
  const columns = Array.from({ length: width }, (_, i) => header?.cells[i] ?? `col ${i + 1}`);
  const cells = body.map((r) => Array.from({ length: width }, (_, i) => r.cells[i] ?? ""));
  return {
    columns,
    numeric: columns.map((_, i) => cells.some((r) => r[i]) && cells.every((r) => !r[i] || NUMBER.test(r[i]!))),
    rows: cells,
    totalRows: all.length,
  };
}

const WIDGET_KINDS: Record<string, WidgetKind> = {
  "marimo-slider": "slider",
  "marimo-number": "number",
  "marimo-range-slider": "range-slider",
  "marimo-checkbox": "checkbox",
  "marimo-switch": "switch",
  "marimo-text": "text",
  "marimo-text-area": "text-area",
  "marimo-dropdown": "dropdown",
  "marimo-radio": "radio",
  "marimo-multiselect": "multiselect",
  "marimo-button": "button",
  "marimo-date": "date",
};
/** UI elements drawn some other way: tables, charts, anywidgets (Lens among them). */
const NOT_WIDGETS = new Set(["marimo-table", "marimo-plotly", "marimo-vega", "marimo-anywidget"]);
const MAX_WIDGETS = 16;

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The UI elements an output shows; every `data-*` attribute marimo writes is JSON. */
export function parseWidgets(html: string): Widget[] {
  const out: Widget[] = [];
  const re = /<marimo-ui-element\b([^>]*)>\s*<(marimo-[a-z-]+)\b([^>]*)>/giu;
  for (let m = re.exec(html); m && out.length < MAX_WIDGETS; m = re.exec(html)) {
    const objectId = attributes(m[1] ?? "")["object-id"];
    const tag = (m[2] ?? "").toLowerCase();
    if (!objectId || NOT_WIDGETS.has(tag)) continue;
    const a = attributes(m[3] ?? "");
    const label = json(a["data-label"]);
    const options = json(a["data-options"]);
    const steps = json(a["data-steps"]);
    const start = finite(json(a["data-start"]));
    const stop = finite(json(a["data-stop"]));
    const step = finite(json(a["data-step"]));
    out.push({
      objectId,
      kind: WIDGET_KINDS[tag] ?? "other",
      tag,
      label: label === null || label === undefined ? "" : htmlToText(String(label)).replace(/\s+/gu, " ").trim(),
      initial: json(a["data-initial-value"]),
      options: Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [],
      ...(start !== undefined ? { start } : {}),
      ...(stop !== undefined ? { stop } : {}),
      ...(step !== undefined ? { step } : {}),
      steps: Array.isArray(steps) ? steps.filter((s): s is number => typeof s === "number" && Number.isFinite(s)) : [],
      disabled: json(a["data-disabled"]) === true,
    });
  }
  return out;
}

const rowCount = (n: number | "many" | undefined): string =>
  n === undefined ? "[table]" : n === "many" ? "[table, many rows]" : `[table, ${n} row${n === 1 ? "" : "s"}]`;

/** Backslash-escapes what Markdown would read as syntax; at a line start, list markers too. */
export function escapeMarkdown(text: string, lineStart: boolean): string {
  const escaped = text.replace(/[\\`*_[\]<>#|~$!]/gu, "\\$&");
  return lineStart ? escaped.replace(/^(\s*)(?:([-+])|(\d+)([.)]))(?= )/u, (_, space: string, bullet?: string, digits?: string, dot?: string) => bullet ? `${space}\\${bullet}` : `${space}${digits}\\${dot}`) : escaped;
}

/** Every leaf in display order, descending into container bodies (closed ones too). */
export function outputLeaves(output: CellOutput | undefined): OutputLeaf[] {
  if (!output) return [];
  if (output.blocks) return output.blocks.flatMap(block => [block.output, ...outputLeaves(block.output.container?.body)]);
  return [output, ...outputLeaves(output.container?.body)];
}

const TONES = new Set<string>(["neutral", "info", "success", "warn", "danger"]);
const ADMONITION_TONES: Record<string, CalloutTone> = {
  note: "info", info: "info", abstract: "info", summary: "info", question: "info",
  tip: "success", hint: "success", success: "success", check: "success", done: "success",
  warning: "warn", caution: "warn", attention: "warn",
  danger: "danger", error: "danger", failure: "danger", bug: "danger",
};
const MAX_NESTING = 6;

const attr = (node: OutputNode, name: string): string | undefined => "attrs" in node ? node.attrs.find(a => a.name === name)?.value : undefined;
const classes = (node: OutputNode): string[] => (attr(node, "class") ?? "").split(/\s+/u).filter(Boolean);
const elementChildren = (node: OutputNode): Array<Extract<OutputNode, { tagName: string }>> => "childNodes" in node ? node.childNodes.filter((child): child is Extract<OutputNode, { tagName: string }> => "tagName" in child) : [];
const isFlexRow = (node: OutputNode): boolean => {
  const style = attr(node, "style") ?? "";
  return /display:\s*flex/iu.test(style) && !/flex-direction:\s*column/iu.test(style);
};
const COMPONENT_TAGS = new Set(["pre", "table", "img", "svg", "canvas", "iframe", "progress", "details"]);
const hasComponent = (node: OutputNode): boolean => {
  if ("tagName" in node) {
    if (COMPONENT_TAGS.has(node.tagName) || node.tagName.startsWith("marimo-")) return true;
    const names = classes(node);
    if (node.tagName === "div" && (names.includes("nutpie") || names.includes("admonition"))) return true;
  }
  return "childNodes" in node && node.childNodes.some(hasComponent);
};
/** A node's HTML, text nodes included. */
const outerHtml = (node: OutputNode): string => {
  if ("tagName" in node) return serializeOuter(node);
  if (node.nodeName === "#text" && "value" in node) return node.value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return "";
};
const plainTitle = (html: string): string => htmlToText(html).replace(/\s+/gu, " ").trim();
/** Whitespace-only newlines in `s` to at least `n` newlines at its end; empty text stays empty. */
function ensureEnd(s: string, n: number): string {
  if (!s.trim()) return s;
  const base = s.replace(/\s+$/u, "");
  const have = (s.slice(base.length).match(/\n/gu) ?? []).length;
  return base + "\n".repeat(Math.max(have, n));
}
const PARAGRAPH_TAGS = /^(?:p|h[1-6]|ul|ol|blockquote|hr|section)$/u;
const LINE_TAGS = /^(?:div|li|tr|dt|dd|summary)$/u;

function statOf(props: Record<string, unknown>): StatItem {
  const value = props.value;
  const shown = typeof value === "number" ? value.toLocaleString("en-US") : typeof value === "boolean" ? (value ? "✓" : "✗") : typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
  const direction = props.direction === "increase" || props.direction === "decrease" ? props.direction : undefined;
  const target = props.target_direction === "decrease" ? "decrease" : "increase";
  const text = (v: unknown) => typeof v === "string" || typeof v === "number" ? String(v) : undefined;
  const label = text(props.label);
  const caption = text(props.caption);
  return { value: shown, ...(label ? { label } : {}), ...(caption ? { caption } : {}), ...(direction ? { direction, good: direction === target } : {}) };
}

function orderedHtml(html: string, scope = "", depth = 0): CellOutput | undefined {
  const blocks: NonNullable<CellOutput["blocks"]> = [];
  let residual = "";
  let md = "";
  let listItems = 0;
  let noColumns = false;
  const lists: Array<{ ordered: boolean; n: number }> = [];
  const root = scope ? `${scope}>0` : "0";
  const tidy = (text: string) => text.replace(/\\\n(?=[ \t]*(?:\n|$))/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  const flush = () => {
    const text = residual.replace(/\n{3,}/gu, "\n\n").trim();
    const markdown = tidy(md);
    if (text || markdown) blocks.push({ id: `html:text:${scope ? `${scope}>` : ""}${blocks.length}`, output: { kind: "text", text: clip(text), markdown: clip(markdown) } });
    residual = ""; md = "";
  };
  const line = () => { if (residual.trim() && !residual.endsWith("\n")) residual = residual.replace(/[ \t\r\f]*$/gu, "") + "\n"; };
  const paragraph = () => { residual = ensureEnd(residual, 2); };
  const mdBreak = (n: number) => { md = ensureEnd(md, n); };
  /** Runs `fn` with an empty Markdown buffer and returns what it wrote there; plain text carries on. */
  const markdownOf = (fn: () => void): string => { const saved = md; md = ""; fn(); const out = md; md = saved; return out; };
  /** A node visited into fresh buffers, for a column. */
  const capture = (node: OutputNode, path: string, flexRow?: string): { text: string; markdown: string } => {
    const saved = { residual, md, noColumns };
    residual = ""; md = ""; noColumns = true;
    visit(node, path, undefined, flexRow);
    const out = { text: residual.replace(/\n{3,}/gu, "\n\n").trim(), markdown: tidy(md) };
    residual = saved.residual; md = saved.md; noColumns = saved.noColumns;
    return out;
  };
  const push = (id: string, output: OutputLeaf) => { flush(); blocks.push({ id, output }); };
  const nested = (nodes: OutputNode[] | string, at: string): CellOutput | undefined =>
    depth + 1 >= MAX_NESTING ? undefined : orderedHtml(typeof nodes === "string" ? nodes : nodes.map(outerHtml).join(""), at, depth + 1);
  const sections = (path: string, tag: string, panels: Array<{ title: string; nodes: OutputNode[]; open: boolean }>) => {
    panels.forEach((panel, i) => {
      const body = nested(panel.nodes, `${path}:${i}`);
      push(`html:${path}:${tag}:${i}`, { kind: "text", text: panel.title, container: { type: "disclosure", title: panel.title, open: panel.open, ...(body ? { body } : {}) } });
    });
  };
  const visit = (node: OutputNode, path: string, objectId?: string, flexRow?: string) => {
    if (node.nodeName === "#text" && "value" in node) {
      const text = node.value.replace(/[ \t\r\n\f]+/gu, " ");
      residual += residual === "" || residual.endsWith("\n") ? text.replace(/^ /u, "") : text;
      const lineStart = md === "" || md.endsWith("\n");
      md += escapeMarkdown(lineStart ? text.replace(/^ /u, "") : text, lineStart);
      return;
    }
    if (!("tagName" in node)) {
      if ("childNodes" in node) node.childNodes.forEach((child, i) => visit(child, `${path}.${i}`, objectId, flexRow));
      return;
    }
    const tag = node.tagName;
    if (["script", "style", "template"].includes(tag)) return;
    const id = node.attrs.find(a => a.name === "object-id")?.value ?? objectId;
    const props = componentProps(node);
    const markup = () => serializeOuter(node).replace(/="([^"]*)"/gu, (_, value: string) => `="${value.replace(/>/gu, "&gt;").replace(/</gu, "&lt;")}"`);
    const special = depth < MAX_NESTING;
    let leaf: OutputLeaf | undefined;
    if (tag === "div" && node.attrs.some(a => a.name === "class" && a.value.split(/\s+/u).includes("nutpie"))) {
      const progress = nutpieProgressFromNode(node, `nutpie:${path}`);
      if (progress) leaf = { kind: "text", text: "", progress };
    }
    // Sections: details, accordions and tabs.
    if (!leaf && special && tag === "details") {
      const children = "childNodes" in node ? node.childNodes : [];
      const summary = elementChildren(node).find(child => child.tagName === "summary");
      sections(path, tag, [{ title: summary ? plainTitle(textContent(summary)) || "Details" : "Details", nodes: children.filter(child => child !== summary), open: node.attrs.some(a => a.name === "open") }]);
      return;
    }
    if (!leaf && special && tag === "marimo-accordion") {
      const labels = Array.isArray(props.labels) ? props.labels : [];
      const expanded = Array.isArray(props.expanded) ? props.expanded : [];
      sections(path, tag, elementChildren(node).map((panel, i) => ({ title: plainTitle(String(labels[i] ?? "")) || `Section ${i + 1}`, nodes: [panel], open: expanded.includes(i) })));
      return;
    }
    const tabs = special && tag === "marimo-ui-element" ? elementChildren(node).find(child => child.tagName === "marimo-tabs") : undefined;
    if (!leaf && tabs) {
      const tabProps = componentProps(tabs);
      const labels = Array.isArray(tabProps.tabs) ? tabProps.tabs : [];
      const selected = Number(tabProps["initial-value"]) || 0;
      sections(path, "marimo-tabs", elementChildren(tabs).filter(panel => attr(panel, "data-kind") === "tab").map((panel, i) => ({ title: plainTitle(String(labels[i] ?? "")) || `Tab ${i + 1}`, nodes: [panel], open: i === selected })));
      return;
    }
    // Callouts: marimo's and admonitions.
    if (!leaf && special && tag === "marimo-callout-output" && typeof props.html === "string") {
      const kind = typeof props.kind === "string" && TONES.has(props.kind) ? props.kind as CalloutTone : "neutral";
      const title = typeof props.title === "string" && props.title ? props.title : undefined;
      const body = nested(props.html, path);
      push(`html:${path}:${tag}:`, { kind: "text", text: [title, ...(body?.blocks?.map(block => block.output.text) ?? [])].filter(Boolean).join("\n"), container: { type: "callout", tone: kind, ...(title ? { title } : {}), ...(body ? { body } : {}) } });
      return;
    }
    if (!leaf && special && tag === "div" && classes(node).includes("admonition")) {
      const children = elementChildren(node);
      const titleNode = children.find(child => classes(child).includes("admonition-title"));
      const title = titleNode ? plainTitle(textContent(titleNode)) : undefined;
      const tone = ADMONITION_TONES[classes(node)[1] ?? ""] ?? "neutral";
      const body = nested(("childNodes" in node ? node.childNodes : []).filter(child => child !== titleNode), path);
      push(`html:${path}:${tag}:`, { kind: "text", text: [title, ...(body?.blocks?.map(block => block.output.text) ?? [])].filter(Boolean).join("\n"), container: { type: "callout", tone, ...(title ? { title } : {}), ...(body ? { body } : {}) } });
      return;
    }
    // Side-by-side prose.
    const row = tag === "div" && isFlexRow(node);
    if (!leaf && row && !noColumns && special) {
      const children = elementChildren(node);
      const direct = "childNodes" in node && node.childNodes.some(child => child.nodeName === "#text" && "value" in child && child.value.trim());
      if (children.length >= 2 && !direct && !children.some(hasComponent)) {
        const parts = children.map((child, i) => capture(child, `${path}.${i}`, path)).filter(part => part.text || part.markdown);
        if (parts.length >= 2) {
          push(`html:${path}:columns:`, { kind: "text", text: parts.map(part => part.text).join("\n\n"), markdown: parts.map(part => part.markdown).join("\n\n"), columns: parts.map(part => part.markdown) });
          return;
        }
      }
    }
    const here = row ? path : flexRow;
    if (!leaf && tag === "marimo-mermaid" && typeof props.diagram === "string") leaf = { kind: "chart", text: "[Mermaid]", mermaid: [props.diagram] };
    else if (tag === "pre") {
      const code = [...outputElements(node)].find(child => child.tagName === "code");
      const language = /(?:^|\s)language-([^\s]+)/u.exec(code?.attrs.find(a => a.name === "class")?.value ?? "")?.[1];
      leaf = { kind: "text", text: "", codeBlocks: [{ source: textContent(code ?? node), ...(language ? { language } : {}) }] };
    } else if (tag === "marimo-progress" || tag === "progress" || (tag === "table" && node.attrs.some(a => a.name === "class" && a.value.split(/\s/u).includes("pymc-progress-table")))) {
      const progress = progressFromNode(node);
      if (progress.length) leaf = { kind: "text", text: "", progress };
    } else if (tag === "marimo-table") {
      const parsed = marimoTable(markup());
      if (parsed) leaf = { kind: "table", text: rowCount(parsed.totalRows), ...(parsed.table ? { table: { ...parsed.table, ...(id ? { objectId: id } : {}) } } : {}) };
    } else if (tag === "table") {
      const table = htmlTable(markup());
      if (table) leaf = { kind: "table", text: rowCount(table.totalRows ?? table.rows.length), table };
    } else if (tag === "marimo-stat") {
      const stat = statOf(props);
      leaf = { kind: "text", text: [stat.label, stat.value, stat.caption].filter(Boolean).join(" "), stats: [stat], ...(here ? { statRow: here } : {}) };
    } else if (tag === "marimo-ui-element") {
      const widgets = parseWidgets(markup());
      if (widgets.length) leaf = { kind: "widgets", text: "", widgets };
    } else if (tag === "img") {
      const image = pngOf(node.attrs.find(a => a.name === "src")?.value ?? "");
      leaf = { kind: "image", text: "[image]", ...(image ? { image } : {}) };
    } else if (tag === "marimo-vega") {
      const vega = vegaOf(props.spec);
      if (vega) leaf = { kind: "chart", text: "[chart vega-lite]", vega };
    } else if (tag === "marimo-plotly" || tag === "iframe") {
      const plotly = plotlyFrom(markup());
      if (plotly) leaf = { kind: "chart", text: "[chart plotly]", plotly };
    }
    if (!leaf && ["marimo-plotly", "marimo-vega", "iframe", "svg", "canvas"].includes(tag)) leaf = { kind: "chart", text: "[interactive output: o opens the notebook]" };
    if (leaf) {
      if (leaf.progress) leaf.progress = leaf.progress.map(task => ({ ...task, id: blocks.some(block => block.output.progress?.some(previous => previous.id === task.id)) ? `${path}:${task.id}` : task.id }));
      push(`html:${path}:${tag}:${id ?? ""}`, leaf); return;
    }
    const children = () => { if ("childNodes" in node) node.childNodes.forEach((child, i) => visit(child, `${path}.${i}`, id, here)); };
    if (tag === "br") { residual = residual.replace(/[ \t\r\f]*$/gu, "") + "\n"; md += "\\\n"; return; }
    if (tag === "hr") { paragraph(); mdBreak(2); md += "---"; mdBreak(2); return; }
    if (tag === "code") {
      const code = textContent(node);
      residual += code;
      const longest = Math.max(0, ...(code.match(/`+/gu) ?? []).map(run => run.length));
      const fence = "`".repeat(longest + 1);
      md += code ? `${fence}${code.startsWith("`") || code.endsWith("`") ? ` ${code} ` : code}${fence}` : "";
      return;
    }
    if (tag === "a") {
      const href = attr(node, "href") ?? "";
      const inner = markdownOf(children);
      md += /^https?:\/\//iu.test(href) && inner.trim() ? `[${inner}](${href.replace(/\)/gu, "%29").replace(/\s/gu, "%20")})` : inner;
      return;
    }
    const mark = tag === "strong" || tag === "b" ? "**" : tag === "em" || tag === "i" ? "*" : tag === "del" || tag === "s" || tag === "strike" ? "~~" : "";
    if (mark) {
      const inner = markdownOf(children);
      const core = inner.trim();
      const lead = inner.slice(0, inner.length - inner.trimStart().length);
      const trail = inner.slice(inner.trimEnd().length);
      md += core ? `${lead}${mark}${core}${mark}${trail}` : inner;
      return;
    }
    const heading = /^h([1-6])$/u.exec(tag);
    if (heading) {
      paragraph(); mdBreak(2);
      const inner = markdownOf(children).replace(/\s*\n\s*/gu, " ").trim();
      md += `${"#".repeat(Number(heading[1]))} ${inner}`;
      paragraph(); mdBreak(2);
      return;
    }
    if (tag === "ul" || tag === "ol") {
      paragraph(); mdBreak(listItems ? 1 : 2);
      lists.push({ ordered: tag === "ol", n: Number(attr(node, "start")) || 1 });
      children();
      lists.pop();
      paragraph(); mdBreak(listItems ? 1 : 2);
      return;
    }
    if (tag === "li") {
      line();
      const list = lists.at(-1);
      const prefix = list?.ordered ? `${list.n++}. ` : "- ";
      listItems++;
      const inner = tidy(markdownOf(children));
      listItems--;
      md = ensureEnd(md, 1);
      md += `${prefix}${inner.split("\n").map((l, i) => i && l ? " ".repeat(prefix.length) + l : l).join("\n")}\n`;
      line();
      return;
    }
    if (tag === "blockquote") {
      paragraph(); mdBreak(2);
      const inner = tidy(markdownOf(children));
      md += inner.split("\n").map(l => l ? `> ${l}` : ">").join("\n");
      paragraph(); mdBreak(2);
      return;
    }
    const paragraphTag = PARAGRAPH_TAGS.test(tag) || (tag === "span" && classes(node).includes("paragraph"));
    const lineTag = LINE_TAGS.test(tag);
    if (paragraphTag) { paragraph(); mdBreak(2); } else if (lineTag) { line(); mdBreak(2); }
    children();
    if (paragraphTag) { paragraph(); mdBreak(2); } else if (lineTag) { line(); mdBreak(2); }
  };
  visit(parseOutputFragment(html), root, undefined); flush();
  if (!blocks.length) return undefined;
  // Stats of one flex row become one block of cards.
  for (let i = 0; i < blocks.length - 1;) {
    const a = blocks[i]!.output;
    const b = blocks[i + 1]!.output;
    if (a.stats && b.stats && a.statRow !== undefined && a.statRow === b.statRow) {
      a.stats = [...a.stats, ...b.stats];
      a.text = `${a.text} · ${b.text}`;
      blocks.splice(i + 1, 1);
    } else i++;
  }
  for (const block of blocks) delete block.output.statRow;
  const result: CellOutput = { ...(blocks.find(block => block.output.kind === "text" && block.output.text)?.output ?? blocks[0]!.output), blocks };
  const leaves = outputLeaves(result);
  for (const key of ["table", "image", "vega", "plotly"] as const) {
    const leaf = leaves.find(b => b[key] !== undefined);
    if (leaf) Object.assign(result, { [key]: leaf[key] });
  }
  for (const key of ["widgets", "progress", "codeBlocks", "mermaid"] as const) {
    const values = leaves.flatMap<unknown>(b => b[key] ?? []);
    if (values.length) Object.assign(result, { [key]: values });
  }
  return result;
}

/** A cell-op `output` as something to show, or undefined for an empty output (or an error: see Cell.error). */
export function summarizeOutput(raw: unknown): CellOutput | undefined {
  const output = record(raw);
  const mime = typeof output.mimetype === "string" ? output.mimetype : "";
  const data = output.data;
  if (output.channel === "marimo-error" || mime.includes("marimo+error")) return undefined;
  if (mime.includes("marimo+traceback") && typeof data === "string") return { kind: "text", text: clip(htmlToText(data)), severity: "error" };
  if (data === null || data === undefined || data === "") return undefined;
  // A mimebundle (matplotlib figures in marimo 0.25): the richest form the view can show.
  if (mime.includes("mimebundle")) {
    const bundle = typeof data === "string" ? (() => { try { return record(JSON.parse(data)); } catch { return {}; } })() : record(data);
    for (const kind of ["image/png", "application/vnd.vegalite.v5+json", "application/vnd.vegalite.v6+json", "application/vnd.vega.v5+json", "text/html", "image/svg+xml", "text/markdown", "text/plain"]) {
      if (bundle[kind] !== undefined && bundle[kind] !== null && bundle[kind] !== "") return summarizeOutput({ channel: output.channel, mimetype: kind, data: bundle[kind] });
    }
    return undefined;
  }
  if (mime.startsWith("image/")) {
    const image = mime === "image/png" && typeof data === "string" ? pngOf(data) : undefined;
    return { kind: "image", text: `[image ${mime.slice(6)}]`, ...(image ? { image } : {}) };
  }
  if (/vega|plotly|altair|bokeh/iu.test(mime)) {
    const vega = /vnd\.vega(?:lite)?\b/iu.test(mime) ? vegaOf(data) : undefined;
    return { kind: "chart", text: `[chart ${mime}]`, ...(vega ? { vega } : {}) };
  }
  // mo.md arrives as text/markdown whose data is already HTML.
  if (mime === "text/markdown" && typeof data === "string") return summarizeOutput({ ...output, mimetype: "text/html" });
  if (mime === "text/html" && typeof data === "string") {
    return orderedHtml(data);
  }
  if (typeof data === "string") {
    const severity = /^(error|critical|fatal)$/iu.test(String(output.level ?? "")) ? "error" : /\b\w*Warning:|\bWARNING\b/u.test(data) || output.level === "warning" ? "warning" : undefined;
    return { kind: "text", text: clip(data), ...(severity ? { severity } : {}) };
  }
  try {
    return { kind: "other", text: clip(JSON.stringify(data, null, 1) ?? "") };
  } catch {
    return { kind: "other", text: `[${mime || "output"}]` };
  }
}
