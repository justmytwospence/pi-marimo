// Grouped Python warnings as rows of a diagnostic panel.
import type { FrameTheme } from "../frame.ts";
import type { ConsoleLine } from "../core/output.js";
import { parseWarnings, shortPath } from "../core/warnings.js";
import { clean, consoleLineText } from "./outputs.js";
import type { Row } from "./rows.js";

const MAX_VARIES = 8;

export function warningRows(lines: readonly ConsoleLine[], theme: FrameTheme): Row[] {
  const rows: Row[] = [];
  const message = (text: string): Row => {
    const value = clean(text);
    return { text: /^https?:\/\/\S+$/u.test(value.trim()) ? theme.fg("dim", value) : value };
  };
  for (const item of parseWarnings(lines.map(line => line.text))) {
    if (item.kind === "line") { rows.push({ text: consoleLineText(lines[item.index]!, theme) }); continue; }
    rows.push({ text: `${theme.bold(theme.fg("warning", item.category))}${item.count > 1 ? theme.fg("warning", ` ×${item.count}`) : ""}${theme.fg("dim", `  ${shortPath(item.file)}:${item.line}`)}` });
    for (const text of item.message) rows.push(message(text));
    for (const extra of (item.distinct ?? []).slice(1)) {
      rows.push({ text: theme.fg("dim", "—") });
      for (const text of extra) rows.push(message(text));
    }
    if (item.varies.length) {
      const more = item.varies.length - MAX_VARIES;
      rows.push({ text: `${theme.fg("dim", "varies: ")}${item.varies.slice(0, MAX_VARIES).join(", ")}${more > 0 ? theme.fg("dim", `, +${more} more`) : ""}` });
    }
  }
  return rows;
}
