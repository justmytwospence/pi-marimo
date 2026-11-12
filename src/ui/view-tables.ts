// The table mode of the notebook view (`t`): driving a `mo.ui.table` through marimo's own table functions
// (paging, sorting, search, filters, selection, cards, copy, CSV). It owns which table has the keys and the
// card's scroll; the per-table state lives in table-session.ts. The view hosts it and draws the table.
import type { Cell } from "../core/notebook.js";
import type { CellOutput, TableData } from "../core/output.js";
import type { Followed } from "../core/watcher.js";
import { commandFor } from "./keys.js";
import type { Part } from "./detail.js";
import { orderedColumns } from "./table.js";
import { type TableSession, parseFilter, tableSession } from "./table-session.js";
import { oneLine } from "./text.js";
import { cellTitle } from "./titles.js";
import type { ViewHost } from "./view-host.js";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class TableController {
  /** The table the keys drive. */
  active: { cell: string; objectId: string } | undefined;
  /** Where the detail was scrolled to before the table took it. */
  returnScroll: number | undefined;
  /** Scroll of an open row or column card. */
  cardScroll = 0;

  constructor(private readonly host: ViewHost) {}

  /** The session and current data of a cell's marimo table, when the view can drive it. */
  sessionFor(f: Followed, cell: Cell, source?: string | CellOutput): { session: TableSession; data: TableData } | undefined {
    const id = typeof source === "string" ? source : this.active?.cell === cell.id ? this.active.objectId : undefined;
    // A supplied leaf is authoritative, including a static table without an object id.
    const t = typeof source === "object" ? source.table : id ? [cell.output, ...(cell.output?.blocks?.map(block => block.output) ?? [])].find(output => output?.table?.objectId === id)?.table : cell.output?.table;
    if (!t?.objectId || !this.host.actions.table || f.connection !== "connected") return undefined;
    const session = tableSession(`${this.host.viewKey()}\0${t.objectId}`, cell, t);
    session.onChange = () => { if (!this.host.isClosed()) this.host.render(); };
    return { session, data: session.data() };
  }

  key(f: Followed | undefined, data: string): void {
    const cell = f && this.active ? f.notebook.cells.get(this.active.cell) : undefined;
    const t = f && cell ? this.sessionFor(f, cell) : undefined;
    const rpc = this.host.actions.table;
    if (!f || !cell || !t || !rpc || !this.active) { this.active = undefined; return; }
    const s = t.session;
    const objectId = this.active.objectId;
    this.host.setNote(undefined);
    const command = commandFor("table", data)?.id;
    if (command === "table-close") {
      if (s.card) { s.closeCard(); this.cardScroll = 0; }
      else { this.active = undefined; this.host.setDetailScroll(this.returnScroll ?? this.host.getDetailScroll()); this.returnScroll = undefined; }
      return;
    }
    if (command === "help") { this.host.openHelp(); return; }
    if (s.card && (command === "table-down" || command === "table-up" || command === "table-next" || command === "table-previous" || command === "table-first" || command === "table-last")) {
      const delta = command === "table-down" ? 1 : command === "table-up" ? -1 : command === "table-next" ? this.host.viewport() : command === "table-previous" ? -this.host.viewport() : 0;
      this.cardScroll = command === "table-first" ? 0 : command === "table-last" ? Number.MAX_SAFE_INTEGER : Math.max(0, this.cardScroll + delta);
      return;
    }
    if (command === "table-down") s.move(f, rpc, 1, 0);
    else if (command === "table-up") s.move(f, rpc, -1, 0);
    else if (command === "table-left") s.move(f, rpc, 0, -1);
    else if (command === "table-right") s.move(f, rpc, 0, 1);
    else if (command === "table-next") s.setPage(f, rpc, s.page + 1);
    else if (command === "table-previous") s.setPage(f, rpc, s.page - 1);
    else if (command === "table-first") s.setPage(f, rpc, 0);
    else if (command === "table-last") {
      const n = s.pageCount();
      if (n === undefined) this.host.setNote("marimo did not count the rows: ] pages forward.");
      else s.setPage(f, rpc, n - 1);
    } else if (command === "table-larger") s.setPageSize(f, rpc, 1);
    else if (command === "table-smaller") s.setPageSize(f, rpc, -1);
    else if (command === "table-sort" || command === "table-sort-add") s.toggleSort(f, rpc, s.columnName(), command === "table-sort-add");
    else if (command === "table-search") {
      this.host.openDock({
        kind: "table",
        title: `Search ${cellTitle(f.notebook, cell)}`,
        hint: "enter search · empty clears · esc cancel",
        initial: s.query,
        submit: (text) => { this.host.closeDock(); s.setQuery(f, rpc, text); this.host.render(); },
        cancel: () => { this.host.closeDock(); this.host.render(); },
      });
    } else if (command === "table-filter") {
      const column = s.columnName();
      const kind = t.data.fieldTypes?.[column]?.kind ?? "string";
      this.host.openDock({
        kind: "table",
        title: `Filter ${oneLine(column)} (${oneLine(kind)}): > 5 · 1..10 · in a, b · null · !null · ~regex · text`,
        hint: "enter filter · esc cancel",
        submit: (text) => {
          const parsed = parseFilter(column, kind, text);
          if ("error" in parsed) { this.host.setNote(parsed.error); this.host.render(); return; }
          this.host.closeDock();
          s.addFilter(f, rpc, parsed);
          this.host.render();
        },
        cancel: () => { this.host.closeDock(); this.host.render(); },
      });
    } else if (command === "table-clear") s.clearFilters(f, rpc);
    else if (command === "table-select") {
      const value = this.host.actions.setTableSelection ? s.toggleSelect(f.notebook) : undefined;
      if (!value) this.host.setNote("This table has no selection.");
      else this.host.actions.setTableSelection!(f, cell, objectId, value);
    } else if (command === "table-row") s.openRow();
    else if (command === "table-column") s.openColumn(f, rpc);
    else if (command === "table-summary") s.toggleSummaries(f, rpc);
    else if (command === "table-copy") this.host.copy(s.cellValue());
    else if (command === "table-copy-row") this.host.copy(s.toTsv());
    else if (command === "table-csv") {
      const save = this.host.actions.saveTable;
      if (!save) this.host.setNote("Not available here.");
      else {
        this.host.setNote("Saving…");
        save(f, cell, objectId).then(
          (name) => { if (!this.host.isClosed()) { this.host.setNote(`Saved ${name}.`); this.host.render(); } },
          (e: unknown) => { if (!this.host.isClosed()) { this.host.setNote(`Could not save: ${message(e)}`); this.host.render(); } },
        );
      }
    } else if (command === "table-shrink") s.resizeColumn(s.columnName(), -2);
    else if (command === "table-grow") s.resizeColumn(s.columnName(), 2);
    else if (command === "table-fit") s.fitColumn(s.columnName());
    else if (command === "table-value") this.host.showMessage(s.fullCellValue());
    else if (command === "table-pick") {
      const names = orderedColumns(t.data);
      const choices = ["Cancel", ...names.map((name, i) => `${i + 1}. ${oneLine(name)}`)];
      void this.host.confirm("Choose table column", choices).then(choice => {
        const index = choices.indexOf(choice ?? "") - 1;
        if (index >= 0 && this.active?.objectId === objectId) { s.col = index; s.ensureVisible(Math.max(1, this.host.outlineWidth())); this.host.render(); }
      }).catch(e => { this.host.setNote(message(e)); this.host.render(); });
    } else if (command === "table-refresh") void s.refresh(f, rpc);
  }

  /** `t`: drive the table of the cursor's cell (or the focused part). */
  enter(f: Followed, cell: Cell | undefined, focused: Part | undefined): void {
    const target = focused?.kind === "table" ? f.notebook.cells.get(focused.cell) : cell;
    const objectId = focused?.kind === "table" ? focused.tableObjectId ?? focused.output?.table?.objectId : target?.output?.table?.objectId;
    if (!target || !objectId) { this.host.setNote("This cell shows no table marimo can page."); return; }
    if (!this.host.actions.table || f.connection !== "connected") { this.host.setNote("This cell shows no table marimo can page: the table needs a connected notebook."); return; }
    if (!this.active) this.returnScroll = this.host.getDetailScroll();
    this.cardScroll = 0;
    this.active = { cell: target.id, objectId };
    this.host.selectCell(target.id);
  }
}
