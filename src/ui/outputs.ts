// A cell's output and console as rows of the notebook view: text, a table's grid, an inline image
// (a PNG, or a Vega-Lite or Plotly chart drawn to one), or a live Plotly chart the mouse drives.
import { Image, getCapabilities, visibleWidth, sliceByColumn, foregroundAnsi, backgroundAnsi, indexedColor, rgbColor, styleTextWithAnsi } from "@earendil-works/pi-tui";
import type { Cell } from "../core/notebook.js";
import type { CellOutput, ConsoleLine } from "../core/output.js";
import type { MermaidAppearance, MermaidRenderer } from "../core/mermaid.js";
import { codePanelRows } from "./code.js";
import type { FrameTheme } from "../frame.ts";
import { liveGeometry } from "./live-charts.js";
import type { Row, RowOptions } from "./rows.js";
import { clean, oneLine } from "./text.js";
export { clean } from "./text.js";
import { progressRows } from "./progress.js";
import { tableGrid } from "./table.js";

/** The default indent of everything under a cell's line; the detail pane passes none. */
export const PAD = "      ";
/** Rows an inline image may take when the caller does not say; its width is the pane's. */
export const IMAGE_ROWS = 14;
/** An empty bar removes its separator too; omitted bars retain the caller's default tone. */
const outputPrefix = (opts: RowOptions, theme: FrameTheme, pad: string, tone: "accent" | "dim" | "warning" = "accent"): string =>
  `${pad}${opts.bar === "" ? "" : `${opts.bar ?? theme.fg(tone, "▍")} `}`;
/** The columns a picture may take: the pane's width less the visible output prefix. */
const imageCols = (opts: RowOptions, prefix: string): number => Math.max(10, (opts.width ?? 80) - visibleWidth(prefix));
// Table records, dtypes, summaries and status labels also cross the producer boundary.
function displayText<T>(value: T): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map(displayText) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), displayText(item)])) as T;
  return value;
}
const images = new WeakMap<CellOutput, { key: string; img: Image }>();
const diagramImages = new WeakMap<object, CellOutput>();

/** Only xterm-validated attributes generate terminal SGR; never forward producer bytes. */
export function consoleLineText(line: ConsoleLine, theme: FrameTheme): string {
  const text = clean(line.text);
  const fallback = line.severity === "error" ? "error" : line.stream === "stderr" ? "warning" : undefined;
  const plain = (s: string) => fallback ? theme.fg(fallback, s) : s;
  let column = 0;
  let result = "";
  const extent = line.cells?.length ? Math.max(...line.cells.map(cell => cell.column + cell.width)) : visibleWidth(text);
  const slice = (start: number, width: number): string => {
    if (!line.cells) return sliceByColumn(text, start, width, true);
    let at = start;
    let value = "";
    for (const cell of line.cells) {
      if (cell.column < start || cell.column >= start + width) continue;
      value += " ".repeat(Math.max(0, cell.column - at)) + clean(cell.text);
      at = cell.column + cell.width;
    }
    return value + " ".repeat(Math.max(0, Math.min(extent, start + width) - at));
  };
  const color = (value: number, mode: number, defaultColor: boolean, background: boolean): string => {
    if (defaultColor) return background ? "\x1b[49m" : "\x1b[39m";
    if (!Number.isInteger(value) || value < 0) return "";
    const ansi = background ? backgroundAnsi : foregroundAnsi;
    if (mode === 0x1000000 || mode === 0x2000000) return value <= 255 ? ansi(indexedColor(value), "truecolor") : "";
    if (mode === 0x3000000 && value <= 0xffffff) return ansi(rgbColor(value >> 16, (value >> 8) & 255, value & 255), "truecolor");
    return "";
  };
  for (const span of line.styles ?? []) {
    if (!Number.isInteger(span.column) || !Number.isInteger(span.width) || span.column < column || span.width < 1 || span.width > 2) continue;
    result += plain(slice(column, span.column - column));
    const chunk = slice(span.column, span.width);
    result += styleTextWithAnsi(span.fgDefault ? plain(chunk) : chunk, color(span.fg, span.fgMode, span.fgDefault, false), color(span.bg, span.bgMode, span.bgDefault, true), { bold: span.bold === true, italic: span.italic === true, underline: span.underline === true, inverse: span.inverse === true });
    column = span.column + span.width;
  }
  return result + plain(slice(column, Math.max(0, extent - column)));
}

