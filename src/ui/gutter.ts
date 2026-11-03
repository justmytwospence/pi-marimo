// The dataflow gutter: one column in the outline joining the selected cell to the cells it uses and the cells that use it.
import type { NotebookState } from "../core/notebook.js";
import type { FrameTheme } from "../frame.ts";

export interface GutterMark { glyph: string; color: "accent" | "success" | "dim" | undefined }

export const hasGraph = (nb: NotebookState): boolean => nb.declaredBy.size > 0;

/** Marks for rows `ids` (display order) around `cursor`: its direct parents ("accent") and children ("success"). */
export function gutterMarks(nb: NotebookState, cursor: string | undefined, ids: readonly string[]): Map<string, GutterMark> {
  const marks = new Map<string, GutterMark>();
  if (cursor === undefined) return marks;
  const at = ids.indexOf(cursor);
  if (at < 0) return marks;
  const up = new Set(nb.parents(cursor));
  const down = new Set(nb.children(cursor));
  const related = ids.map((id, i) => (up.has(id) || down.has(id) ? i : -1)).filter((i) => i >= 0);
  if (!related.length) return marks;
  const first = Math.min(at, ...related);
  const last = Math.max(at, ...related);
  for (let i = first; i <= last; i++) {
    const id = ids[i]!;
    if (id === cursor) marks.set(id, { glyph: "●", color: undefined });
    else if (up.has(id) || down.has(id)) marks.set(id, { glyph: i === first ? "┌" : i === last ? "└" : "├", color: up.has(id) ? "accent" : "success" });
    else marks.set(id, { glyph: "│", color: "dim" });
  }
  return marks;
}

/** One column: a space without a mark. */
export function gutterText(theme: FrameTheme, mark: GutterMark | undefined, cursorHere: boolean): string {
  if (!mark) return " ";
  if (cursorHere) return theme.bold(mark.glyph);
  return mark.color ? theme.fg(mark.color, mark.glyph) : mark.glyph;
}
