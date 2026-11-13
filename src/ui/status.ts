// Independent execution, edit and agent state chips, ordered by attention priority.
// Chips are bare colored icons (Nerd Font, or plain symbols with `view.icons` off); the words live in
// the detail status line and the help legend.
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Cell, NotebookState } from "../core/notebook.js";
import type { FrameTheme } from "../frame.ts";
import { iconsEnabled } from "./glyphs.js";
import { duration } from "./time.js";

export type BadgeKind = "running" | "queued" | "error" | "blocked" | "stale" | "edited" | "changed" | "new" | "disabled";
export interface Badge { kind: BadgeKind; text: string }

export const STATUS_STYLE: Readonly<Record<Exclude<BadgeKind, "running">, { icon: string; plain: string; label: string }>> = {
  queued: { icon: "", plain: "◌", label: "queued" },
  error: { icon: "", plain: "✗", label: "error" },
  blocked: { icon: "", plain: "⊘", label: "blocked" },
  stale: { icon: "", plain: "↻", label: "stale" },
  edited: { icon: "", plain: "✎", label: "edited" },
  changed: { icon: "", plain: "✦", label: "changed by agent" },
  new: { icon: "", plain: "+", label: "created by agent" },
  disabled: { icon: "", plain: "–", label: "disabled" },
};
export const statusIcon = (kind: Exclude<BadgeKind, "running">): string => iconsEnabled() ? STATUS_STYLE[kind].icon : STATUS_STYLE[kind].plain;
export const statusLabel = (kind: Exclude<BadgeKind, "running">): string => iconsEnabled() ? `${STATUS_STYLE[kind].icon} ${STATUS_STYLE[kind].label}` : STATUS_STYLE[kind].label;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (now: number): string => SPINNER[((Math.floor(now / 100) % SPINNER.length) + SPINNER.length) % SPINNER.length]!;

export function cellBadges(nb: NotebookState, cell: Cell, now: number): Badge[] {
  const badges: Badge[] = [];
  const add = (kind: Exclude<BadgeKind, "running">) => badges.push({ kind, text: statusIcon(kind) });
  if (cell.status === "running") badges.push({ kind: "running", text: `${spinner(now)} ${cell.runningSince !== undefined ? duration(now - cell.runningSince) : "running"}` });
  else if (cell.status === "queued") add("queued");
  if (cell.error) add("error");
  else if (cell.blocked) add("blocked");
  if (cell.stale) add("stale");
  if (nb.edited(cell)) add("edited");
  const change = nb.agentChanges.get(cell.id);
  if (change && change.kind !== "deleted") add(change.kind === "created" ? "new" : "changed");
  if (cell.disabled || cell.status === "disabled-transitively") add("disabled");
  return badges;
}

export function renderBadge(badge: Badge, theme: FrameTheme): string {
  const color = badge.kind === "error" || badge.kind === "blocked" ? "error"
    : badge.kind === "stale" || badge.kind === "edited" ? "warning"
      : badge.kind === "disabled" || badge.kind === "queued" ? "muted" : "accent";
  return theme.fg(color, badge.text);
}

/** Keep priority order and only include whole chips. A smaller later chip may still fit. */
export function fitBadges(badges: readonly Badge[], width: number, theme: FrameTheme): string {
  let result = "";
  for (const badge of badges) {
    const rendered = renderBadge(badge, theme);
    const next = result ? `${result} ${rendered}` : rendered;
    if (visibleWidth(next) <= Math.max(0, width)) result = next;
  }
  return result;
}
