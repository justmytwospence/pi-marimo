// The detail: the notebook view's right pane, the selected cell as a reader wants it. Prose is
// rendered, the output is large, an error comes with its traceback, the code is folded (B opens
// it) and the dataflow is named by variable. In section view (`O`) it is the whole section stacked
// as a document, the selected cell marked. No cell ids and no Python reprs: values are in the
// variables pane.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { editableMarkdown } from "../core/markdown.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import { truncate } from "../core/notebook.js";
import { duration, runTime } from "./time.js";
import { progressRows } from "./progress.js";
import type { FrameTheme } from "../frame.ts";
import { clean, consoleLineText, outputRows } from "./outputs.js";
import { type PaneTheme, cellGlyph, headingText, spinner } from "./outline.js";
import { MAX_WIDGETS, type Row, type RowOptions, diffLines } from "./rows.js";
import { codeRows } from "./code.js";
import { markdownRows } from "./markdown.js";
import { cellTitle, sectionOf } from "./titles.js";
import { oneLine } from "./text.js";
import { widgetLine, widgetValue } from "./widgets.js";

/** A focusable piece of the detail: what `n` and `p` walk and Enter acts on. */
export interface Part {
  kind: "error" | "printed" | "output" | "table" | "chart" | "widgets" | "code" | "markdown";
  cell: string;
  /** Its row in the detail. */
  row: number;
  tableObjectId?: string;
  /** Flat cell widget indices belonging to this ordered leaf. */
  widgetIndices?: number[];
  output?: import("../core/output.js").CellOutput;
}

export interface DetailOptions extends RowOptions {
  /** The selected cell. */
  cell: Cell;
  width: number;
  /** The selected cell's code shows (instead of `▸ code · N lines`). */
  codeOpen: boolean;
  /** Explicitly opened cells in section mode (ordinary reading stays output-first). */
  sectionCodeOpen?: ReadonlySet<string>;
  /** The code shows as the agent's diff. */
  diff: boolean;
  /** The whole section, stacked, instead of the cell. */
  section: boolean;
  /** The widget the keys drive, and its sub-position. */
  widgetFocus?: { cell: string; index: number; sub: number } | undefined;
  highlight?: (code: string) => string[];
  markdown?: (text: string, width: number) => string[];
  /** The focused part (an index into the returned `parts`). */
  partFocus?: number | undefined;
  /** Replace only the selected editable part, at its ordinary document location. */
  inlineEditor?: { cellId: string; kind: "python" | "markdown"; rows(width: number, row: number): Row[] };
}

const safeWidgetValue = (value: unknown): unknown => typeof value === "string" ? oneLine(value)
  : Array.isArray(value) ? value.map(safeWidgetValue)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [oneLine(key), safeWidgetValue(item)])) : value;

/** `left` and `right` on one line of `width`, the right one flush right. */
function sides(left: string, right: string, width: number): string {
  const rw = visibleWidth(right);
  const cut = truncateToWidth(left, Math.max(1, width - rw - (rw ? 1 : 0)), "…");
  return `${cut}${" ".repeat(Math.max(rw ? 1 : 0, width - visibleWidth(cut) - rw))}${right}`;
}

