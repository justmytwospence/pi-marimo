// Variable values are marimo's supplied repr, never an object-evaluation interface.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { NotebookState } from "../core/notebook.js";
import type { FrameTheme } from "../frame.ts";
import type { Row } from "./rows.js";
import { cellTitle } from "./titles.js";

export interface VariableRow {
  name: string;
  datatype: string;
  value: string;
  definedBy?: string;
  usedBy: string[];
}
export type VariableSort = "name" | "type" | "definition";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function variableList(nb: NotebookState, filter = "", sort: VariableSort = "name"): VariableRow[] {
  const q = filter.trim().toLowerCase();
  const index = new Map(nb.order.map((id, i) => [id, i]));
  return [...nb.declaredBy].map(([name, cells]) => {
    const v = nb.values.get(name);
    return { name, datatype: v?.datatype ?? "", value: v?.value ?? "", ...(cells[0] ? { definedBy: cells[0] } : {}), usedBy: [...new Set(nb.usedBy.get(name) ?? [])] };
  }).filter(v => !q || [v.name, v.datatype, v.value].some(t => t.toLowerCase().includes(q)))
    .sort((a, b) => (sort === "type" ? compare(a.datatype, b.datatype) : sort === "definition" ? (index.get(a.definedBy ?? "") ?? Infinity) - (index.get(b.definedBy ?? "") ?? Infinity) : 0) || compare(a.name, b.name));
}
const fit = (text: string, width: number): string => {
  const cut = truncateToWidth(text.replace(/\n/g, "↵"), Math.max(0, width), "…");
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
};
export function variableRows(list: VariableRow[], nb: NotebookState, theme: FrameTheme, cursor: string | undefined, width: number, filter = ""): { rows: Row[]; index: Map<string, number> } {
  const index = new Map<string, number>();
  if (!list.length) return { rows: [{ text: theme.fg("dim", filter.trim() ? `No variable matches "${filter}".` : "No variables yet: run cells first.") }], index };
  const wide = width >= 90;
  const rows = list.map((v, i): Row => {
    index.set(v.name, i);
    const from = v.definedBy ? nb.cells.get(v.definedBy) : undefined;
    const here = v.name === cursor;
    const nameWidth = wide ? 20 : Math.max(8, Math.floor(width / 2) - 2);
    const label = fit(v.name, nameWidth);
    return { variable: v.name, text: `${here ? theme.fg("accent", "●") : " "} ${here ? theme.bold(label) : label} ${theme.fg("dim", fit(v.datatype, wide ? 14 : Math.max(0, width - nameWidth - 3)))}${wide ? ` ${fit(v.value, Math.max(1, width - 61 - `${v.usedBy.length} uses`.length))} ${theme.fg("dim", `← ${fit(from ? cellTitle(nb, from) : "?", 17)} · ${v.usedBy.length} uses`)}` : ""}` };
  });
  return { rows, index };
}
/** Wrap without whitespace collapsing or truncation; every supplied character remains reachable. */
export function variableDetailRows(v: VariableRow, nb: NotebookState, width: number): Row[] {
  const from = v.definedBy ? nb.cells.get(v.definedBy) : undefined;
  const lines = [`${v.name} · ${v.datatype}`, `Defined: ${from ? cellTitle(nb, from) : "?"} · ${v.usedBy.length} uses`, "marimo value preview", ...v.value.split("\n")];
  return lines.flatMap(line => {
    const rows: Row[] = [];
    let text = "";
    for (const char of line) {
      if (text && visibleWidth(text + char) > Math.max(1, width)) { rows.push({ text }); text = ""; }
      text += char;
    }
    rows.push({ text });
    return rows;
  });
}
