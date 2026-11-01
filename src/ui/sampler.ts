// A compact view of nutpie's producer-supplied counters and diagnostics.
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ProgressTask } from "../core/progress.js";
import type { FrameTheme } from "../frame.ts";
import { oneLine } from "./text.js";
import type { Row } from "./rows.js";

const fraction = (task: ProgressTask) => task.completed !== undefined && task.total !== undefined && task.total > 0
  ? Math.max(0, Math.min(1, task.completed / task.total)) : undefined;
const counter = (task: ProgressTask) => task.completed !== undefined
  ? `${task.completed}${task.total !== undefined ? `/${task.total}` : ""}` : task.total !== undefined ? `?/${task.total}` : "";
const percentage = (task: ProgressTask) => {
  const value = fraction(task);
  return value !== undefined ? `${Math.round(value * 100)}%` : "";
};
const bar = (task: ProgressTask, columns: number, theme: FrameTheme) => {
  const part = fraction(task);
  if (part === undefined || columns < 1) return "";
  const filled = Math.round(part * columns);
  return theme.fg("accent", `[${"━".repeat(filled)}${"─".repeat(columns - filled)}]`);
};

const standard = ["Divergences", "Step Size", "Gradients/Draw"] as const;
const headings = ["Chain", "Progress", "Draws", "Div", "Step", "Grad/draw"] as const;
function diagnostics(task: ProgressTask): { primary: string[]; extra: Array<[string, string]> } {
  const primary = standard.map(name => Object.entries(task.stats).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? "").map(oneLine);
  const extra = Object.entries(task.stats).filter(([key, value]) => {
    if (standard.some(name => name.toLowerCase() === key.toLowerCase())) return false;
    if (key.toLowerCase() === "progress" && !value.trim()) return false;
    if (key.toLowerCase() === "draws" && task.completed !== undefined && value.trim() === String(task.completed)) return false;
    return !!value.trim();
  }).map(([key, value]): [string, string] => [oneLine(key), oneLine(value)]);
  return { primary, extra };
}

/** Every summary and chain line belongs to an existing ProgressTask, even when wrapped. */
export function samplerRows(tasks: readonly ProgressTask[], width: number, theme: FrameTheme, _now: number): Row[] {
  width = Math.max(1, Math.floor(width));
  const total = tasks.find(task => task.sampler?.role === "total");
  if (!total) return [];
  const chains = tasks.filter(task => task.sampler?.role === "chain");
  const rows: Row[] = [];
  const add = (task: ProgressTask, line: string) => {
    for (const text of wrapTextWithAnsi(line, width)) rows.push({ text, progress: { id: task.id } });
  };
  const summary = total.sampler?.summary;
  const counts = [summary?.totalChains !== undefined ? `${summary.totalChains} chains` : "", summary?.activeChains !== undefined ? `${summary.activeChains} active` : "", summary?.finishedChains !== undefined ? `${summary.finishedChains} finished` : ""].filter(Boolean);
  add(total, theme.fg("accent", "Sampler") + (counts.length ? ` · ${counts.join(" · ")}` : ""));
  const timing = [summary?.elapsed ? `${oneLine(summary.elapsed)} elapsed` : "", summary?.eta ? `ETA ${oneLine(summary.eta)}` : ""].filter(Boolean);
  if (timing.length) add(total, theme.fg("dim", timing.join(" · ")));
  for (const [name, value] of Object.entries(total.stats)) add(total, theme.fg("dim", `${oneLine(name)}: ${oneLine(value)}`));
  const info = [counter(total), percentage(total)].filter(Boolean).join(" · ");
  const aggregate = width >= 8 ? bar(total, Math.min(40, Math.max(1, width - 2 - (info ? visibleWidth(info) + 1 : 0))), theme) : "";
  if (aggregate) {
    const text = `${aggregate}${info ? ` ${info}` : ""}`;
    if (visibleWidth(text) <= width) add(total, text);
    else { add(total, bar(total, Math.min(40, width - 2), theme)); if (info) add(total, info); }
  } else if (info) add(total, info);

  const details = chains.map(diagnostics);
  const draw = chains.map(counter);
  const dims = [Math.max(headings[0].length, ...chains.map(t => oneLine(t.label).length)),
    0, Math.max(headings[2].length, ...draw.map(v => visibleWidth(v))),
    ...[0, 1, 2].map((i) => Math.max(headings[i + 3]!.length, ...details.map(d => visibleWidth(d.primary[i]!))))];
  // Five two-space gaps, brackets, a space and a percent follow the variable-length bar.
  const fixed = dims[0]! + dims[2]! + dims[3]! + dims[4]! + dims[5]! + 10 + 3 + Math.max(3, ...chains.map(t => percentage(t).length));
  const barWidth = Math.min(20, width - fixed);
  const aligned = chains.length > 0 && barWidth >= 8;
  if (aligned) {
    dims[1] = barWidth + 3 + Math.max(3, ...chains.map(t => percentage(t).length));
    add(total, theme.fg("dim", headings.map((name, i) => name.padEnd(dims[i]!)).join("  ").trimEnd()));
  }
  for (const [index, task] of chains.entries()) {
    const diag = details[index]!;
    const extra = diag.extra.map(([name, value]) => `${name}: ${value}`);
    if (aligned) {
      const cells = [oneLine(task.label), `${bar(task, barWidth, theme)} ${percentage(task)}`, draw[index]!, ...diag.primary];
      const colored = cells.map((cell, i) => i === 3 && Number(diag.primary[0]) > 0 ? theme.fg("warning", cell) : cell);
      add(task, colored.map((cell, i) => cell + " ".repeat(Math.max(0, dims[i]! - visibleWidth(cell)))).join("  ").trimEnd());
      if (extra.length) add(task, theme.fg("dim", extra.join(" · ")));
    } else {
      const heading = [oneLine(task.label), counter(task), percentage(task)].filter(Boolean).join(" · ");
      add(task, theme.fg("accent", heading));
      if (width >= 8) {
        const line = bar(task, Math.min(20, width - 2), theme);
        if (line) add(task, line);
      }
      const fields = diag.primary.map((value, i) => value
        ? theme.fg(i === 0 && Number(value) > 0 ? "warning" : "dim", `${headings[i + 3]}: ${value}`) : "").filter(Boolean);
      if (fields.length || extra.length) add(task, [...fields, ...extra.map(field => theme.fg("dim", field))].join(" · "));
    }
  }
  return rows;
}
