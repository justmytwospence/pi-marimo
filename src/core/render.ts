// Text views of a NotebookState: a one-line status for footers and status lines,
// and the compact state block injected into the agent's context.

import { basename } from "./io.js";
import { type Cell, NotebookState, truncate } from "./notebook.js";

export interface Attachment {
  url: string;
  sessionId: string;
  path: string;
}

export const STATE_TAG = "marimo_notebook_state";

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export interface StatusParts {
  notebook: string;
  /** "connected" | "connecting" | "disconnected" */
  connection: string;
  running?: { section: string; cell: string; elapsed?: string };
  queued: number;
  errors: number;
  /** Other notebooks followed besides this one. */
  others?: number;
}

export function statusParts(nb: NotebookState, attachment: Attachment, connection: string, now = Date.now(), others = 0): StatusParts {
  const run = connection === "connected" ? nb.running() : undefined;
  return {
    notebook: basename(attachment.path),
    connection,
    running: run
      ? {
        section: run.section.join(" › "),
        cell: run.cell.name !== "_" ? run.cell.name : run.cell.id,
        elapsed: run.since !== undefined ? elapsed(now - run.since) : undefined,
      }
      : undefined,
    queued: connection === "connected" ? nb.queued() : 0,
    errors: connection === "connected" ? nb.errors().length : 0,
    others,
  };
}

/**
 * One line, e.g. `marimo: fit.py · running Data loading › Model fit (12s) · 2 queued · 1 error · +2 open`.
 * The shape is stable so footers can parse it: `marimo: <file>` then ` · ` separated parts.
 */
export function statusText(parts: StatusParts): string {
  const out = [`marimo: ${parts.notebook}`];
  if (parts.connection !== "connected") out.push(parts.connection);
  if (parts.running) {
    const where = parts.running.section || `cell ${parts.running.cell}`;
    out.push(`running ${where}${parts.running.elapsed ? ` (${parts.running.elapsed})` : ""}`);
  }
  if (parts.queued) out.push(`${parts.queued} queued`);
  if (parts.errors) out.push(`${parts.errors} error${parts.errors === 1 ? "" : "s"}`);
  if (parts.others) out.push(`+${parts.others} open`);
  return out.join(" · ");
}

function firstLine(code: string): string {
  const line = code.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return truncate(line, 60);
}

export interface SnapshotOptions {
  /** When the block is refreshed: before every model request, or once per user prompt. */
  refresh?: "request" | "prompt";
  /** Other notebooks open in the project, named so the agent knows they exist. */
  others?: Attachment[];
  /** Edits from the browser after this change number are flagged as new. */
  seenSeq?: number;
  /** Above this many cells, quiet code cells are folded into counts. */
  maxCells?: number;
  now?: number;
}

/**
 * The notebook as an outline: headings, then one line per code cell with its
 * id, what it defines, and anything that needs attention.
 */
