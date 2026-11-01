// What a cell printed, kept compact for the notebook view (never for the agent's snapshot): the
// last output as text (HTML stripped, images named), its table's first page and its widgets, and
// the current terminal console display.
import { serializeOuter } from "parse5";
import type { OutputNode } from "./html.js";
import { progressFromNode, type ProgressTask } from "./progress.js";
import { componentProps, outputElements, parseOutputFragment, textContent } from "./html.js";

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

export interface CellOutput {
  kind: OutputKind;
  text: string;
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
  const body = (header ? rows.slice(1) : rows).slice(0, MAX_TABLE_ROWS);
  if (!body.length) return undefined;
  const width = Math.max(header?.cells.length ?? 0, ...body.map((r) => r.cells.length));
  const columns = Array.from({ length: width }, (_, i) => header?.cells[i] ?? `col ${i + 1}`);
  const cells = body.map((r) => Array.from({ length: width }, (_, i) => r.cells[i] ?? ""));
  return {
    columns,
    numeric: columns.map((_, i) => cells.some((r) => r[i]) && cells.every((r) => !r[i] || NUMBER.test(r[i]!))),
    rows: cells,
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

function orderedHtml(html: string): CellOutput | undefined {
  const blocks: NonNullable<CellOutput["blocks"]> = [];
  let residual = "";
  const flush = () => {
    const text = residual.replace(/\n{3,}/gu, "\n\n").trim();
    if (text) blocks.push({ id: `html:text:${blocks.length}`, output: { kind: "text", text: clip(text) } });
    residual = "";
  };
  const newline = () => { residual = residual.replace(/[ \t\r\f]*$/gu, "") + "\n"; };
  const visit = (node: OutputNode, path: string, objectId?: string) => {
    if (node.nodeName === "#text" && "value" in node) {
      const text = node.value.replace(/[ \t\r\n\f]+/gu, " ");
      residual += residual.endsWith("\n") ? text.replace(/^ /u, "") : text;
      return;
    }
    if (!("tagName" in node)) {
      if ("childNodes" in node) node.childNodes.forEach((child, i) => visit(child, `${path}.${i}`, objectId));
      return;
    }
    const tag = node.tagName;
    if (["script", "style", "template"].includes(tag)) return;
    const id = node.attrs.find(a => a.name === "object-id")?.value ?? objectId;
    const props = componentProps(node);
    const markup = () => serializeOuter(node).replace(/="([^"]*)"/gu, (_, value: string) => `="${value.replace(/>/gu, "&gt;").replace(/</gu, "&lt;")}"`);
    let leaf: OutputLeaf | undefined;
    if (tag === "marimo-mermaid" && typeof props.diagram === "string") leaf = { kind: "chart", text: "[Mermaid]", mermaid: [props.diagram] };
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
      if (table) leaf = { kind: "table", text: rowCount(table.rows.length), table };
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
      flush(); blocks.push({ id: `html:${path}:${tag}:${id ?? ""}`, output: leaf }); return;
    }
    const boundary = /^(?:p|div|li|h[1-6]|ul|ol|section|blockquote)$/u.test(tag);
    if (boundary || tag === "br") newline();
    if (tag !== "br") node.childNodes.forEach((child, i) => visit(child, `${path}.${i}`, id));
    if (boundary) newline();
  };
  visit(parseOutputFragment(html), "0"); flush();
  if (!blocks.length) return undefined;
  const result: CellOutput = { ...(blocks.find(block => block.output.kind === "text" && block.output.text)?.output ?? blocks[0]!.output), blocks };
  for (const key of ["table", "image", "vega", "plotly"] as const) {
    const leaf = blocks.find(b => b.output[key] !== undefined)?.output;
    if (leaf) Object.assign(result, { [key]: leaf[key] });
  }
  for (const key of ["widgets", "progress", "codeBlocks", "mermaid"] as const) {
    const values = blocks.flatMap<unknown>(b => b.output[key] ?? []);
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
