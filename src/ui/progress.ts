// Structured progress stays visible independently of result/diagnostic filters.
import { wrapTextWithAnsi, visibleWidth } from "@earendil-works/pi-tui";
import type { ProgressTask } from "../core/progress.js";
import type { FrameTheme } from "../frame.ts";
import { oneLine } from "./text.js";
import { spinner } from "./outline.js";
import { samplerRows } from "./sampler.js";
import type { Row } from "./rows.js";

const seconds = (n: number): string => n < 60 ? `${Math.round(Math.max(0, n))}s` : `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;

/** Output leaves render themselves when visible. Hidden output keeps entire active sampler groups. */
export function visibleProgress(tasks: readonly ProgressTask[], showOutput: boolean): ProgressTask[] {
  if (showOutput) return tasks.filter(task => !task.id.startsWith("output:"));
  const activeGroups = new Set(tasks.filter(task => task.sampler && task.state !== "complete").map(task => task.sampler!.groupId));
  return tasks.filter(task => task.sampler ? activeGroups.has(task.sampler.groupId) : task.state !== "complete");
}

/** Every generic task gets its own proportional bar and unmodified raw counters. */
function genericProgressRows(tasks: readonly ProgressTask[], width: number, theme: FrameTheme, now: number): Row[] {
  width = Math.max(1, Math.floor(width));
  return tasks.flatMap(task => {
    const rows: Row[] = [];
    const add = (text: string) => { for (const line of wrapTextWithAnsi(text, width)) rows.push({ text: line, progress: { id: task.id } }); };
    const suppliedPercent = task.stats.percent === undefined ? NaN : Number(task.stats.percent);
    const rawFraction = task.total !== undefined && task.total > 0 && task.completed !== undefined ? task.completed / task.total : Number.isFinite(suppliedPercent) ? suppliedPercent / 100 : undefined;
    const fraction = rawFraction === undefined ? undefined : Math.max(0, Math.min(1, rawFraction));
    const count = task.completed !== undefined ? `${task.completed}${task.total !== undefined ? `/${task.total}` : ""}` : "";
    const percent = fraction !== undefined ? `${Math.round(fraction * 100)}%` : "";
    const info = [count, percent, task.rate !== undefined ? `${task.rate}/s` : "", task.etaSeconds !== undefined ? `ETA ${seconds(task.etaSeconds)}` : "", task.elapsedSeconds !== undefined ? `${seconds(task.elapsedSeconds)} elapsed` : ""].filter(Boolean).join(" · ");
    if (task.label) add(theme.fg("accent", oneLine(task.label)));
    if (fraction === undefined) add(`${theme.fg("accent", task.state === "complete" ? "✓" : spinner(now))} ${info || oneLine(task.state)}`);
    else {
      // Keep useful bar resolution on narrow panes; metadata moves below rather than shrinking to nothing.
      const inline = width - visibleWidth(info) - 3 >= 10;
      const columns = Math.max(1, inline ? width - visibleWidth(info) - 3 : width - 2);
      const filled = Math.round(columns * fraction);
      add(`${theme.fg("accent", `[${"━".repeat(filled)}${"─".repeat(columns - filled)}]`)}${inline ? ` ${info}` : ""}`);
      if (!inline && info) add(info);
    }
    // Stats are separate from bar geometry, including all dynamic PyMC columns.
    for (const [name, value] of Object.entries(task.stats)) {
      const text = `${oneLine(name)}: ${oneLine(String(value))}`;
      add(/divergen/iu.test(name) && Number(value) > 0 ? theme.fg("warning", text) : theme.fg("dim", text));
    }
    return rows;
  });
}

/** Contiguous sampler tasks share one compact panel; other producers keep their existing view. */
export function progressRows(tasks: readonly ProgressTask[], width: number, theme: FrameTheme, now: number): Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < tasks.length;) {
    const group = tasks[index]!.sampler?.producer === "nutpie" ? tasks[index]!.sampler!.groupId : undefined;
    if (group !== undefined) {
      let end = index + 1;
      while (end < tasks.length && tasks[end]!.sampler?.producer === "nutpie" && tasks[end]!.sampler?.groupId === group) end++;
      rows.push(...samplerRows(tasks.slice(index, end), width, theme, now));
      index = end;
    } else {
      rows.push(...genericProgressRows([tasks[index]!], width, theme, now));
      index++;
    }
  }
  return rows;
}
