// What the notebook view's panes share: its row type, the highlight, markdown and diff helpers, and
// which cells the cursor can stand on and which a fold hides. The outline is outline.ts, the
// selected cell's detail detail.ts.
import { generateDiffString, renderDiff } from "@earendil-works/pi-coding-agent";
import { sliceByColumn } from "@earendil-works/pi-tui";
import type { SyntaxHighlighter, SyntaxTheme } from "./syntax.js";
import type { CodeBlockState } from "./code.js";
import { markdownRows } from "./markdown.js";
import type { Geometry } from "../core/live.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import type { CellOutput, TableData } from "../core/output.js";
import type { ChartRenderer, VegaRenderer } from "../core/vega.js";
import type { LiveCharts } from "./live-charts.js";
import type { TableRender } from "./table.js";

/** Widgets listed under a cell, at most. */
export const MAX_WIDGETS = 8;

/** One display line. The first line of a cell in the outline carries its id (the cursor can stand there); a widget's line, its place. */
export interface Row {
  text: string;
  blockId?: string;
  sourceLine?: number;
  editorRow?: number;
  package?: string;
  progress?: { id: string };
  cell?: string;
  /** A source panel row, which a click opens or folds. */
  code?: boolean;
  widget?: { cell: string; index: number };
  /** A part separator or content row in the detail (its index in the parts list). */
  part?: number;
  /** A body row of a table grid: its index within the page. */
  tableRow?: number;
  tableObjectId?: string;
  output?: CellOutput;
  /** A line of the variables pane. */
  variable?: string;
  /** One line of an inline image: its place in the block, the block's height, and what shows when the block is not fully on screen. */
  image?: { index: number; height: number; alt: string; live?: { output: CellOutput; geometry: Geometry } };
}

export interface RowOptions {
  syntax?: SyntaxHighlighter;
  theme?: SyntaxTheme;
  onReady?: () => void;
  lineNumbers?: boolean;
  tabstop?: number;
  codeOffsets?: Map<string, CodeBlockState>;
  /** Stable cell/output namespace for extracted block IDs. */
  blockPrefix?: string;
  diagnostics?: "all" | "errors" | "warnings" | "none";
  showOutput?: boolean;
  /** Diagram image adapter; source fallback is provided when absent. */
  diagramRows?: (source: string, options: RowOptions & { blockId: string }) => Row[];
  /** Draw image outputs inline with at most this many rows (default: when the terminal shows images, 14; 0 never). */
  imageRows?: number;
  /** The width the pane draws at, for sizing images, tables and prose. */
  width?: number;
  /** The indent of an output's rows (default: six spaces; the detail pane has none). */
  pad?: string;
  /** The bar at the start of an output's rows (default: an accent `▍`); the detail dims it, or marks the focused part. */
  bar?: string;
  /** Turns Vega-Lite chart outputs into images; `onVega` runs when one finishes. */
  vega?: VegaRenderer;
  plotly?: ChartRenderer;
  /** Runs charts live in a browser page the mouse can drive; a chart it cannot run falls back to the static image. */
  live?: LiveCharts;
  onVega?: () => void;
  /** The marimo table behind a cell's output, as the view drives it (its current page and cursor), when it does. */
  widgetRows?: (cell: Cell, indices: number[]) => Row[];
  /** A card for this particular table leaf, when focused. */
  tableCard?: (cell: Cell, output?: CellOutput) => string[] | undefined;
  table?: (cell: Cell, output?: CellOutput) => { data: TableData; render?: TableRender; /** What the table's label adds: `sorted by cups`. */ note?: string } | undefined;
}

export const firstLine = (code: string) => code.split("\n").find((l) => l.trim())?.trim() ?? "";

/** Python highlighted with Pi's theme; plain where there is none (Pi's theme is set up only in Pi). */
export function safeHighlight(code: string, options: RowOptions = {}): string[] {
  return [...(options.syntax && options.theme ? options.syntax.request(code, "python", options.theme, options.onReady) : code.split("\n"))];
}

/** Markdown rendered with Pi's markdown theme, plain where there is none. */
export function safeMarkdown(text: string, width: number): string[] {
  return markdownRows(text, { width }).map(row => row.text);
}

/** The agent's change to a cell as Pi draws an edit's diff; plain without Pi's theme. */
export function diffLines(before: string, after: string, options?: { width: number; offset?: number }): string[] {
  const viewport = (lines: string[]) => options ? lines.map(line => sliceByColumn(line, options.offset ?? 0, options.width, true)) : lines;
  let diff: string;
  try {
    diff = generateDiffString(before, after, 2).diff;
  } catch {
    return viewport(after.split("\n"));
  }
  try {
    return viewport(renderDiff(diff).split("\n"));
  } catch {
    return viewport(diff.split("\n"));
  }
}

/** The level of a cell's section (its highest heading), or undefined without headings. */
export function sectionLevel(nb: NotebookState, cell: Cell): number | undefined {
  const headings = nb.headings(cell);
  return headings.length ? Math.min(...headings.map((h) => h.level)) : undefined;
}

/** The cells a folded section hides, each with the cell that heads the fold. */
export function foldedCells(nb: NotebookState, folded: ReadonlySet<string>): Map<string, string> {
  const hidden = new Map<string, string>();
  if (!folded.size) return hidden;
  let open: { level: number; head: string } | undefined;
  for (const cell of nb.ordered()) {
    const level = sectionLevel(nb, cell);
    if (open) {
      if (level !== undefined && level <= open.level) open = undefined;
      else {
        hidden.set(cell.id, open.head);
        continue;
      }
    }
    if (level !== undefined && folded.has(cell.id)) open = { level, head: cell.id };
  }
  return hidden;
}

/**
 * The cells the cursor can stand on: code cells, and markdown cells with headings; with a filter,
 * those matching it (name, id, variables, code, error). Folded sections hide their cells, except
 * while filtering.
 */
export function selectableCells(nb: NotebookState, filter = "", o: { folded?: ReadonlySet<string> } = {}): Cell[] {
  const q = filter.trim().toLowerCase();
  const hidden = q ? new Map<string, string>() : foldedCells(nb, o.folded ?? new Set());
  return nb.ordered().filter((c) => {
    if (hidden.has(c.id)) return false;
    if (nb.isMarkdown(c) && !q && !nb.headings(c).length) return false;
    if (!q) return true;
    return [c.name, c.id, ...(nb.defs.get(c.id) ?? []), c.code, c.error ?? ""].some((t) => t.toLowerCase().includes(q));
  });
}
