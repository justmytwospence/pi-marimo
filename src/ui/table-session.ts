// The state of one marimo table the notebook view drives: its page, sort, search and filters, the
// cursor, the summaries and cards. The rows come from the table's own `search` function (through
// TableRpc), so paging, sorting and filtering happen in marimo, as in the browser. Sessions live in
// a module store keyed by notebook and object id, so leaving table mode (or docking) keeps them; a
// rerun of the cell (a new output) starts the table over.
import type { Cell, NotebookState } from "../core/notebook.js";
import { cellText, type TableData } from "../core/output.js";
import { type ColumnSummaries, type FilterCondition, type SearchResult, parseSearch, parseSummaries, parseTopK } from "../core/table-rpc.js";
import type { Followed } from "../core/watcher.js";
import { columnGroups, layoutTable, measureColumn, orderedColumns, type TableRender } from "./table.js";

export interface TableRpc {
  call(f: Followed, objectId: string, fn: string, args: unknown): Promise<unknown>;
  file(f: Followed, ref: string): Promise<string>;
}

export interface SortArg { by: string; descending: boolean }
export type Card = { kind: "row"; index: number } | { kind: "column"; column: string; top?: Array<[string, number]> };

export const PAGE_SIZES = [5, 10, 25, 50, 100];

const store = new Map<string, TableSession>();
export function clearTableSessions(): void {
  store.clear();
}

