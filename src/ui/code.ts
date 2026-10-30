import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Row, RowOptions } from "./rows.js";

export interface CodeBlockState { offset: number }
export interface CodeOptions extends RowOptions {
  language?: string;
  blockId?: string;
  state?: CodeBlockState;
  folded?: boolean;
  previewLines?: number;
  header?: boolean;
}
export function scrollCode(state: CodeBlockState, delta: number, maxColumns: number): void {
  state.offset = Math.max(0, Math.min(Math.max(0, maxColumns), Math.floor((Number.isFinite(state.offset) ? state.offset : 0) + delta)));
}
/** Expand display tabs without changing source or counting ANSI control bytes as columns. */
export function expandTabs(line: string, tabstop: number): string {
  let result = "";
  let index = 0;
  for (const piece of line.split("\t")) {
    if (index++) result += " ".repeat(tabstop - visibleWidth(result) % tabstop);
    result += piece;
  }
  return result;
}
export function codeRows(source: string, options: CodeOptions = {}): Row[] {
  const id = options.blockId ?? "code";
  const sourceLines = source.split("\n");
  const tabstop = Math.max(1, Math.min(16, options.tabstop ?? 4));
  const highlighted = options.syntax && options.theme ? options.syntax.request(source, options.language ?? "python", options.theme, options.onReady) : sourceLines;
  const lines = highlighted.map(line => expandTabs(line, tabstop));
  const gutter = options.lineNumbers ? String(sourceLines.length).length + 1 : 0;
  const width = Math.max(0, (options.width ?? 80) - gutter);
  const maximum = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0) - width;
  const state = options.state ?? options.codeOffsets?.get(id) ?? { offset: 0 };
  scrollCode(state, 0, maximum);
  options.codeOffsets?.set(id, state);
  const rows: Row[] = [];
  if (options.header !== false) rows.push({ text: sliceByColumn(`${options.folded ? "▸" : "▾"} ${options.language ?? "code"}${state.offset ? " ←" : ""}${maximum > state.offset ? " →" : ""}`, 0, options.width ?? 80), blockId: id, code: true });
  const count = options.folded ? Math.min(lines.length, options.previewLines ?? 3) : lines.length;
  for (let i = 0; i < count; i++) rows.push({ text: (gutter ? `${String(i + 1).padStart(gutter - 1)} ` : "") + sliceByColumn(lines[i]!, state.offset, width, true), blockId: id, sourceLine: i, code: true });
  return rows;
}
