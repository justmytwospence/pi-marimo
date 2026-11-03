// The run chain view of the outline: only the cells of the latest run, in file order (with each cell's run step
// beside it) or in run order (with where it sits in the file beside it).
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { chainSteps } from "../core/chain.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import { truncate } from "../core/notebook.js";
import { elapsed } from "../core/render.js";
import { CHAIN_DONE, type PaneTheme, cellGlyph } from "./outline.js";
import { gutterMarks, gutterText, hasGraph } from "./gutter.js";
import { type Row, matchesFilter } from "./rows.js";
import { cellBadges, fitBadges } from "./status.js";
import { duration } from "./time.js";
import { cellTitle } from "./titles.js";

export type ChainOrder = "file" | "run";

const STRIP = "▏▎▍▌▋▊▉█";

function split(nb: NotebookState, order: ChainOrder, filter: string): { members: Cell[]; stale: Cell[] } {
  const chain = nb.chain.current;
  if (!chain) return { members: [], stale: [] };
  const q = filter.trim().toLowerCase();
  const index = (id: string) => nb.order.indexOf(id);
  const members = chain.members.map((id) => nb.cells.get(id)).filter((c): c is Cell => c !== undefined && !nb.isMarkdown(c));
  if (order === "file") members.sort((a, b) => index(a.id) - index(b.id));
  else {
    const steps = chainSteps(chain, nb.order, (id) => nb.parents(id));
    members.sort((a, b) => (steps.get(a.id)?.step ?? Infinity) - (steps.get(b.id)?.step ?? Infinity) || index(a.id) - index(b.id));
  }
  const stale = [...chain.stale].filter((id) => !chain.members.includes(id)).map((id) => nb.cells.get(id)).filter((c): c is Cell => c !== undefined && !nb.isMarkdown(c))
    .sort((a, b) => index(a.id) - index(b.id));
  return { members: members.filter((c) => matchesFilter(nb, c, q)), stale: stale.filter((c) => matchesFilter(nb, c, q)) };
}

/** The chain view's selectable cells: members in `order`, then stale non-members in file order; text-filtered. */
export function chainCells(nb: NotebookState, order: ChainOrder, filter: string): Cell[] {
  const { members, stale } = split(nb, order, filter);
  return [...members, ...stale];
}