export function snapshot(nb: NotebookState, attachment: Attachment, options: SnapshotOptions = {}): string {
  const now = options.now ?? Date.now();
  const maxCells = options.maxCells ?? 60;
  const seen = options.seenSeq ?? Number.POSITIVE_INFINITY;
  const cells = nb.ordered();
  const fold = cells.length > maxCells;
  // When most cells are stale (a lazy notebook after a restart), say so once instead of on every line.
  const staleCount = cells.filter((c) => c.stale).length;
  const staleCommon = staleCount > cells.length / 2;
  // Likewise a Run all: the queue is counted on the Kernel line, so list queued cells only when few.
  const queuedCount = cells.filter((c) => c.status === "queued").length;
  const queuedCommon = queuedCount > 10 || queuedCount > cells.length / 2;

  const notes = (cell: Cell): string[] => {
    const out: string[] = [];
    if (cell.status === "running") out.push(`RUNNING${cell.runningSince ? ` ${elapsed(now - cell.runningSince)}` : ""}`);
    else if (cell.status === "queued" && !queuedCommon) out.push("queued");
    if (cell.error) out.push(`ERROR ${cell.error}`);
    if (cell.blocked) out.push("not run: an ancestor failed");
    if (cell.disabled) out.push("disabled");
    else if (cell.status === "disabled-transitively") out.push("disabled by an ancestor");
    if (cell.stale && !staleCommon) out.push("stale");
    if (nb.edited(cell)) out.push("edited, not rerun");
    if (cell.editedBy === "frontend" && cell.editSeq > seen) out.push("changed by the user in the browser");
    return out;
  };

  const lines: string[] = [];
  let folded = 0;
  const flushFolded = (): void => {
    if (folded) lines.push(`  … ${folded} more cell${folded === 1 ? "" : "s"}`);
    folded = 0;
  };
  for (const cell of cells) {
    const headings = nb.headings(cell);
    const cellNotes = notes(cell);
    if (headings.length && nb.isMarkdown(cell)) {
      flushFolded();
      headings.forEach((h, i) => {
        const tail = i === 0 ? `  [${cell.id}]${cellNotes.length ? ` ${cellNotes.join("; ")}` : ""}` : "";
        lines.push(`${"#".repeat(h.level)} ${h.text}${tail}`);
      });
      continue;
    }
    if (nb.isMarkdown(cell)) {
      if (cellNotes.length) { flushFolded(); lines.push(`  ${cell.id} (markdown) ${cellNotes.join("; ")}`); }
      else if (fold) folded++;
      else lines.push(`  ${cell.id} (markdown)`);
      continue;
    }
    // Folded or not, the outline keeps every heading.
    if (headings.length) flushFolded();
    for (const h of headings) lines.push(`${"#".repeat(h.level)} ${h.text}  [${cell.id}]`);
    if (fold && !cellNotes.length) { folded++; continue; }
    flushFolded();
    const defs = nb.defs.get(cell.id) ?? [];
    const label = cell.name !== "_" ? `${cell.id} "${cell.name}"` : cell.id;
    const what = defs.length ? `defines ${truncate(defs.join(", "), 80)}` : firstLine(cell.code) || "(empty)";
    lines.push(`  ${label}: ${what}${cellNotes.length ? ` -- ${cellNotes.join("; ")}` : ""}`);
  }
  flushFolded();

  const run = nb.running();
  const summary: string[] = [];
  if (run) summary.push(`running ${run.cell.id}${run.section.length ? ` under "${run.section.join(" › ")}"` : ""}`);
  const queued = nb.queued();
  if (queued) summary.push(`${queued} queued`);
  const errors = nb.errors().length;
  if (errors) summary.push(`${errors} cell${errors === 1 ? "" : "s"} with errors`);
  if (staleCommon) summary.push(`${staleCount} of ${cells.length} cells stale (inputs changed, not rerun)`);

  return [
    `<${STATE_TAG} path="${attachment.path}" url="${attachment.url}" session="${attachment.sessionId}">`,
    "Live state of the marimo notebook open in the user's browser, added automatically by pi-marimo (not",
    ...(options.refresh === "prompt"
      ? ["written by the user). Taken when the user sent their latest message and not updated during the turn;",
        "earlier copies are removed. Check current values through marimo-pair before relying on them."]
      : ["written by the user). It is replaced with a fresh copy on every request, so trust this over older reads."]),
    "Cells are listed in notebook order under their markdown headings, by cell id. Inspect or change cells",
    "through the marimo-pair skill, not by editing the .py file.",
    `Kernel: ${summary.length ? summary.join(", ") : "idle"}.`,
    ...(options.others?.length
      ? [`Also open (the one used most recently is shown): ${options.others.map((o) => o.path).join(", ")}.`]
      : []),
    "",
    ...lines,
    `</${STATE_TAG}>`,
  ].join("\n");
}