/** An image output as rows: the first carries the terminal's image sequence, the rest are empty rows it covers. */
function inlineImage(output: CellOutput, theme: FrameTheme, pad: string, opts: RowOptions): Row[] | undefined {
  const maxRows = opts.imageRows ?? IMAGE_ROWS;
  if (maxRows < 2 || !output.image) return undefined;
  const bar = outputPrefix(opts, theme, pad);
  const cols = imageCols(opts, bar);
  // One Image per output and size: a resize or another pane width draws it anew.
  const key = `${cols}x${maxRows}`;
  let held = images.get(output);
  if (!held || held.key !== key) {
    held = { key, img: new Image(output.image.data, output.image.mime, { fallbackColor: (t) => theme.fg("dim", t) }, { maxWidthCells: cols, maxHeightCells: maxRows }) };
    images.set(output, held);
  }
  // Image reserves two surrounding columns internally; this adapter owns its prefix instead.
  const lines = held.img.render(cols + 2);
  if (!lines.some((l) => l.includes("\x1b_G"))) return undefined;
  const alt = `${bar}${theme.fg("dim", "[image png: scroll until it fits on screen]")}`;
  return lines.map((line, index) => ({ text: index === 0 ? `${bar}${line}` : bar.trimEnd(), image: { index, height: lines.length, alt } }));
}

export interface MermaidRowOptions extends RowOptions {
  blockId: string;
  renderer?: MermaidRenderer;
  appearance?: MermaidAppearance;
  showSource?: boolean;
}

/** Shared adapter for fences and mo.mermaid. Failed/unavailable images always retain every source line. */
export function mermaidRows(source: string, theme: FrameTheme, opts: MermaidRowOptions): Row[] {
  const pad = opts.pad ?? "";
  const sourceRows = () => codePanelRows(source.split("\t").map(clean).join("\t"), { ...opts, theme: opts.theme ?? theme, language: "mermaid" });
  let reason = "images unavailable in this terminal";
  if (getCapabilities().images && (opts.imageRows ?? IMAGE_ROWS) >= 2) {
    if (!opts.renderer) reason = "renderer unavailable";
    else {
      const state = opts.renderer.request(source, liveGeometry(imageCols(opts, outputPrefix(opts, theme, pad)), opts.imageRows ?? IMAGE_ROWS), opts.appearance ?? "light", opts.onReady ?? (() => undefined));
      if (state.status === "ready") {
        let output = diagramImages.get(state);
        if (!output) {
          output = { kind: "image", text: "[Mermaid]", image: { mime: "image/png", data: state.png } };
          diagramImages.set(state, output);
        }
        const rows = inlineImage(output, theme, pad, opts);
        if (rows) return [...rows.map(row => ({ ...row, blockId: opts.blockId })), ...(opts.showSource ? sourceRows() : [])];
        reason = "image cannot be displayed";
      } else reason = state.status === "rendering" ? "rendering…" : state.reason;
    }
  }
  return [{ text: `${pad}${theme.fg("dim", `Mermaid: ${clean(reason)}`)}`, blockId: opts.blockId }, ...sourceRows()];
}

/** The last `max` lines a cell printed. */
export function consoleRows(cell: Cell, theme: FrameTheme, max: number): Row[] {
  return (cell.console ?? []).slice(-max).map((l) => ({ text: `${PAD}${theme.fg("dim", "▍")} ${consoleLineText(l, theme)}` }));
}