export function chainRows(nb: NotebookState, theme: PaneTheme, now: number, o: { cursor?: string | undefined; filter: string; width: number; order: ChainOrder }): { rows: Row[]; cellRows: Map<string, number>; running?: number } {
  const width = Math.max(8, o.width);
  const rows: Row[] = [];
  const cellRows = new Map<string, number>();
  let running: number | undefined;
  const chain = nb.chain.current;
  if (!chain) {
    rows.push({ text: truncateToWidth(theme.fg("dim", "No run yet. r runs the selected cell."), width, "…") });
    return { rows, cellRows };
  }
  const bar = (here: boolean) => (here ? theme.fg("accent", "▌") : " ");
  const finish = (text: string, here: boolean): string => {
    if (!here) return truncateToWidth(text, width, "…");
    const padded = truncateToWidth(text, width, "…", true);
    return theme.bg ? theme.bg("selectedBg", padded) : padded;
  };
  const { members, stale } = split(nb, o.order, o.filter);
  const all = chain.members.map((id) => nb.cells.get(id)).filter((c): c is Cell => c !== undefined && !nb.isMarkdown(c));
  const total = all.length;
  const failures = all.filter((c) => c.error || c.blocked).length;
  const steps = chainSteps(chain, nb.order, (id) => nb.parents(id));
  const stepWidth = String(Math.max(1, total)).length;
  const markerWidth = o.order === "file" ? stepWidth : 1;
  const graph = hasGraph(nb);
  const gutters = gutterMarks(nb, o.cursor, [...members, ...stale].map((c) => c.id));
  const codeOrder = nb.ordered().filter((c) => !nb.isMarkdown(c)).map((c) => c.id);
  const position = (id: string) => { const n = codeOrder.length; const i = codeOrder.indexOf(id); return n > 1 && i >= 0 ? i / (n - 1) : 0; };

  // The header.
  const sep = theme.fg("dim", " · ");
  const progress = chain.endedAt === undefined
    ? `${chain.steps.size}/${total} · ${elapsed(now - chain.startedAt)}`
    : `${total} cell${total === 1 ? "" : "s"} · ${elapsed(chain.endedAt - chain.startedAt)}`;
  const headLeft = `${theme.fg("accent", "chain")}${sep}${progress}${failures ? `${sep}${theme.fg("error", `${failures} error${failures === 1 ? "" : "s"}`)}` : ""}`;
  const label = theme.fg("dim", o.order === "file" ? "file order" : "run order");
  const gap = width - visibleWidth(headLeft) - visibleWidth(label);
  rows.push({ text: truncateToWidth(gap >= 2 ? `${headLeft}${" ".repeat(gap)}${label}` : headLeft, width, "…") });

  const row = (cell: Cell, marker: string) => {
    const here = o.cursor === cell.id;
    const done = chain.steps.has(cell.id) && cell.status === "idle" && !cell.error && !cell.blocked;
    const glyph = done ? theme.fg("success", CHAIN_DONE) : cellGlyph(nb, theme, cell, now);
    const gutter = graph ? `${gutterText(theme, gutters.get(cell.id), here)} ` : "";
    const title = cellTitle(nb, cell);
    const left = `${bar(here)} ${marker} ${glyph} ${gutter}${here ? theme.bold(title) : title}`;
    const budget = Math.max(0, width - Math.min(visibleWidth(left), 12) - 1);
    const badges = cellBadges(nb, cell, now);
    let base = badges.length ? fitBadges(badges, budget, theme) : "";
    if (!base && chain.steps.has(cell.id) && cell.lastRunMs !== undefined && (cell.lastRunEndedAt ?? 0) >= chain.startedAt) base = theme.fg("dim", duration(cell.lastRunMs));
    const section = o.order === "run" && width >= 40 ? theme.fg("dim", truncate(nb.sectionPath(cell.id).at(-1) ?? "", 14)) : "";
    const candidates = [base && section ? `${base}${sep}${section}` : section || base, base, ""];
    const right = candidates.find((c) => visibleWidth(c) <= budget) ?? "";
    const cut = truncateToWidth(left, Math.max(1, width - visibleWidth(right) - (right ? 1 : 0)), "…");
    const fill = Math.max(right ? 1 : 0, width - visibleWidth(cut) - visibleWidth(right));
    if (cell.status === "running") running = rows.length;
    cellRows.set(cell.id, rows.length);
    rows.push({ cell: cell.id, text: finish(`${cut}${" ".repeat(fill)}${right}`, here) });
  };

  // Members: the marker is the other order.
  const fileIndex = (id: string) => nb.order.indexOf(id);
  const stepOf = (id: string) => steps.get(id)?.step ?? Infinity;
  members.forEach((cell, i) => {
    let marker: string;
    if (o.order === "file") {
      const later = Math.min(Infinity, ...members.slice(i + 1).map((c) => stepOf(c.id)));
      const s = steps.get(cell.id);
      const text = s ? String(s.step).padStart(stepWidth) : " ".repeat(stepWidth);
      marker = cell.status === "running" ? theme.bold(theme.fg("accent", text))
        : s && s.step > later ? theme.fg("warning", text)
          : s?.predicted ? theme.fg("dim", text) : text;
      const prev = members[i - 1];
      if (prev) {
        const between = nb.order.slice(fileIndex(prev.id) + 1, fileIndex(cell.id)).filter((id) => { const c = nb.cells.get(id); return c && !nb.isMarkdown(c); }).length;
        if (between > 0) rows.push({ text: truncateToWidth(`   ${theme.fg("dim", `⋯ ${between} cell${between === 1 ? "" : "s"}`)}`, width, "…") });
      }
    } else {
      const p = position(cell.id);
      const glyph = STRIP[Math.round(p * 7)]!;
      const back = i > 0 && p < position(members[i - 1]!.id);
      marker = theme.fg(back ? "warning" : "dim", glyph);
    }
    row(cell, marker);
  });

  if (stale.length) {
    rows.push({ text: "" });
    rows.push({ text: truncateToWidth(`  ${theme.fg("dim", "stale · not in this run")}`, width, "…") });
    for (const cell of stale) row(cell, " ".repeat(markerWidth));
  }
  return { rows, cellRows, ...(running !== undefined ? { running } : {}) };
}
