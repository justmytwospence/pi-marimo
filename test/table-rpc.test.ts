import { describe, expect, test, vi } from "vitest";
import type { TableData } from "../src/core/output.js";
import type { Followed } from "../src/core/watcher.js";
import { TableSession, type TableRpc } from "../src/ui/table-session.js";
import { layoutTable } from "../src/ui/table.js";
import { editableMarkdown, markdownCellCode } from "../src/core/markdown.js";
import { FUNCTION_CALL_PREFIX, NotebookState } from "../src/core/notebook.js";
import { summarizeOutput } from "../src/core/output.js";
import { callFunction, parseSearch } from "../src/core/table-rpc.js";

const attachment = { url: "http://127.0.0.1:1", sessionId: "s" };

function target() {
  const notebook = new NotebookState();
  return { attachment, notebook };
}

describe("function calls", () => {
  test("results with our prefix are stored, others ignored", () => {
    const nb = new NotebookState();
    expect(nb.apply("function-call-result", { function_call_id: `${FUNCTION_CALL_PREFIX}1`, return_value: 1, status: { code: "ok" } })).toBe(false);
    nb.apply("function-call-result", { function_call_id: "browser-1", return_value: 2, status: { code: "ok" } });
    expect([...nb.functionResults.keys()]).toEqual([`${FUNCTION_CALL_PREFIX}1`]);
  });

  test("callFunction posts camelCase and resolves with the result", async () => {
    const t = target();
    const posts: any[] = [];
    const post = async (_t: unknown, endpoint: string, body: any) => {
      posts.push({ endpoint, body });
      t.notebook.apply("function-call-result", { function_call_id: body.functionCallId, return_value: { ok: 1 }, status: { code: "ok" } });
    };
    await expect(callFunction(t, "bkHC-0", "search", { page_size: 5 }, { post })).resolves.toEqual({ ok: 1 });
    expect(posts[0].endpoint).toBe("function_call");
    expect(posts[0].body).toMatchObject({ namespace: "bkHC-0", functionName: "search", args: { page_size: 5 } });
    expect(posts[0].body.functionCallId.startsWith(FUNCTION_CALL_PREFIX)).toBe(true);
    expect(t.notebook.functionResults.size).toBe(0);
  });

  test("an error status rejects with its message; no answer times out", async () => {
    const t = target();
    const bad = async (_t: unknown, _e: string, body: any) => {
      t.notebook.apply("function-call-result", { function_call_id: body.functionCallId, return_value: null, status: { code: "error", message: "boom" } });
    };
    await expect(callFunction(t, "x", "search", {}, { post: bad })).rejects.toThrow("boom");
    await expect(callFunction(t, "x", "search", {}, { post: async () => {}, waitMs: 50 })).rejects.toThrow("did not answer search");
  });

  test("parseSearch reads inline JSON and file references", async () => {
    const file = async (ref: string) => (ref === "./@file/x" ? '[{"a":2}]' : "[]");
    await expect(parseSearch({ data: '[{"a":1}]', total_rows: 7 }, file)).resolves.toMatchObject({ records: [{ a: 1 }], totalRows: 7 });
    await expect(parseSearch({ data: "./@file/x", total_rows: "too_many" }, file)).resolves.toMatchObject({ records: [{ a: 2 }], totalRows: "many" });
  });
});

function sessionFixture(extra: Partial<TableData> = {}) {
  const data: TableData = {
    objectId: "table", columns: ["a", "b", "c"], numeric: [false, false, false],
    rows: [], records: Array.from({ length: 5 }, (_, i) => ({ a: `row ${i}`, b: i, c: null, _marimo_row_id: `id-${i}` })),
    pageSize: 5, totalRows: 20, ...extra,
  };
  const f = target() as Followed;
  const requests: Array<{ args: any; resolve(value: unknown): void; reject(error: unknown): void }> = [];
  const rpc: TableRpc = {
    call: vi.fn((_f, _id, _fn, args) => new Promise((resolve, reject) => { requests.push({ args, resolve, reject }); })),
    file: vi.fn(async () => "[]"),
  };
  return { s: new TableSession({}, data), data, f, rpc, requests };
}