/** A cell's output: an image or chart when the terminal draws them, a table's grid, else its text. */
export function outputRows(cell: Cell, theme: FrameTheme, opts: RowOptions, limits: { textLines: number; tableRows: number }, leaf?: CellOutput): Row[] {
  const out: Row[] = [];
  if (opts.showOutput === false) return out;
  const pad = opts.pad ?? PAD;
  const prefix = outputPrefix(opts, theme, pad);
  const push = (text: string) => out.push({ text });
  const output = leaf ?? cell.output;
  if (output?.blocks) {
    let widgetIndex = 0;
    return output.blocks.flatMap(block => {
      const indices = (block.output.widgets ?? []).map(() => widgetIndex++);
      const id = `${cell.id}:${block.id}`;
      const rendered = outputRows(cell, theme, { ...opts, blockPrefix: id }, limits, block.output);
      const widgets = indices.length ? opts.widgetRows?.(cell, indices) ?? [] : [];
      return [...rendered, ...widgets].map(row => ({ ...row, blockId: row.blockId ?? id, output: block.output, ...(block.output.table?.objectId ? { tableObjectId: block.output.table.objectId } : {}) }));
    });
  }
  if (output?.progress) return progressRows(output.progress.map(task => ({ ...task, id: `output:${task.id}` })), opts.width ?? 80, theme, Date.now());
  if (output?.mermaid) return output.mermaid.flatMap((source, index) => {
    const options = { ...opts, blockId: `${opts.blockPrefix ?? cell.id}:mermaid:${index}` };
    return opts.diagramRows?.(source, options) ?? mermaidRows(source, theme, options);
  });
  if (output?.codeBlocks) return output.codeBlocks.flatMap((block, index) => codePanelRows(block.source.split("\t").map(clean).join("\t"), { ...opts, theme: opts.theme ?? theme, language: block.language ? oneLine(block.language) : "text", header: !!block.language, blockId: `${opts.blockPrefix ?? cell.id}:pre:${index}` }));
  let chartNote: string | undefined;
  let whyStatic: string | undefined;
  if (output?.plotly) {
    const images = getCapabilities().images;
    if (!images) whyStatic = undefined;
    else if (!opts.live) whyStatic = "live charts are off";
    else if (images !== "kitty") whyStatic = `this terminal reports images=${String(images)}, live charts need kitty`;
    else if ((opts.imageRows ?? IMAGE_ROWS) < 4) whyStatic = "the view is too short";
  }
  if (output?.plotly && opts.live && getCapabilities().images && !whyStatic) {
    const geometry = liveGeometry(imageCols(opts, prefix), opts.imageRows ?? IMAGE_ROWS);
    const state = opts.live.state(output, output.plotly, geometry);
    if (state.status === "ready") {
      const bar = prefix;
      const alt = `${bar}${theme.fg("dim", "[chart: scroll until it fits on screen]")}`;
      const lines = opts.live.lines(state);
      out.push(...lines.map((line, index): Row => ({ text: index === 0 ? `${bar}${line}` : bar.trimEnd(), image: { index, height: lines.length, alt, live: { output, geometry: state.geometry } } })));
      return out;
    }
    if (state.status === "opening") chartNote = "[chart: starting…]";
    else whyStatic = `live chart failed: ${state.reason.slice(0, 120)}`;
  }
  if (whyStatic) push(`${outputPrefix(opts, theme, pad, "warning")}${theme.fg("warning", `static image (${clean(whyStatic)})`)}`);
  const chart = output?.vega ? { spec: output.vega, via: opts.vega } : output?.plotly ? { spec: output.plotly, via: opts.plotly } : undefined;
  if (output && chart?.via && !output.image && !(chartNote && output.plotly) && getCapabilities().images && (opts.imageRows ?? IMAGE_ROWS) >= 2) {
    const state = chart.via.request(chart.spec, opts.onVega ?? (() => undefined));
    if (state.status === "ready") output.image = { mime: "image/png", data: state.png };
    else chartNote = state.status === "rendering" ? "[chart: drawing…]" : `[chart: could not draw (${state.reason.slice(0, 80)}); o opens the notebook]`;
  }
  const inline = output?.image && getCapabilities().images ? inlineImage(output, theme, pad, opts) : undefined;
  if (inline) out.push(...inline);
  else if (output?.table) {
    const card = opts.tableCard?.(cell, output);
    if (card) return card.map(text => ({ text: `${prefix}${text}` }));
    const driven = opts.table?.(cell, output) ?? { data: output.table };
    const data = displayText(driven.data);
    const have = data.records?.length ? data.records.length : data.rows.length;
    if (!have && (data.dataRef || data.lazy)) push(`${prefix}${theme.fg("dim", "loading table…")}`);
    else {
      const grid = tableGrid(data, (opts.width ?? 80) - visibleWidth(prefix), theme, Math.min(limits.tableRows, Math.max(1, have)), displayText(driven.render));
      grid.lines.forEach((line, i) => out.push({ text: `${prefix}${line}`, ...(grid.rowAt[i] !== undefined ? { tableRow: grid.rowAt[i]! } : {}) }));
    }
  } else if (output && !(output.kind === "widgets" && !output.text)) {
    const text = clean(chartNote ?? output.text);
    const lines = text.split("\n");
    for (const line of lines.slice(0, limits.textLines)) push(`${prefix}${output.kind === "text" || output.kind === "other" ? line : theme.fg("dim", line)}`);
    if (lines.length > limits.textLines) push(`${outputPrefix(opts, theme, pad, "dim")}${theme.fg("dim", `… ${lines.length - limits.textLines} more lines`)}`);
  }
  return out;
}
