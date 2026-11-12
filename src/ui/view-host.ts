// What the notebook view's mode controllers (packages, variables, tables, widgets) need from the view
// that hosts them. The view owns the cursor, scroll, notes and docks; a controller owns its mode's state
// and keys.
import type { Cell } from "../core/notebook.js";
import type { Widget } from "../core/output.js";
import type { Followed } from "../core/watcher.js";
import type { DockSpec } from "./dock.js";
import type { ViewActions } from "./view.js";

export interface ViewHost {
  readonly actions: ViewActions;
  /** The notebook the view shows now. */
  current(): Followed | undefined;
  /** Rows of the pane under the header. */
  viewport(): number;
  /** Ask Pi for a redraw (ignored once the view is closed). */
  render(): void;
  isClosed(): boolean;
  /** The one-line note under the panes; undefined clears it. */
  setNote(text: string | undefined): void;
  /** Back to the cell list, with the cursor kept in view (and the outline scrolled to the top). */
  showCells(resetScroll?: boolean): void;
  openDock(spec: DockSpec): void;
  closeDock(): void;
  /** While a Pi dialog is up the view takes no keys. */
  setConfirming(on: boolean): void;
  /** Move the outline to a cell. */
  goTo(f: Followed, id: string): void;
  cell(f: Followed, id: string): Cell | undefined;
  /** Scroll the outline by rows (and stop following the running cell). */
  move(by: number): void;
  resetScroll(): void;
  /** Scroll the cursor into view on the next render. */
  reveal(): void;
  switchNotebook(by: 1 | -1): void;
  setMode(mode: "cells" | "variables" | "packages"): void;
  /** Back to Pi's chat. */
  leave(): void;
  copy(text: string): void;
  /** Typing goes to a filter box; Esc returns to `from`. */
  startFind(from: string | undefined): void;
  enterTable(f: Followed, cell: Cell): void;
  /** The notebook's key in the view, which scopes per-table state. */
  viewKey(): string;
  getDetailScroll(): number;
  setDetailScroll(n: number): void;
  /** Columns of the outline pane (the table's first page width). */
  outlineWidth(): number;
  openHelp(): void;
  /** Open text in the read-only message view. */
  showMessage(text: string): void;
  /** Put the cursor on a cell, stop following, and reveal it. */
  selectCell(id: string): void;
  /** Forget which part of the cell has focus. */
  clearPart(): void;
  /** Type a value for a control in the dock. */
  openValue(f: Followed, cell: Cell, w: Widget): void;
  confirm(question: string, choices: readonly string[]): Promise<string | undefined>;
}