async function settle(): Promise<void> {
  // Search parses file/inline results before committing the page.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("table sessions", () => {
  test("width overrides clamp, fit loaded values by terminal width, and notify without fetching", () => {
    const { s, rpc } = sessionFixture({ columns: ["界é", "b"], records: [{ "界é": "界界界é\nx", b: "x".repeat(200) }], rows: [] });
    const change = vi.fn(); s.onChange = change;
    expect(s.rowOffset).toBe(0);
    s.fitColumn("界é"); expect(s.columnWidths.get("界é")).toBe(9); // newline is flattened in the rendered cell
    s.resizeColumn("界é", 2); expect(s.columnWidths.get("界é")).toBe(11);
    s.resizeColumn("界é", -1000); expect(s.columnWidths.get("界é")).toBe(4);
    s.resizeColumn("界é", 1000); expect(s.columnWidths.get("界é")).toBe(120);
    s.fitColumn("b"); expect(s.columnWidths.get("b")).toBe(120);
    s.resizeColumn("missing", 2); s.resizeColumn("b", NaN);
    expect(change).toHaveBeenCalledTimes(5);
    expect(rpc.call).not.toHaveBeenCalled();
  });

  test("resize starts from layout's notebook width; fit uses the fetched page, not prior rows", async () => {
    const { s, f, rpc, requests } = sessionFixture({ widths: { a: 80 } });
    const initial = layoutTable(s.data(), 1000).columns.find((c) => c.column === "a")!.width;
    s.colOffset = 2;
    s.resizeColumn("a", 2); expect(s.columnWidths.get("a")).toBe(initial + 2);
    s.setQuery(f, rpc, "next");
    requests[0]!.resolve({ data: [{ a: "abcdefghijklmnop" }], total_rows: 1 }); await settle();
    s.fitColumn("a"); expect(s.columnWidths.get("a")).toBe(16);
  });

  test("fit measures all loaded rows and honors minimum/header width", () => {
    const { s } = sessionFixture({ columns: ["a", "long header"], records: Array.from({ length: 25 }, (_, i) => ({ a: i === 24 ? "x".repeat(60) : "x" })) });
    s.fitColumn("a"); expect(s.columnWidths.get("a")).toBe(60);
    s.fitColumn("long header"); expect(s.columnWidths.get("long header")).toBe(11);
    const empty = sessionFixture({ records: [], rows: [] }).s;
    empty.fitColumn("a"); expect(empty.columnWidths.get("a")).toBe(4);
    const numbers = sessionFixture({ columns: ["n"], records: [{ n: 709000 }], fieldTypes: { n: { kind: "integer", dtype: "int64" } } }).s;
    numbers.fitColumn("n"); expect(numbers.columnWidths.get("n")).toBe(7); // 709,000, not the raw six digits
  });

  test("all server navigation resets body offset but preserves sizing", () => {
    const { s, f, rpc } = sessionFixture();
    s.resizeColumn("a", 10);
    const widths = [...s.columnWidths];
    const actions = [
      () => s.setPage(f, rpc, 1), () => s.setPageSize(f, rpc, 1),
      () => s.toggleSort(f, rpc, "a", false), () => s.setQuery(f, rpc, "  coffee  "),
      () => s.addFilter(f, rpc, { type: "condition", column_id: "a", operator: "equals", value: "x", negate: false }),
      () => s.clearFilters(f, rpc),
    ];
    for (const action of actions) {
      s.rowOffset = 4; s.row = 3; action();
      expect(s.rowOffset).toBe(0); expect(s.row).toBe(0); expect([...s.columnWidths]).toEqual(widths);
    }
  });

  test("moving across pages resets offset and clamps asynchronous short/empty pages", async () => {
    const { s, f, rpc, requests } = sessionFixture();
    s.row = 4; s.rowOffset = 3; s.move(f, rpc, 1, 0);
    expect([s.page, s.row, s.rowOffset]).toEqual([1, 0, 0]);
    requests[0]!.resolve({ data: [{ a: "only" }], total_rows: 6 }); await settle();
    s.rowOffset = 5; s.col = 99; s.move(f, rpc, -1, 0);
    expect([s.page, s.row, s.rowOffset]).toEqual([0, 4, 0]);
    // The default-page shortcut restores and clamps to the original records.
    expect(s.col).toBe(2);
    s.setQuery(f, rpc, "short"); s.row = 50; s.col = 50; s.rowOffset = 50;
    requests[1]!.resolve({ data: [{ a: "one" }, { a: "two" }], total_rows: 2 }); await settle();
    expect([s.row, s.col, s.rowOffset]).toEqual([1, 2, 1]);
    s.setQuery(f, rpc, "empty"); s.row = 9; s.col = -1; s.rowOffset = 9;
    requests[2]!.resolve({ data: [], total_rows: 0 }); await settle();
    expect([s.row, s.col, s.rowOffset]).toEqual([0, 0, 0]);
  });

  test("latest search wins, including errors and delayed file parsing", async () => {
    const { s, f, rpc, requests } = sessionFixture();
    let resolveFile!: (value: string) => void;
    rpc.file = vi.fn(() => new Promise((resolve) => { resolveFile = resolve; }));
    s.setQuery(f, rpc, "old"); requests[0]!.resolve({ data: "./@file/old", total_rows: 99 }); await settle();
    s.setQuery(f, rpc, "new"); requests[1]!.resolve({ data: [{ a: "new" }], total_rows: 1 }); await settle();
    resolveFile('[{"a":"old"}]'); await settle();
    expect(s.data().records).toEqual([{ a: "new" }]); expect(s.loading).toBe(false);
    s.setQuery(f, rpc, "fail-old"); s.setQuery(f, rpc, "pending");
    requests[2]!.reject(new Error("stale")); await settle();
    expect(s.error).toBeUndefined(); expect(s.loading).toBe(true);
    requests[3]!.reject(new Error("current")); await settle();
    expect(s.error).toBe("current"); expect(s.loading).toBe(false);
    expect(requests).toHaveLength(4); // No uncertain calls are retried.
  });

  test.each(["success", "error"])("default shortcut invalidates pending %s", async (outcome) => {
    const { s, data, f, rpc, requests } = sessionFixture();
    s.setQuery(f, rpc, "pending"); expect(s.loading).toBe(true);
    s.rowOffset = 3; s.clearFilters(f, rpc);
    expect(s.loading).toBe(false); expect(s.rowOffset).toBe(0);
    if (outcome === "success") requests[0]!.resolve({ data: [{ a: "stale" }], total_rows: 1 });
    else requests[0]!.reject(new Error("stale"));
    await settle();
    expect(s.data()).toBe(data); expect(s.error).toBeUndefined(); expect(s.fetched).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  test("sort/filter/query are sent to marimo without page-local fake sorting", async () => {
    const { s, f, rpc, requests } = sessionFixture();
    s.toggleSort(f, rpc, "b", false); s.toggleSort(f, rpc, "a", true);
    expect(requests[1]!.args.sort).toEqual([{ by: "b", descending: false }, { by: "a", descending: false }]);
    s.toggleSort(f, rpc, "b", true);
    expect(s.sort).toEqual([{ by: "a", descending: false }, { by: "b", descending: true }]);
    s.setQuery(f, rpc, "  beans  ");
    const filter = { type: "condition" as const, column_id: "b", operator: ">", value: 3, negate: false };
    s.addFilter(f, rpc, filter);
    expect(requests[4]!.args).toMatchObject({ page_number: 0, page_size: 5, query: "beans", filters: { type: "group", operator: "and", children: [filter] } });
    requests[4]!.resolve({ data: [{ b: 8 }, { b: 2 }], total_rows: "too_many" }); await settle();
    expect(s.data().records).toEqual([{ b: 8 }, { b: 2 }]); expect(s.pageCount()).toBeUndefined();
  });

  test("ensureVisible shares layout sizing, frozen membership and scrolling", () => {
    const { s } = sessionFixture({ columns: ["left", "a", "b", "c", "right"], freezeLeft: ["left"], freezeRight: ["right"], records: [] });
    for (const c of s.data().columns) s.columnWidths.set(c, 12);
    s.col = 3; s.ensureVisible(58);
    const layout = () => layoutTable(s.data(), 58, { focused: true, cursorRow: s.row, cursorCol: s.col, colOffset: s.colOffset, columnWidths: s.columnWidths, selected: new Set(), sort: [], firstRow: 0, rowIdOf: String });
    expect(s.colOffset).toBeGreaterThan(0); expect(layout().columns.some((c) => c.column === "c")).toBe(true);
    s.col = 1; s.ensureVisible(58); expect(s.colOffset).toBe(0);
    const offset = s.colOffset; s.col = 4; s.ensureVisible(58); expect(s.colOffset).toBe(offset);
  });

  test("full inspection is raw while copy/export preserve their compact semantics", () => {
    const raw = "first\nsecond\t" + "界".repeat(220);
    const { s } = sessionFixture({ columns: ["a", "b", "c", "missing"], records: [{ a: raw, b: { nested: [1, null] }, c: null }], rows: [["fallback", "", "", "invented"]] });
    expect(s.fullCellValue()).toBe(raw); expect(s.cellValue()).toBe(raw);
    s.col = 1; expect(s.fullCellValue()).toBe(JSON.stringify({ nested: [1, null] }, null, 2)); expect(s.cellValue()).toBe('{"nested":[1,null]}');
    s.col = 2; expect(s.fullCellValue()).toBe("NULL"); expect(s.cellValue()).toBe("");
    s.col = 3; expect(s.fullCellValue()).toBe("unavailable"); expect(s.cellValue()).toBe("");
    expect(s.toTsv()).toBe(`${raw.replace(/[\t\n]/gu, " ")}\t{"nested":[1,null]}\t\t`);
    s.row = 99; expect(s.fullCellValue()).toBe("unavailable");
    const plain = sessionFixture({ columns: ["a"], records: undefined, rows: [["hello\nworld"]] }).s;
    expect(plain.fullCellValue()).toBe("hello\nworld");
  });

  test("cursor motion does not mutate selection; toggles retain row ids and cells", () => {
    const { s, f, rpc } = sessionFixture({ selection: "multi", initialValue: ["id-0"] });
    s.move(f, rpc, 1, 1); expect(s.selection(f.notebook)).toEqual(["id-0"]);
    expect(s.toggleSelect(f.notebook)).toEqual(["id-0", "id-1"]);
    const cells = sessionFixture({ selection: "multi-cell", initialValue: [{ rowId: "id-0", columnName: "a" }] });
    expect(cells.s.toggleSelect(cells.f.notebook)).toEqual([]);
    cells.s.col = 1;
    expect(cells.s.toggleSelect(cells.f.notebook)).toEqual([{ rowId: "id-0", columnName: "a" }, { rowId: "id-0", columnName: "b" }]);
  });
});

describe("table metadata", () => {
  test("a marimo table keeps its object id, types, selection and column settings", () => {
    const html = `<marimo-ui-element object-id='bkHC-0' random-id='x'><marimo-table data-label='"T"' data-data='[{"Index0":0,"a":1,"b":"x","_marimo_row_id":"0"}]' data-total-rows='30' data-field-types='[["a",["integer","int64"]],["b",["string","object"]]]' data-selection='"multi"' data-hidden-columns='["b"]' data-freeze-columns-left='["a"]'></marimo-table></marimo-ui-element>`;
    const t = summarizeOutput({ channel: "output", mimetype: "text/html", data: html })!.table!;
    expect(t).toMatchObject({ objectId: "bkHC-0", selection: "multi", hidden: ["b"], freezeLeft: ["a"], columns: ["a"], rowHeaders: ["Index0"], label: "T" });
    expect(t.fieldTypes?.a).toEqual({ kind: "integer", dtype: "int64" });
    expect(t.records?.[0]?._marimo_row_id).toBe("0");
    const lazy = summarizeOutput({ channel: "output", mimetype: "text/html", data: `<marimo-ui-element object-id='k-0'><marimo-table data-data='"./@file/1.json"' data-total-rows='5' data-field-types='[["a",["integer","int64"]]]'></marimo-table></marimo-ui-element>` })!.table!;
    expect(lazy).toMatchObject({ objectId: "k-0", dataRef: "./@file/1.json", columns: ["a"], records: [] });
  });
});

describe("markdown cell code", () => {
  test("round trips exact drafts without accumulating framing newlines", () => {
    for (const text of ["", "# Title", 'say """hi"""', "# T\n\n", "  text  \n\t\n"]) {
      let code = markdownCellCode(text);
      for (let cycle = 0; cycle < 5; cycle++) {
        const draft = editableMarkdown(code);
        expect(draft).toBe(text);
        expect(markdownCellCode(draft!)).toBe(code);
        code = markdownCellCode(draft!);
      }
    }
    expect(markdownCellCode("# T\n\n")).toBe('mo.md(r"""# T\n\n""")');
  });
  test("f-string markdown is not editable", () => {
    expect(editableMarkdown('mo.md(f"# {x}")')).toBeUndefined();
    expect(editableMarkdown('mo.md("# a")')).toBe("# a");
  });
});

describe("expected edits", () => {
  test("a code-mode edit Pi made is not an agent change", async () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: ["a"], codes: ['mo.md("# a")'], names: ["_"] });
    (nb as any).readyAt = Date.now() - 5000;
    nb.expectEdit("a", 'mo.md(r"""\n# b\n""")');
    nb.apply("notebook-document-transaction", { transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "a", code: 'mo.md(r"""\n# b\n""")' }] } });
    expect(nb.agentChanges.size).toBe(0);
    nb.apply("notebook-document-transaction", { transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "a", code: "x = 1" }] } });
    expect(nb.agentChanges.get("a")?.kind).toBe("edited");
  });
});
