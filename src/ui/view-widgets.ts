// The widgets mode of the notebook view (`w`): driving a cell's marimo controls from the keyboard. It owns
// which control has focus (and a slider being dragged with the mouse); the view hosts it and draws them.
import type { Cell } from "../core/notebook.js";
import type { Widget } from "../core/output.js";
import type { Followed } from "../core/watcher.js";
import { commandFor } from "./keys.js";
import { MAX_WIDGETS } from "./rows.js";
import type { ViewHost } from "./view-host.js";
import { type WidgetAction, nextValue, typeable, widgetValue } from "./widgets.js";

export class WidgetController {
  /** The focused control: its cell, its index among the cell's controls, and the part of it (a range's handle). */
  active: { cell: string; index: number; sub: number } | undefined;
  /** A slider being dragged with the mouse. */
  dragging: { cell: string; index: number } | undefined;

  constructor(private readonly host: ViewHost) {}

  /** Flatten widget leaves in output order; the indices match the rows' kernel widget indices. */
  cellWidgets(cell: Cell): Widget[] {
    return cell.output?.blocks?.length ? cell.output.blocks.flatMap(block => block.output.widgets ?? []).slice(0, MAX_WIDGETS) : cell.output?.widgets?.slice(0, MAX_WIDGETS) ?? [];
  }

  /** The widgets of the driven cell, or undefined (and widget mode ends) when they are gone. */
  driven(f: Followed | undefined): { cell: Cell; widgets: Widget[] } | undefined {
    const w = this.active;
    const cell = w && f ? f.notebook.cells.get(w.cell) : undefined;
    const widgets = cell ? this.cellWidgets(cell) : [];
    if (!f || !cell || !widgets.length || f.connection !== "connected") {
      this.active = undefined;
      return undefined;
    }
    if (w!.index >= widgets.length) w!.index = widgets.length - 1;
    return { cell, widgets };
  }

  key(f: Followed | undefined, data: string): void {
    const driven = this.driven(f);
    if (!driven || !f) { this.host.setNote("The widgets are gone."); return; }
    const command = commandFor("widget", data)?.id;
    const focus = this.active!;
    const w = driven.widgets[focus.index]!;
    if (command === "widget-close") { this.active = undefined; return; }
    if (command === "widget-previous" || command === "widget-next") {
      const controls = f.notebook.ordered().flatMap(cell => this.cellWidgets(cell).map((_, index) => ({ cell, index })));
      const at = controls.findIndex(item => item.cell.id === focus.cell && item.index === focus.index);
      const by = command === "widget-next" ? 1 : -1;
      const next = controls[((at + by) % controls.length + controls.length) % controls.length];
      if (next) {
        this.host.goTo(f, next.cell.id);
        this.active = { cell: next.cell.id, index: next.index, sub: 0 };
        this.host.clearPart();
        this.host.reveal();
      }
      return;
    }
    if (command === "widget-browser") { this.host.actions.openInBrowser(f); return; }
    const act = (action: WidgetAction) => {
      if (w.disabled) { this.host.setNote("This widget is disabled."); return; }
      const next = nextValue(w, widgetValue(f.notebook, w), action, focus.sub);
      if (!next) { this.host.setNote(typeable(w) ? "enter types a value" : undefined); return; }
      focus.sub = next.sub;
      this.host.setNote(undefined);
      if (next.send) this.host.actions.setWidget?.(f, driven.cell, w, next.value);
    };
    if (command === "widget-dec") act("dec");
    else if (command === "widget-inc") act("inc");
    else if (command === "widget-dec10") act("dec10");
    else if (command === "widget-inc10") act("inc10");
    else if (command === "widget-toggle") act("toggle");
    else if (command === "widget-type") {
      if (typeable(w) && !w.disabled) this.host.openValue(f, driven.cell, w);
      else act("toggle");
    }
  }
}
