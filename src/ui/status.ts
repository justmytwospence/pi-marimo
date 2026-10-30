// Independent execution, edit and agent state chips, ordered by attention priority.
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Cell, NotebookState } from "../core/notebook.js";
import type { FrameTheme } from "../frame.ts";
import { duration } from "./time.js";

export type BadgeKind = "running" | "queued" | "error" | "blocked" | "stale" | "edited" | "changed" | "new" | "disabled";
export interface Badge { kind: BadgeKind; text: string }
export type BadgeTheme = FrameTheme & { bg?(color: string, text: string): string };

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (now: number): string => SPINNER[((Math.floor(now / 100) % SPINNER.length) + SPINNER.length) % SPINNER.length]!;

export function cellBadges(nb: NotebookState, cell: Cell, now: number): Badge[] {
  const badges: Badge[] = [];
  const add = (kind: BadgeKind, text: string = kind) => badges.push({ kind, text });
  if (cell.status === "running") add("running", `${spinner(now)} ${cell.runningSince !== undefined ? duration(now - cell.runningSince) : "running"}`);
  else if (cell.status === "queued") add("queued");
  if (cell.error) add("error", /^([A-Za-z_][\w.]*)(?::|$)/u.exec(cell.error)?.[1] ?? "error");
  else if (cell.blocked) add("blocked");
  if (cell.stale) add("stale");
  if (nb.edited(cell)) add("edited");
  const change = nb.agentChanges.get(cell.id);
  if (change && change.kind !== "deleted") add(change.kind === "created" ? "new" : "changed");
  if (cell.disabled || cell.status === "disabled-transitively") add("disabled");
  return badges;
}

export function renderBadge(badge: Badge, theme: BadgeTheme): string {
  const color = badge.kind === "error" || badge.kind === "blocked" ? "error"
    : badge.kind === "stale" || badge.kind === "edited" ? "warning"
      : badge.kind === "disabled" || badge.kind === "queued" ? "muted" : "accent";
  const background = color === "error" ? "toolErrorBg" : "toolPendingBg";
  if (theme.bg) {
    try {
      const plain = ` ${badge.text} `;
      // Minimal themes may expose bg but leave it inert. Keep chip boundaries visible there.
      if (theme.bg(background, plain) !== plain) return theme.bg(background, theme.fg(color, plain));
    } catch { /* A host may not implement these semantic background tokens. */ }
  }
  return theme.fg(color, `[${badge.text}]`);
}

/** Keep priority order and only include whole chips. A smaller later chip may still fit. */
export function fitBadges(badges: readonly Badge[], width: number, theme: BadgeTheme): string {
  let result = "";
  for (const badge of badges) {
    const rendered = renderBadge(badge, theme);
    const next = result ? `${result} ${rendered}` : rendered;
    if (visibleWidth(next) <= Math.max(0, width)) result = next;
  }
  return result;
}
