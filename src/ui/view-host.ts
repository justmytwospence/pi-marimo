// What the notebook view's mode controllers (packages, variables, tables, widgets) need from the view
// that hosts them. The view owns the cursor, scroll, notes and docks; a controller owns its mode's state
// and keys.
import type { Cell } from "../core/notebook.js";
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
  /** Back to the cell list, with the cursor kept in view. */
  showCells(): void;
  openDock(spec: DockSpec): void;
  closeDock(): void;
  /** While a Pi dialog is up the view takes no keys. */
  setConfirming(on: boolean): void;
  /** Move the outline to a cell. */
  goTo(f: Followed, id: string): void;
  cell(f: Followed, id: string): Cell | undefined;
}
