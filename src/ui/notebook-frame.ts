// Notebook-local chrome. Shared frame.ts remains the suite's bordered dialog contract.
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FrameTheme } from "../frame.ts";

export const CONTENT_LEFT = 1;
export const bodyWidth = (width: number): number => Math.max(0, width - 2 * CONTENT_LEFT);
export function row(content: string, width: number, _theme: FrameTheme): string {
  const inner = bodyWidth(width);
  const text = sliceByColumn(content, 0, inner, true);
  return ` ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} `;
}
export function rule(width: number, theme: FrameTheme): string {
  return row(theme.fg("dim", "─".repeat(bodyWidth(width))), width, theme);
}
export function banner(title: string, width: number, theme: FrameTheme): string {
  const label = truncateToWidth(`◀ esc · ${title} · not your main session`, bodyWidth(width));
  return row(theme.fg("accent", theme.bold(label)), width, theme);
}
export function bottom(width: number, theme: FrameTheme): string { return rule(width, theme); }
