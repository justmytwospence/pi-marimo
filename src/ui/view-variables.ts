// The variables mode of the notebook view (`v`): marimo's variables panel, with each value's supplied preview.
// It owns the list's cursor, filter, sort and detail; the view hosts it.
import { cellTitle } from "./titles.js";
import type { Followed } from "../core/watcher.js";
import { commandFor } from "./keys.js";
import { variableList, type VariableSort } from "./variables.js";
import type { ViewHost } from "./view-host.js";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class VariablesController {
  cursor: string | undefined;
  filter = "";
  sort: VariableSort = "name";
  /** The selected variable's preview is open. */
  detail = false;
  scroll = 0;

  constructor(private readonly host: ViewHost) {}

  key(f: Followed | undefined, data: string): void {
    const command = commandFor("variables", data)?.id;
    const { actions } = this.host;
    const page = this.host.viewport();
    const list = f ? variableList(f.notebook, this.filter, this.sort) : [];
    const at = Math.max(0, list.findIndex((v) => v.name === this.cursor));
    if (command === "var-back" && this.detail) { this.detail = false; this.scroll = 0; return; }
    if (this.detail) {
      const down = command === "var-down", up = command === "var-up";
      if (down || up || command === "var-first" || command === "var-last") {
        this.scroll = command === "var-first" ? 0 : command === "var-last" ? Number.MAX_SAFE_INTEGER : Math.max(0, this.scroll + (down ? 1 : -1)); return;
      }
      const next = command === "var-page-down" || command === "var-half-down";
      const previous = command === "var-page-up" || command === "var-half-up";
      if (next || previous) { this.scroll = Math.max(0, this.scroll + (next ? page : -page)); return; }
    }
    if (command === "var-sort") { const sorts: VariableSort[] = ["name", "type", "definition"]; this.sort = sorts[(sorts.indexOf(this.sort) + 1) % sorts.length]!; return; }
    const moveTo = (i: number) => { this.cursor = list[Math.max(0, Math.min(list.length - 1, i))]?.name; this.host.reveal(); };
    if (command === "var-leave") { this.host.leave(); return; }
    if (command === "var-close" || command === "var-back") {
      this.host.showCells(true);
      return;
    }
    if (command === "notebook-previous") { this.host.switchNotebook(-1); this.host.setMode("variables"); return; }
    if (command === "notebook-next") { this.host.switchNotebook(1); this.host.setMode("variables"); return; }
    if (command === "var-find") { this.host.startFind(this.cursor); this.filter = ""; return; }
    if (command === "var-down") return moveTo(at + 1);
    if (command === "var-up") return moveTo(at - 1);
    if (command === "var-first") { this.host.resetScroll(); return moveTo(0); }
    if (command === "var-last") return moveTo(list.length - 1);
    if (command === "var-half-up") return this.host.move(-Math.max(1, Math.floor(page / 2)));
    if (command === "var-half-down") return this.host.move(Math.max(1, Math.floor(page / 2)));
    if (command === "var-page-up") return this.host.move(-page);
    if (command === "var-page-down") return this.host.move(page);
    const v = list[at];
    if (!f || !v) return;
    if (command === "var-detail") {
      this.detail = true; this.scroll = 0;
    } else if (command === "var-definition") {
      if (v.definedBy && f.notebook.cells.has(v.definedBy)) this.host.goTo(f, v.definedBy);
      else this.host.setNote(`No cell defines ${v.name}.`);
    } else if (command === "var-copy" || command === "var-copy-value") {
      try { if (actions.copy) actions.copy(command === "var-copy" ? v.name : v.value); else this.host.copy(command === "var-copy" ? v.name : v.value); }
      catch (e) { this.host.setNote(message(e)); }
    } else if (command === "var-ask") {
      const defining = v.definedBy ? f.notebook.cells.get(v.definedBy) : undefined;
      if (actions.ask) actions.ask(f, defining, `Explain variable ${v.name} (${v.datatype}), defined in ${defining ? cellTitle(f.notebook, defining) : "unknown cell"}.`);
      else this.host.setNote("Asking the agent is not available here.");
    } else if (command === "var-table") {
      const cell = v.definedBy ? f.notebook.cells.get(v.definedBy) : undefined;
      if (!cell?.output?.table) this.host.setNote(`No table output for ${v.name}.`);
      else { this.host.goTo(f, cell.id); this.host.enterTable(f, cell); }
    } else if (command === "var-uses") {
      const users = f.notebook.order.filter(id => v.usedBy.includes(id));
      if (!users.length) { this.host.setNote(`No cell uses ${v.name}.`); return; }
      const choices = ["Cancel", ...users.map((id, i) => `${i + 1}. ${cellTitle(f.notebook, f.notebook.cells.get(id)!)}`)];
      void this.host.confirm(`Use sites of ${v.name}`, choices).then(choice => {
        const id = users[choices.indexOf(choice ?? "") - 1];
        if (!this.host.isClosed() && id && this.host.current()?.notebook === f.notebook) { this.host.goTo(f, id); this.host.render(); }
      }).catch(e => { this.host.setNote(message(e)); this.host.render(); });
    }
  }
}