export function tableSession(key: string, cell: Cell, data: TableData): TableSession {
  const known = store.get(key);
  if (known && known.source === cell.output) return known;
  const session = new TableSession(cell.output, data);
  store.set(key, session);
  return session;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class TableSession {
  page = 0;
  pageSize: number;
  sort: SortArg[] = [];
  query = "";
  filters: FilterCondition[] = [];
  row = 0;
  col = 0;
  colOffset = 0;
  rowOffset = 0;
  columnWidths = new Map<string, number>();
  summaries: ColumnSummaries | undefined;
  summariesOn = false;
  card: Card | undefined;
  fetched: SearchResult | undefined;
  loading = false;
  error: string | undefined;
  onChange: (() => void) | undefined;
  private seq = 0;
  private asked = false;

  constructor(readonly source: unknown, private readonly base: TableData) {
    this.pageSize = base.pageSize ?? 10;
  }

  private changed(): void {
    this.onChange?.();
  }

  /** The table as drawn now: the page marimo's `search` returned, else the HTML's first page. */
  data(): TableData {
    const f = this.fetched;
    if (!f) return this.base;
    return {
      ...this.base,
      records: f.records,
      rows: f.records.map((r) => this.base.columns.map((c) => cellText(r[c]))),
      totalRows: f.totalRows,
      ...(f.cellStyles ? { cellStyles: f.cellStyles } : {}),
      pageSize: this.pageSize,
    };
  }

  isDefault(): boolean {
    return this.page === 0 && this.pageSize === (this.base.pageSize ?? 10) && !this.sort.length && !this.query && !this.filters.length;
  }

  /** The rows are not here yet (a file or lazy table): the view asks once. */
  needsFetch(): boolean {
    return !this.asked && !this.fetched && !(this.base.records?.length) && (!!this.base.dataRef || !!this.base.lazy);
  }

  refresh(f: Followed, rpc: TableRpc): Promise<void> {
    this.asked = true;
    const objectId = this.base.objectId;
    if (!objectId) return Promise.resolve();
    const my = ++this.seq;
    if (this.isDefault() && this.base.records?.length) {
      this.fetched = undefined;
      this.loading = false;
      this.error = undefined;
      this.clampCursor();
      this.changed();
      return Promise.resolve();
    }
    this.loading = true;
    this.error = undefined;
    this.changed();
    const args = {
      page_size: this.pageSize,
      page_number: this.page,
      ...(this.query ? { query: this.query } : {}),
      ...(this.sort.length ? { sort: this.sort } : {}),
      ...(this.filters.length ? { filters: { type: "group", operator: "and", negate: false, children: this.filters } } : {}),
    };
    return rpc.call(f, objectId, "search", args)
      .then((value) => parseSearch(value, (ref) => rpc.file(f, ref)))
      .then(
        (result) => { if (my === this.seq) { this.fetched = result; this.loading = false; this.clampCursor(); } },
        (e: unknown) => { if (my === this.seq) { this.error = message(e); this.loading = false; } },
      )
      .finally(() => this.changed());
  }

  private pages(): number {
    const total = this.fetched?.totalRows ?? this.base.totalRows;
    return typeof total === "number" ? Math.max(1, Math.ceil(total / this.pageSize)) : Number.MAX_SAFE_INTEGER;
  }

  /** How many pages the table has; undefined when marimo did not count its rows. */
  pageCount(): number | undefined {
    const n = this.pages();
    return n === Number.MAX_SAFE_INTEGER ? undefined : n;
  }

  private rowsHere(): number {
    return this.fetched?.records.length ?? this.base.records?.length ?? this.base.rows.length;
  }

  private clampCursor(): void {
    this.row = Math.max(0, Math.min(this.row, this.rowsHere() - 1));
    this.col = Math.max(0, Math.min(this.col, orderedColumns(this.base).length - 1));
    this.rowOffset = Math.max(0, Math.min(this.rowOffset, this.rowsHere() - 1));
    this.colOffset = Math.max(0, Math.min(this.colOffset, columnGroups(this.base).middle.length - 1));
  }

  private render(): TableRender {
    return {
      focused: true, cursorRow: this.row, cursorCol: this.col,
      colOffset: this.colOffset, columnWidths: this.columnWidths,
      selected: new Set<string>(), sort: this.sort,
      rowIdOf: (i) => this.rowId(i), firstRow: this.page * this.pageSize,
    };
  }

  /** Resize from the same effective width the renderer uses, retaining it across pages. */
  resizeColumn(column: string, delta: number): void {
    if (!this.base.columns.includes(column) || !Number.isFinite(delta)) return;
    const width = this.columnWidths.get(column) ?? layoutTable(this.data(), Number.MAX_SAFE_INTEGER, { ...this.render(), colOffset: 0 }).columns.find((c) => c.column === column)?.width ?? 4;
    this.columnWidths.set(column, Math.max(4, Math.min(120, Math.round(width + delta))));
    this.changed();
  }

  /** Fit only the loaded header and values, measured in terminal columns rather than characters. */
  fitColumn(column: string): void {
    if (!this.base.columns.includes(column)) return;
    const width = measureColumn(this.data(), column, this.sort);
    this.columnWidths.set(column, Math.max(4, Math.min(120, width)));
    this.changed();
  }

  /** Moves the cursor; past the page's edge, the page turns. */
  move(f: Followed, rpc: TableRpc, dr: number, dc: number): void {
    if (dr) {
      const next = this.row + dr;
      if (next >= this.rowsHere()) {
        if (this.page + 1 < this.pages() && this.rowsHere() >= this.pageSize) { this.page++; this.row = 0; this.rowOffset = 0; void this.refresh(f, rpc); }
        else this.row = Math.max(0, this.rowsHere() - 1);
      } else if (next < 0) {
        if (this.page > 0) { this.page--; this.row = this.pageSize - 1; this.rowOffset = 0; void this.refresh(f, rpc); }
        else this.row = 0;
      } else this.row = next;
    }
    if (dc) this.col = Math.max(0, Math.min(orderedColumns(this.base).length - 1, this.col + dc));
    this.changed();
  }

  /** Keeps the cursor column inside the scrolled window at this width. */
  ensureVisible(width: number): void {
    const column = orderedColumns(this.base)[this.col];
    const middle = columnGroups(this.base).middle;
    const at = column === undefined ? -1 : middle.indexOf(column);
    if (at < 0) return;
    if (at < this.colOffset) this.colOffset = at;
    const d = this.data();
    for (let guard = 0; guard < middle.length; guard++) {
      const layout = layoutTable(d, width, this.render());
      if (layout.columns.some((c) => c.column === column) || this.colOffset >= at) break;
      this.colOffset++;
    }
  }

  setPage(f: Followed, rpc: TableRpc, n: number): void {
    this.page = Math.max(0, Math.min(this.pages() - 1, n));
    this.row = 0;
    this.rowOffset = 0;
    void this.refresh(f, rpc);
  }

  setPageSize(f: Followed, rpc: TableRpc, by: 1 | -1): void {
    const at = PAGE_SIZES.indexOf(this.pageSize);
    this.pageSize = PAGE_SIZES[(Math.max(0, at) + by + PAGE_SIZES.length) % PAGE_SIZES.length]!;
    this.page = 0;
    this.row = 0;
    this.rowOffset = 0;
    void this.refresh(f, rpc);
  }

  toggleSort(f: Followed, rpc: TableRpc, column: string, add: boolean): void {
    const current = this.sort.find((s) => s.by === column);
    const next: SortArg | undefined = !current ? { by: column, descending: false } : !current.descending ? { by: column, descending: true } : undefined;
    const others = add ? this.sort.filter((s) => s.by !== column) : [];
    this.sort = [...others, ...(next ? [next] : [])];
    this.page = 0;
    this.row = 0;
    this.rowOffset = 0;
    void this.refresh(f, rpc);
  }

  setQuery(f: Followed, rpc: TableRpc, q: string): void {
    this.query = q.trim();
    this.page = 0;
    this.row = 0;
    this.rowOffset = 0;
    void this.refresh(f, rpc);
  }

  addFilter(f: Followed, rpc: TableRpc, c: FilterCondition): void {
    this.filters = [...this.filters, c];
    this.page = 0;
    this.row = 0;
    this.rowOffset = 0;
    void this.refresh(f, rpc);
  }

  clearFilters(f: Followed, rpc: TableRpc): void {
    this.filters = [];
    this.query = "";
    this.page = 0;
    this.row = 0;
    this.rowOffset = 0;
    void this.refresh(f, rpc);
  }

  toggleSummaries(f: Followed, rpc: TableRpc): void {
    this.summariesOn = !this.summariesOn;
    this.changed();
    const objectId = this.base.objectId;
    if (!this.summariesOn || this.summaries || !objectId) return;
    rpc.call(f, objectId, "get_column_summaries", {}).then(
      (v) => { this.summaries = parseSummaries(v); },
      (e: unknown) => { this.error = message(e); this.summariesOn = false; },
    ).finally(() => this.changed());
  }

  openRow(): void {
    this.card = { kind: "row", index: this.row };
    this.changed();
  }

  openColumn(f: Followed, rpc: TableRpc): void {
    const column = orderedColumns(this.base)[this.col] ?? this.base.columns[0];
    const objectId = this.base.objectId;
    if (!column || !objectId) return;
    const card: Card = { kind: "column", column };
    this.card = card;
    this.changed();
    if (!this.summaries) {
      rpc.call(f, objectId, "get_column_summaries", {}).then((v) => { this.summaries = parseSummaries(v); }, () => undefined).finally(() => this.changed());
    }
    rpc.call(f, objectId, "calculate_top_k_rows", { column, k: 10 }).then(
      (v) => { card.top = parseTopK(v); },
      (e: unknown) => { this.error = message(e); },
    ).finally(() => this.changed());
  }

  closeCard(): void {
    this.card = undefined;
    this.changed();
  }

  columnName(): string {
    return orderedColumns(this.base)[this.col] ?? this.base.columns[0] ?? "";
  }

  rowId(i: number): string {
    const id = this.data().records?.[i]?._marimo_row_id;
    return String(id ?? this.page * this.pageSize + i);
  }

  /** The selected row ids (or cells), from the notebook's widget values. */
  selection(nb: NotebookState): unknown[] {
    const objectId = this.base.objectId;
    const value = (objectId ? nb.uiValues.get(objectId) : undefined) ?? this.base.initialValue ?? [];
    return Array.isArray(value) ? value : [value];
  }

  /** The value to send for toggling the row (or cell) under the cursor; undefined when the table has no selection. */
  toggleSelect(nb: NotebookState): unknown[] | undefined {
    const mode = this.base.selection;
    if (!mode) return undefined;
    const current = this.selection(nb);
    const id = this.rowId(this.row);
    if (mode === "single-cell" || mode === "multi-cell") {
      const cell = { rowId: id, columnName: this.columnName() };
      const same = (v: unknown) => typeof v === "object" && v !== null && (v as { rowId?: unknown }).rowId === id && (v as { columnName?: unknown }).columnName === cell.columnName;
      const has = current.some(same);
      const rest = current.filter((v) => !same(v));
      return has ? rest : mode === "single-cell" ? [cell] : [...rest, cell];
    }
    const has = current.some((v) => String(v) === id);
    const rest = current.filter((v) => String(v) !== id);
    return has ? rest : mode === "single" ? [id] : [...rest, id];
  }

  /** Raw value for inspection; unlike copy/export, null and unavailable are explicit. */
  fullCellValue(): string {
    const d = this.data();
    const column = this.columnName();
    const record = d.records?.[this.row];
    if (d.records && (!record || !Object.hasOwn(record, column))) return "unavailable";
    const value = record ? record[column] : d.rows[this.row]?.[d.columns.indexOf(column)];
    if (value === undefined) return "unavailable";
    if (value === null) return "NULL";
    return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  }

  cellValue(): string {
    const r = this.data().records?.[this.row];
    const column = this.columnName();
    const v = r ? r[column] : this.data().rows[this.row]?.[this.base.columns.indexOf(column)];
    return v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  }

  toTsv(): string {
    const d = this.data();
    const r = d.records?.[this.row];
    return orderedColumns(this.base).map((c) => {
      const v = r ? r[c] : d.rows[this.row]?.[d.columns.indexOf(c)];
      return (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/[\t\n]/gu, " ");
    }).join("\t");
  }
}

const NUMBER_OPS = new Set([">", ">=", "<", "<=", "==", "!="]);

/** Reads a filter typed for a column (`> 5`, `1..10`, `in a, b`, `null`, `!latte`, `~re`) into marimo's filter condition. */
export function parseFilter(column: string, kind: string, text: string): FilterCondition | { error: string } {
  let t = text.trim();
  if (!t) return { error: "Type a filter." };
  const cond = (operator: string, value?: unknown, negate = false): FilterCondition => ({ type: "condition", column_id: column, operator, ...(value !== undefined ? { value } : {}), negate });
  const numeric = kind === "integer" || kind === "number";
  const temporal = kind === "date" || kind === "datetime" || kind === "time";
  const num = (s: string): number | { error: string } => {
    const n = Number(s.trim());
    return s.trim() === "" || Number.isNaN(n) ? { error: `not a number: ${s.trim()}` } : n;
  };
  const val = (s: string): unknown | { error: string } => (numeric ? num(s) : s.trim());
  const bad = (v: unknown): v is { error: string } => typeof v === "object" && v !== null && "error" in v;
  if (t === "null") return cond("is_null");
  if (t === "!null" || t === "not null") return cond("is_not_null");
  if (t === "empty") return cond("is_empty");
  let negate = false;
  if (t.startsWith("!") && !t.startsWith("!=") && t !== "!null") { negate = true; t = t.slice(1).trim(); }
  if (kind === "boolean") {
    if (t === "true") return cond("is_true", undefined, negate);
    if (t === "false") return cond("is_false", undefined, negate);
  }
  const between = /^(.+?)\s*\.\.\s*(.+)$/u.exec(t) ?? /^between\s+(\S+)\s+(\S+)$/iu.exec(t);
  if (between && (numeric || temporal)) {
    const min = val(between[1]!);
    const max = val(between[2]!);
    if (bad(min)) return min;
    if (bad(max)) return max;
    return cond("between", { min, max }, negate);
  }
  const list = /^(not\s+in|in)\s+(.+)$/iu.exec(t);
  if (list) {
    const values: unknown[] = [];
    for (const part of list[2]!.split(",")) {
      const v = val(part);
      if (bad(v)) return v;
      values.push(v);
    }
    return cond(/^not/iu.test(list[1]!) ? "not_in" : "in", values, negate);
  }
  const op = /^(>=|<=|==|!=|>|<)\s*(.+)$/u.exec(t);
  if (op) {
    const [, o, rest] = op as unknown as [string, string, string];
    if (numeric || temporal) {
      const v = val(rest);
      return bad(v) ? v : cond(o, v, negate);
    }
    if (o === "==") return cond("equals", rest.trim(), negate);
    if (o === "!=") return cond("does_not_equal", rest.trim(), negate);
    return { error: `${o} needs a number or date column` };
  }
  if (NUMBER_OPS.has(t)) return { error: "Type a value after the operator." };
  if (numeric) {
    const v = num(t);
    return bad(v) ? v : cond("==", v, negate);
  }
  if (t.startsWith("~")) return cond("regex", t.slice(1).trim(), negate);
  if (t.startsWith("^")) return cond("starts_with", t.slice(1), negate);
  if (t.endsWith("$") && t.length > 1) return cond("ends_with", t.slice(0, -1), negate);
  return cond("contains", t, negate);
}