export function detailRows(nb: NotebookState, theme: FrameTheme, now: number, o: DetailOptions): { rows: Row[]; widgetRows: Map<string, number>; focusRow?: number; parts: Part[] } {
  const rows: Row[] = [];
  const widgetRows = new Map<string, number>();
  const width = Math.max(10, o.width);
  // A chart takes the pane's width, and as much of its height as fits under the title (a section shares it).
  const page = o.imageRows ?? 14;
  const sub: RowOptions = { ...o, pad: "", width, imageRows: Math.max(2, o.section ? Math.min(page - 4, Math.floor(page * 0.6)) : page - 4) };
  const push = (text: string) => rows.push({ text });
  const dim = (text: string) => theme.fg("dim", text);
  const parts: Part[] = [];

  /**
   * A part of a cell (its error, what it printed, its output, its widgets, its code): no label, its rows
   * share the pane's full body width. A short label marks the part without a per-row gutter.
   */
  const part = (kind: Part["kind"], cell: Cell) => {
    const index = parts.length;
    const focused = o.partFocus === index;
    parts.push({ kind, cell: cell.id, row: rows.length });
    let label = focused ? theme.bold(theme.fg("accent", kind)) : dim(kind);
    if (focused && (theme as PaneTheme).bg) label = (theme as PaneTheme).bg!("toolPendingBg", label);
    rows.push({ text: label, part: index });
    const add = (text: string, extra: Partial<Row> = {}) => rows.push({ text, part: index, ...extra });
    return { index, focused, add };
  };

  const leafParts = new Map<object, number>();
  const appendRendered = (r: Row, fallback: number, cell: Cell) => {
    let index = fallback;
    if (r.output) {
      const held = leafParts.get(r.output);
      if (held !== undefined) index = held;
      else {
        const kind: Part["kind"] = r.output.table ? "table" : r.widget ? "widgets" : r.output.kind === "chart" || r.output.kind === "image" ? "chart" : "output";
        index = part(kind, cell).index;
        Object.assign(parts[index]!, { output: r.output, ...(r.tableObjectId ? { tableObjectId: r.tableObjectId } : {}) });
        leafParts.set(r.output, index);
      }
    }
    rows.push({ ...r, part: index });
    if (r.widget) {
      const indices = parts[index]!.widgetIndices ??= [];
      if (!indices.includes(r.widget.index)) indices.push(r.widget.index);
      widgetRows.set(`${r.widget.cell}\0${r.widget.index}`, rows.length - 1);
    }
  };

  /** A markdown cell as prose, trailing blank lines dropped. */
  const proseOf = (cell: Cell, w = width): Row[] => {
    if (o.inlineEditor?.cellId === cell.id && o.inlineEditor.kind === "markdown") return o.inlineEditor.rows(w, rows.length);
    const md = editableMarkdown(cell.code);
    const lines: Row[] = md !== undefined ? (o.markdown ? o.markdown(md.split("\t").map(clean).join("\t"), w).map(text => ({ text })) : markdownRows(md.split("\t").map(clean).join("\t"), { ...sub, width: w, blockPrefix: cell.id })) : o.showOutput !== false && cell.output ? outputRows(cell, theme, { ...sub, width: w, bar: "", widgetRows: orderedWidgets }, { textLines: Infinity, tableRows: 50 }) : nb.headings(cell).map((h) => ({ text: headingText(theme, { ...h, text: oneLine(h.text) }) }));
    while (lines.length && !lines.at(-1)!.text.trim() && !lines.at(-1)!.blockId) lines.pop();
    return lines.length ? lines : [{ text: dim("(empty markdown)") }];
  };

  const orderedWidgets = (cell: Cell, indices: number[]): Row[] => indices.map(index => {
    const w = cell.output!.widgets![index]!;
    const focused = o.widgetFocus?.cell === cell.id && o.widgetFocus.index === index;
    const safe = { ...w, label: oneLine(w.label), tag: oneLine(w.tag), options: w.options.map(oneLine) };
    const value = widgetValue(nb, w);
    const safeValue = safeWidgetValue(value);
    return { text: `${focused ? theme.fg("accent", "▸") : dim("◆")} ${widgetLine(safe, safeValue, focused ? { sub: o.widgetFocus!.sub } : undefined, theme)}`, widget: { cell: cell.id, index } };
  });

  /** The widgets of a cell's output, focusable. */
  const widgetBlock = (cell: Cell) => {
    const widgets = cell.output?.widgets ?? [];
    if (!widgets.length) return;
    const p = part("widgets", cell);
    widgets.slice(0, MAX_WIDGETS).forEach((w, index) => {
      const focused = o.widgetFocus?.cell === cell.id && o.widgetFocus.index === index;
      widgetRows.set(`${cell.id}\0${index}`, rows.length);
      // `WIDGET_TEXT` columns before the control's own text: the glyph and a space.
      p.add(`${focused ? theme.fg("accent", "▸") : dim("◆")} ${widgetLine({ ...w, label: oneLine(w.label), options: w.options.map(oneLine) }, safeWidgetValue(widgetValue(nb, w)), focused ? { sub: o.widgetFocus!.sub } : undefined, theme)}`, { widget: { cell: cell.id, index } });
    });
    if (widgets.length > MAX_WIDGETS) p.add(`${dim(`… ${widgets.length - MAX_WIDGETS} more widgets: o opens the notebook`)}`);
  };

  /**
   * Complete source through the shared horizontal viewport; folding is an explicit preview.
   */
  const codeBlock = (cell: Cell, open: boolean, diff: boolean) => {
    const p = part("code", cell);
    if (o.inlineEditor?.cellId === cell.id && o.inlineEditor.kind === "python") {
      for (const r of o.inlineEditor.rows(width, rows.length)) rows.push({ ...r, part: p.index });
      return;
    }
    const blockId = `${cell.id}:source`;
    const change = nb.agentChanges.get(cell.id);
    if (diff && change) {
      const offset = o.codeOffsets?.get(blockId)?.offset ?? 0;
      for (const text of diffLines(change.before, cell.code, { width, offset })) p.add(text, { code: true, blockId });
    } else {
      const bg = (theme as PaneTheme).bg?.bind(theme);
      const inset = 2;
      const fill = (text: string) => bg ? bg("toolPendingBg", text + " ".repeat(Math.max(0, width - visibleWidth(text)))) : text;
      const source = codeRows(cell.code, { ...sub, width: Math.max(1, width - inset * 2), blockId, language: "python", folded: !open });
      const header = fill(source[0]!.text);
      p.add(header, { ...source[0], text: header });
      p.add(fill(""), { code: true, blockId });
      for (const r of source.slice(1)) {
        const text = fill(`${" ".repeat(inset)}${r.text}`);
        p.add(text, { ...r, text });
      }
      p.add(fill(""), { code: true, blockId });
    }
  };

  const statusOf = (cell: Cell): string => {
    const parts: string[] = [];
    if (cell.status === "idle" && cell.lastRunMs !== undefined && (o.section || nb.isMarkdown(cell))) parts.push(dim(`${cell.lastRunEndedAt !== undefined ? `ran ${runTime(cell.lastRunEndedAt, now)} · ` : ""}${duration(cell.lastRunMs)}`));
    if (cell.status === "running") parts.push(theme.bold(theme.fg("accent", `${spinner(now)} running${cell.runningSince !== undefined ? ` ${duration(now - cell.runningSince)}` : ""}`)));
    else if (cell.status === "queued") parts.push(theme.fg("accent", "◌ queued"));
    if (cell.blocked) parts.push(theme.fg("error", "not run: an ancestor failed"));
    if (cell.disabled) parts.push(dim("disabled"));
    if (cell.stale) parts.push(theme.fg("warning", "stale"));
    if (nb.edited(cell)) parts.push(theme.fg("warning", "edited, not rerun"));
    const change = nb.agentChanges.get(cell.id);
    if (change && change.kind !== "deleted") parts.push(theme.fg("accent", change.kind === "created" ? "new from the agent" : "changed by the agent"));
    if (o.diagnostics && o.diagnostics !== "all") parts.push(dim(`diagnostics ${o.diagnostics === "none" ? "hidden" : o.diagnostics}`));
    if (o.showOutput === false) parts.push(dim("output hidden"));
    return parts.join(dim(" · "));
  };

  const lensOf = (cell: Cell): string[] =>
    nb.lens.selections().filter((s) => s.cells.includes(cell.id)).map((s) => `${theme.fg("warning", oneLine(s.label))} ${s.note ? truncate(oneLine(s.note), 200) : dim(oneLine(s.what ?? "(no note)"))}`);

  /** Error, traceback, what it printed, and the output. */
  const resultBlock = (cell: Cell, limits: { textLines: number; tableRows: number }, printed: number, literal = false) => {
    const lines = cell.console ?? [];
    const diagnostics = o.diagnostics ?? "all";
    const errors = diagnostics === "all" || diagnostics === "errors";
    const warnings = diagnostics === "all" || diagnostics === "warnings";
    const diagnosticLines = lines.filter(x => x.severity === "error" ? errors : (x.severity === "warning" || (x.stream === "stderr" && x.severity !== "progress")) && warnings);
    if ((cell.error && errors) || diagnosticLines.length) {
      const p = part("error", cell);
      if (cell.error && errors) p.add(`${theme.fg("error", truncate(clean(cell.error), 300))}`);
      for (const l of diagnosticLines) p.add(consoleLineText(l, theme));
    }
    rows.push(...progressRows((cell.progress ?? []).filter(task => o.showOutput === false ? task.state !== "complete" : !task.id.startsWith("output:")), width, theme, now));
    const diagnosticOutput = cell.output?.severity;
    if (diagnosticOutput) {
      if (diagnosticOutput === "error" ? errors : warnings) {
        const p = part("error", cell);
        for (const r of outputRows(cell, theme, { ...sub, bar: "", showOutput: true }, limits)) rows.push({ ...r, part: p.index });
      }
    }
    if (o.showOutput === false || literal) return;
    const stdout = lines.filter((x) => x.stream === "stdout" && (!x.severity || x.severity === "output"));
    if (stdout.length) {
      const p = part("printed", cell);
      for (const l of stdout.slice(-printed)) p.add(consoleLineText(l, theme));
    }
    if (diagnosticOutput) return;
    const output = cell.output;
    const kind: Part["kind"] = output?.table ? "table" : output?.kind === "image" || output?.kind === "chart" ? "chart" : "output";
    // A part is only taken when the output has rows of its own; it would be the next one.
    const card = !output?.blocks && output?.table ? o.tableCard?.(cell, output) : undefined;
    const shown = card ? card.map((text): Row => ({ text })) : outputRows(cell, theme, { ...sub, bar: "", widgetRows: orderedWidgets }, limits);
    if (output && shown.length) {
      const p = output.blocks ? undefined : part(kind, cell);
      for (const r of shown) appendRendered(r, p?.index ?? parts.length, cell);
    }
    if (!output?.blocks) widgetBlock(cell);
  };

  if (o.section) {
    const cells = nb.ordered();
    const at = Math.max(0, cells.findIndex((c) => c.id === o.cell.id));
    let start = at;
    while (start > 0 && !nb.headings(cells[start]!).length) start--;
    if (!nb.headings(cells[start]!).length) start = 0;
    let end = start + 1;
    while (end < cells.length && !nb.headings(cells[end]!).length) end++;
    let focusRow: number | undefined;
    for (const cell of cells.slice(start, end)) {
      const selected = cell.id === o.cell.id;
      if (rows.length) push("");
      if (selected) focusRow = rows.length;
      if (nb.isMarkdown(cell)) {
        const p = part("markdown", cell);
        proseOf(cell).forEach(r => appendRendered(r, p.index, cell));
        const status = statusOf(cell);
        if (status) push(status);
        resultBlock(cell, { textLines: 12, tableRows: 10 }, 5, true);
        if (o.sectionCodeOpen?.has(cell.id) || (o.inlineEditor?.cellId === cell.id && o.inlineEditor.kind === "python")) codeBlock(cell, true, selected && o.diff);
        continue;
      }
      push(`${selected ? theme.fg("accent", "▌") : " "}${cellGlyph(nb, theme, cell, now)} ${selected ? theme.bold(oneLine(cellTitle(nb, cell))) : dim(oneLine(cellTitle(nb, cell)))}`);
      const status = statusOf(cell);
      if (status) push(status);
      resultBlock(cell, { textLines: 12, tableRows: 10 }, 5);
      if (o.sectionCodeOpen?.has(cell.id) || (o.inlineEditor?.cellId === cell.id && o.inlineEditor.kind === "python")) codeBlock(cell, true, selected && o.diff);
    }
    return { rows, widgetRows, parts, ...(focusRow !== undefined ? { focusRow } : {}) };
  }

  const cell = o.cell;
  if (nb.isMarkdown(cell)) {
    /** Markdown uses exactly the same body width as source and outputs. */
    const prose = (c: Cell) => {
      const p = part("markdown", c);
      for (const r of proseOf(c)) appendRendered(r, p.index, c);
      const status = statusOf(c);
      if (status) push(status);
      resultBlock(c, { textLines: 40, tableRows: 20 }, 20, true);
    };
    prose(cell);
    const cells = nb.ordered();
    for (let i = cells.findIndex((c) => c.id === cell.id) + 1; i > 0 && i < cells.length; i++) {
      const next = cells[i]!;
      if (!nb.isMarkdown(next) || nb.headings(next).length) break;
      push("");
      prose(next);
    }
    if (editableMarkdown(cell.code) === undefined || (o.inlineEditor?.cellId === cell.id && o.inlineEditor.kind === "python")) {
      push("");
      codeBlock(cell, o.codeOpen, false);
    }
    return { rows, widgetRows, parts };
  }

  const title = oneLine(cellTitle(nb, cell));
  const where = oneLine(sectionOf(nb, cell.id).join(" › "));
  const ran = cell.status === "idle" && cell.lastRunMs !== undefined ? dim(`${cell.lastRunEndedAt !== undefined ? `ran ${runTime(cell.lastRunEndedAt, now)} · ` : ""}${duration(cell.lastRunMs)}`) : "";
  push(sides(`${theme.bold(title)}${where ? dim(` · ${where}`) : ""}`, ran, width));
  const status = statusOf(cell);
  if (status) push(status);
  for (const line of lensOf(cell)) push(line);
  push("");
  const before = rows.length;
  resultBlock(cell, { textLines: 40, tableRows: 20 }, 20);
  if (rows.length === before && !cell.error) push(dim(cell.status === "idle" && !cell.lastRunCode ? "(not run)" : "(no output)"));
  push("");
  codeBlock(cell, o.codeOpen, o.diff);
  const uses = nb.uses(cell.id);
  // Prose cells use `mo` and the like; they are no one's dataflow, and an imports cell has no story to tell.
  const users = title === "imports" ? [] : nb.children(cell.id).map((id) => nb.cells.get(id)).filter((c): c is Cell => !!c && !nb.isMarkdown(c)).map((c) => cellTitle(nb, c));
  const flow = [uses.length ? `uses ${truncate(uses.join(", "), 100)}` : "", users.length ? `used by ${truncate(users.join(", "), 100)}` : ""].filter(Boolean);
  if (flow.length) {
    push("");
    push(dim(flow.join(" · ")));
  }
  return { rows, widgetRows, parts };
}
