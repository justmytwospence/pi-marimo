// Diagnostic text reads like source: preserve traceback columns and console styling, with a
// severity-colored rail and the host theme's subtle tool background when available.
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { FrameTheme } from "../frame.ts";
import type { Row } from "./rows.js";

type Severity = "error" | "warning";
type BackgroundTheme = FrameTheme & { bg?(color: string, text: string): string };

export function diagnosticPanelRows(rows: readonly Row[], severity: Severity, width: number, theme: FrameTheme): Row[] {
  if (!rows.length) return [];
  const columns = Math.max(10, Math.floor(width));
  const token = severity === "error" ? "toolErrorBg" : "toolPendingBg";
  const rail = theme.fg(severity, "▍ ");
  const bg = (theme as BackgroundTheme).bg?.bind(theme);
  const tint = (line: string): string => {
    const padded = line + " ".repeat(Math.max(0, columns - visibleWidth(line)));
    if (!bg) return padded;
    try {
      // Foreground SGR resets can also clear a background. Restore it for each text run.
      return padded.split(/(\x1b\[[0-9;:]*m)/u).map(run => run.startsWith("\x1b[") ? run : bg(token, run)).join("");
    } catch { return padded; }
  };
  const icon = severity === "error" ? " ERROR" : " WARNING";
  const result: Row[] = [{ text: tint(theme.fg(severity, icon)) }];
  const room = columns - visibleWidth(rail);
  for (const row of rows) {
    // Image and interactive grid control sequences have layout/coordinate contracts of their own.
    // They already fit the caller's pane; the severity header still marks their output.
    if (row.image || row.tableRow !== undefined || row.tableHeader || row.tableColumns || row.widget || row.progress || row.code) {
      result.push({ ...row });
      continue;
    }
    const length = visibleWidth(row.text);
    if (!length) { result.push({ ...row, text: tint(rail) }); continue; }
    for (let offset = 0; offset < length; offset += room) {
      result.push({ ...row, text: tint(`${rail}${sliceByColumn(row.text, offset, room, true)}`) });
    }
  }
  return result;
}
