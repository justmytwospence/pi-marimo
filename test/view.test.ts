import { expect, test, vi } from "vitest";
import { NotebookState } from "../src/core/notebook.js";
import type { Followed } from "../src/core/watcher.js";
import { INPUT_CONTEXT } from "../src/activity.js";
import { NotebookView, notebookLines, detailRows } from "../src/ui/view.js";
import { SessionPreferences } from "../src/ui/settings.js";
import { progressRows } from "../src/ui/progress.js";
import type { ProgressTask } from "../src/core/progress.js";
import { row as notebookRow, CONTENT_LEFT, bodyWidth } from "../src/ui/notebook-frame.js";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { NotebookSource } from "../src/ui/source.js";
import { notebookKey } from "../src/ui/identity.js";
import { InlineEditorManager } from "../src/ui/inline-editor.js";
import type { NeovimOpenOptions, NeovimSession } from "../src/core/neovim.js";
import type { PackageClient, PackageConfirmation } from "../src/core/packages.js";

function fakeEditors() {
  let options: NeovimOpenOptions;
  let text = "";
  const redraw = (width = 80, height = 12) => options.onRedraw?.([
    ["grid_resize", [1, width, height]],
    ["grid_line", [1, 0, 0, Array.from(text.slice(0, width), ch => [ch, 0])]],
    ["flush", []],
  ]);
  const session = {
    input: vi.fn(async (_data: string) => {}),
    focus: vi.fn(async (_focused: boolean) => {}),
    resize: vi.fn(async (width: number, height: number) => redraw(width, height)),
    getText: vi.fn(async () => text),
    replaceText: vi.fn(async (value: string) => { text = value; }),
    setLineNumbers: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const openSession = vi.fn(async (value: NeovimOpenOptions) => {
    options = value; text = value.text; redraw();
    return session as unknown as NeovimSession;
  });
  const editors = new InlineEditorManager(openSession);
  return { editors, session, openSession, options: () => options,
    draft(value: string) { text = value; options.onDraft?.(value); redraw(); } };
}
const editorReady = async () => { await Promise.resolve(); await Promise.resolve(); };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b_pi:[^\x07]*\x07/gu, "");

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const tui = { requestRender: () => {}, terminal: { rows: 28 } };
function followed(url = "http://fixture.invalid", sessionId = "s"): Followed {
  const notebook = new NotebookState();
  notebook.apply("kernel-ready", { cell_ids: Array.from({ length: 100 }, (_, i) => `cell-${i}`), codes: Array(100).fill("x = 1"), names: Array.from({ length: 100 }, (_, i) => `cell-${i}`) });
  return { attachment: { path: "/w/nb.py", url, sessionId }, notebook, connection: "connected", current: true, touchedAt: 0 };
}
function busy(f: Followed) { f.notebook.apply("cell-op", { cell_id: "cell-0", status: "running" }); }

test("page keys scroll the detail by a whole page; j/k move the cursor", () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "long" }, { id: "b", code: "y = 2", name: "next" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/plain", data: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") } });
  const view = new NotebookView(tui as any, theme, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    expect(view.render(100).join("\n")).toContain("line 0");
    view.handleInput("\x1b[6~");
    let text = view.render(100).join("\n");
    expect(text).not.toContain("line 0");
    expect(text).toContain("line 24");
    expect(text).toMatch(/▌  long/u);
    view.handleInput("\x1b[5~");
    text = view.render(100).join("\n");
    expect(text).toContain("line 0");
    view.handleInput("j");
    expect(view.render(100).join("\n")).toMatch(/▌  next/u);
    expect(view[INPUT_CONTEXT]()).toBe("viewer");
  } finally { view.dispose(); }
});

test("the notebook producer rechecks connected busy eligibility before interrupting", async () => {
  const f = followed();
  const key = notebookKey(f);
  const interrupt = vi.fn(async () => {});
  const source = new NotebookSource({ followed: () => [f], open: async () => {}, interrupt, changed: () => {}, hostedChanged: () => {} });
  expect(source.section.canStop!(key)).toBe(false);
  busy(f);
  source.update([f]);
  expect(source.section.canStop!(key)).toBe(true);
  await source.section.stop!(key);
  expect(interrupt).toHaveBeenCalledOnce();
  f.connection = "disconnected";
  expect(source.section.canStop!(key)).toBe(false);
  await source.section.stop!(key);
  expect(interrupt).toHaveBeenCalledOnce();
});

test("two servers hosting the same file have distinct stable rows, interrupts and details", async () => {
  const a = followed("http://server-a.invalid");
  const b = followed("http://server-b.invalid");
  busy(a); busy(b);
  const interrupt = vi.fn(async () => {});
  const source = new NotebookSource({ followed: () => [a, b], open: async () => {}, interrupt, changed: () => {}, hostedChanged: () => {} });
  source.update([a, b]);
  const rows = source.entries(100);
  expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  await source.section.stop!(rows[1]!.key);
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(b);
  const view = new NotebookView(tui as any, theme, rows[1]!.key, { followed: () => [a, b], interrupt, openInBrowser: () => {} }, () => {});
  try {
    expect(view.render(100).join("\n")).toContain("server-b.invalid");
    expect(view.render(100).join("\n")).not.toContain("server-a.invalid");
  } finally { view.dispose(); }
  const before = notebookKey(b);
  b.attachment.sessionId = "reconnected";
  expect(notebookKey(b)).toBe(before);
});

test("confirmation is invalidated by replacement, disappearance, observed idle and disconnect", () => {
  const initial = followed(); busy(initial);
  let all = [initial];
  const interrupt = vi.fn(async () => {});
  const view = new NotebookView(tui as any, theme, notebookKey(initial), { followed: () => all, interrupt, openInBrowser: () => {} }, () => {});
  try {
    view.handleInput("x");
    const replacement = followed(initial.attachment.url, "new-session"); busy(replacement);
    all = [replacement];
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    all = [];
    view.render(100);
    all = [replacement];
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    replacement.notebook.apply("cell-op", { cell_id: "cell-0", status: "idle" });
    view.render(100);
    busy(replacement);
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    replacement.connection = "disconnected";
    view.render(100);
    replacement.connection = "connected";
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    view.handleInput("x");
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(replacement);
  } finally { view.dispose(); }
});


// --- the view you can drive: cursor, expansion, filter, jumps, runs, header, output ---
const theme2 = theme;
function nbWith(cells: Array<{ id: string; code: string; name?: string }>): Followed {
  const notebook = new NotebookState();
  notebook.apply("kernel-ready", { cell_ids: cells.map((c) => c.id), codes: cells.map((c) => c.code), names: cells.map((c) => c.name ?? "_") });
  return { attachment: { path: "/w/nb.py", url: "http://fixture.invalid", sessionId: "s" }, notebook, connection: "connected", current: true, touchedAt: 0 };
}
const make = (f: Followed, extra: Partial<ConstructorParameters<typeof NotebookView>[3]> = {}) =>
  new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, ...extra }, () => {});
const screen = (v: NotebookView) => v.render(100).join("\n");

test.each([46, 80, 100, 120, 180].flatMap(width => [
  { width, kind: "python" as const, code: "source = 42", text: "source = 42" },
  { width, kind: "markdown" as const, code: 'mo.md("# Body text")', text: "# Body text" },
]))("inline $kind replaces exactly its source location at $width columns", async ({ width, kind, code, text }) => {
  const f = nbWith([{ id: "a", code }]);
  const fake = fakeEditors();
  const v = make(f, { editors: fake.editors, outputs: false });
  try {
    v.render(width);
    const before = (v as any).lastDetail as Array<any>;
    const sourceAt = kind === "python" ? before.findIndex(r => r.blockId === "a:source") : before.findIndex(r => plain(r.text).includes("Body text"));
    expect(sourceAt).toBeGreaterThanOrEqual(0);
    const prefix = before.slice(0, sourceAt).map(r => r.text);
    v.handleInput("b");
    await editorReady();
    const lines = v.render(width);
    const detail = (v as any).lastDetail as Array<any>;
    expect(detail.findIndex(r => r.editorRow === 0)).toBe(sourceAt);
    expect(detail.slice(0, sourceAt).map(r => r.text)).toEqual(prefix);
    expect(plain(detail[sourceAt].text)).toContain(text);
    expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
    expect(fake.session.resize).toHaveBeenLastCalledWith(fake.editors.state!.viewport.width, fake.editors.state!.viewport.height);
    expect(fake.options()).toMatchObject({ filetype: kind, text });
  } finally { v.dispose(); fake.editors.dispose(); }
});

test.each(["python", "markdown"])("inline %s retains the other section cells and pins selection during running events", async kind => {
  const f = nbWith([
    { id: "h", code: 'mo.md("# Section")' },
    { id: "a", code: "source = 42" },
    { id: "b", code: "other = 2", name: "other" },
  ]);
  const fake = fakeEditors();
  const v = make(f, { editors: fake.editors, outputs: true });
  try {
    if (kind === "python") v.handleInput("j");
    v.render(120);
    v.handleInput("b");
    await editorReady();
    expect(plain(v.render(120).join("\n"))).toContain("other");
    let detail = (v as any).lastDetail as Array<any>;
    expect(detail.some(r => r.text.includes("Section"))).toBe(true);
    expect(detail.some(r => r.text.includes("other"))).toBe(true);
    expect(detail.some(r => r.editorRow === 0)).toBe(true);
    f.notebook.apply("cell-op", { cell_id: "b", status: "running" });
    v.render(120);
    const selected = kind === "python" ? "a" : "h";
    expect(v.snapshot().cursor).toBe(selected);
    expect(v.snapshot().follow).toBe(false);
    expect(fake.editors.state?.cellId).toBe(selected);
    detail = (v as any).lastDetail;
    expect(detail.some(r => r.text.includes("other"))).toBe(true);
  } finally { v.dispose(); fake.editors.dispose(); }
});

test("all ordinary keys go to native editing, not notebook commands", async () => {
  const f = nbWith([{ id: "a", code: "x = 1" }, { id: "b", code: "y = 2" }]);
  const fake = fakeEditors();
  const run = vi.fn();
  const v = make(f, { editors: fake.editors, run });
  try {
    v.render(120);
    v.handleInput("\r");
    await editorReady();
    v.render(120);
    const keys = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)), "\r", "\n", "\t", "\x1b", "\x7f", "\x03", "\x04", "\x15", "\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"];
    for (const key of keys) v.handleInput(key);
    expect(fake.session.input.mock.calls.map(([data]) => data)).toEqual(keys);
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    expect(v.snapshot().cursor).toBe("a");
    expect(run).not.toHaveBeenCalled();
  } finally { v.dispose(); fake.editors.dispose(); }
});

test("Focusable and F5 transfer retain the native process across two views", async () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const fake = fakeEditors();
  const dock = vi.fn();
  const undock = vi.fn();
  const first = make(f, { editors: fake.editors, dock });
  let second: NotebookView | undefined;
  try {
    first.render(120);
    first.handleInput("\r");
    await editorReady();
    fake.draft("unsaved = 2");
    first.focused = false;
    expect(fake.session.focus).toHaveBeenLastCalledWith(false);
    first.focused = true;
    expect(fake.session.focus).toHaveBeenLastCalledWith(true);
    first.handleInput("\x1b[15~"); // F5
    expect(dock).toHaveBeenCalledOnce();
    expect(fake.session.dispose).not.toHaveBeenCalled();
    second = make(f, { editors: fake.editors, initial: dock.mock.calls[0]![1], docked: { focused: () => true, focusMain: () => {} }, undock });
    second.render(80);
    expect(second[INPUT_CONTEXT]()).toBe("editor");
    expect(fake.editors.state).toMatchObject({ draft: "unsaved = 2", dirty: true, cellId: "a" });
    expect(fake.openSession).toHaveBeenCalledOnce();
    second.focused = false;
    expect(fake.session.focus).toHaveBeenLastCalledWith(false);
    second.focused = true;
    second.handleInput("j");
    expect(fake.session.input).toHaveBeenLastCalledWith("j");
    second.handleInput("\x1b[15~");
    expect(undock).toHaveBeenCalledOnce();
    expect(fake.session.dispose).not.toHaveBeenCalled();
  } finally { first.dispose(); second?.dispose(); fake.editors.dispose(); }
  expect(fake.session.dispose).toHaveBeenCalledOnce();
});

test("legacy editorFactory still supplies the ask prompt", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const ask = vi.fn();
  const editor = { focused: false, render: () => ["legacy prompt"], handleInput: vi.fn(), dispose: vi.fn() };
  const editorFactory = vi.fn((_options: any) => editor as any);
  const v = make(f, { editorFactory, keybindings: {} as any, ask });
  try {
    v.handleInput("a");
    expect(editorFactory).toHaveBeenCalledWith(expect.objectContaining({ surface: "embedded", initialMode: "insert" }));
    expect(screen(v)).toContain("legacy prompt");
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    v.handleInput("hello");
    expect(editor.handleInput).toHaveBeenCalledWith("hello");
    editorFactory.mock.calls[0]![0].onSubmit("question");
    expect(ask).toHaveBeenCalledWith(f, f.notebook.cells.get("a"), "question");
    expect(editor.dispose).toHaveBeenCalledOnce();
  } finally { v.dispose(); }
});

test("STEP2 local frame has a single content origin and no vertical borders", () => {
  expect(CONTENT_LEFT).toBe(1);
  expect(bodyWidth(46)).toBe(44);
  expect(notebookRow("x".repeat(60), 46, theme)).toBe(` ${"x".repeat(44)} `);
  expect(visibleWidth(notebookRow("wide 界", 46, theme))).toBe(46);
});

test("STEP2 expanded detail retains all logical source lines and trailing whitespace", () => {
  const source = Array.from({ length: 10002 }, (_, i) => `value_${i}\t= ${i}`).join("\n") + "\n  \n";
  const f = nbWith([{ id: "a", code: source }]);
  const rows = detailRows(f.notebook, theme, 0, { cell: f.notebook.cells.get("a")!, width: 80, codeOpen: true, section: false, diff: false, lineNumbers: true, tabstop: 8 }).rows.filter(r => r.sourceLine !== undefined);
  expect(rows).toHaveLength(10004);
  expect(rows.at(-3)?.text).toContain("value_10001");
  expect(rows.at(-2)?.text.trimEnd()).toBe("  10003");
  expect(rows.at(-1)?.text.trimEnd()).toBe("  10004");
});

test("STEP2 H/L/0 offsets and session line numbers survive view transfers", () => {
  const f = nbWith([{ id: "a", code: `prefix_${"x".repeat(150)}_TAIL` }]);
  const preferences = new SessionPreferences();
  const v = make(f, { preferences });
  let next: NotebookView | undefined;
  try {
    expect(v.render(80).join("\n")).toContain("prefix_");
    v.handleInput("L");
    v.render(80);
    expect((v as any).lastDetail.find((r: any) => r.sourceLine === 0).text).not.toContain("prefix_");
    v.handleInput("#");
    expect(preferences.snapshot().lineNumbers).toBe(true);
    next = make(f, { preferences, initial: v.snapshot() });
    expect(next.snapshot().codeOffsets).toEqual(v.snapshot().codeOffsets);
    next.render(80);
    next.handleInput("0");
    next.render(80);
    expect((next as any).lastDetail.find((r: any) => r.sourceLine === 0).text).toContain("1 prefix_");
    next.handleInput("\x1b[18~"); // F7
    expect(preferences.snapshot().lineNumbers).toBe(false);
  } finally { v.dispose(); next?.dispose(); }
});

test("STEP2 Mermaid source toggle keeps independent fenced blocks and invalidates prose cache", () => {
  const f = nbWith([{ id: "m", code: 'mo.md("""# Diagram\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n```mermaid\nsequenceDiagram\nA->>B: hi\n```\n""")' }]);
  const v = make(f);
  try {
    v.render(120);
    const detail = (v as any).lastDetail as Array<{ blockId?: string; text: string }>;
    const ids = [...new Set(detail.map(r => r.blockId).filter(Boolean))];
    expect(ids).toHaveLength(2);
    expect(detail.filter(r => r.text.includes("Mermaid:")).length).toBe(2);
    (v as any).focusedBlock = ids[1];
    v.handleInput("s");
    v.render(120);
    expect(v.snapshot().diagramSources).toEqual([ids[1]]);
    expect((v as any).lastDetail.filter((r: any) => r.text.includes("Mermaid:")).length).toBe(1);
    expect((v as any).lastDetail.some((r: any) => r.text.includes("A->>B: hi"))).toBe(true);
    v.handleInput("s");
    v.render(120);
    expect((v as any).lastDetail.filter((r: any) => r.text.includes("Mermaid:")).length).toBe(2);
  } finally { v.dispose(); }
});

test.each(["open", "folded"] as const)("section folds are independent of cell source state (view.code=%s) and survive restore", code => {
  const f = nbWith([{ id: "a", code: "secret_source = 42" }, { id: "b", code: "other_source = 7" }]);
  const v = make(f, { outputs: true, code });
  if (!v.snapshot().section) v.handleInput("O");
  const panel = (view: NotebookView, id: string) => {
    view.render(100);
    return (view as any).lastDetail.filter((r: any) => r.blockId === `${id}:source`).map((r: any) => r.text).join("\n");
  };
  try {
    expect(panel(v, "a")).toContain("▾ python");
    expect(panel(v, "b")).toContain("▾ python");
    v.handleInput("B");
    expect(panel(v, "a")).toContain("▸ python");
    expect(panel(v, "b")).toContain("▾ python");
    v.handleInput("j");
    v.handleInput("k");
    expect(panel(v, "a")).toContain("▸ python");
    expect(v.snapshot().sectionCodeFolded).toEqual(["a"]);
    expect(v.snapshot().codeOpen).toEqual([]);
    v.handleInput("O");
    expect(panel(v, "a")).toContain(code === "open" ? "▾ python" : "▸ python");
    v.handleInput("B"); // Change only the cell-mode source state.
    expect(panel(v, "a")).toContain(code === "open" ? "▸ python" : "▾ python");
    v.handleInput("O");
    expect(panel(v, "a")).toContain("▸ python");
    const restored = make(f, { code, initial: v.snapshot() });
    try {
      expect(panel(restored, "a")).toContain("▸ python");
      expect(panel(restored, "b")).toContain("▾ python");
      restored.handleInput("B");
      expect(panel(restored, "a")).toContain("▾ python");
      expect(restored.snapshot().sectionCodeFolded).toEqual([]);
      restored.handleInput("O");
      expect(panel(restored, "a")).toContain(code === "open" ? "▸ python" : "▾ python");
      restored.handleInput("O");
    } finally { restored.dispose(); }
    v.handleInput("O"); // Restore the process-wide cell-view preference for later tests.
  } finally { v.dispose(); }
});

test("the header shows state and server while help avoids repeated notebook metadata", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }, { id: "b", code: "y = x" }, { id: "m", code: 'mo.md("# T")' }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", stale_inputs: true, output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "ValueError", msg: "bad" }] } });
  const v = make(f, { servers: () => ["nb-server"], lastRun: () => "ran 3s · 1 error · 1m ago" });
  try {
    const lines = v.render(100);
    expect(lines[1]).toContain("nb.py");
    expect(lines[1]).toContain("idle · 1 error");
    expect(lines[1]).toContain("ran 3s · 1 error · 1m ago");
    expect(lines[1]).toContain("server nb-server");
    const text = lines.join("\n");
    expect(text).not.toContain("2 cells");
    expect(text).not.toContain("http://fixture.invalid");
    expect(text).not.toContain("/w/nb.py");
    expect(text).not.toContain("session s");
    v.handleInput("?");
    expect(screen(v)).not.toContain("/w/nb.py · http://fixture.invalid · server nb-server");
  } finally { v.dispose(); }
});

test("j/k move the cursor between cells; the detail shows the cell's output, folds its code, and B opens it", async () => {
  const f = nbWith([{ id: "a", code: "print('hi')\nx = 1", name: "first" }, { id: "b", code: "y = 2", name: "second" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "running", timestamp: 1 });
  f.notebook.apply("cell-op", { cell_id: "a", console: [{ channel: "stdout", mimetype: "text/plain", data: "hi\n" }], output: { channel: "output", mimetype: "text/html", data: "<span>value &amp; more</span>" } });
  await f.notebook.settled();
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", timestamp: 2 });
  const v = make(f, { code: "folded" });
  try {
    const first = screen(v);
    expect(first).toMatch(/▌  first/u);
    expect((v as any).lastDetail.map((row: { text: string }) => plain(row.text).trim())).toContain("hi");
    expect(first).toContain("value & more");
    // Folded: a short preview retains both source lines.
    expect(first).toContain("  ▸ python");
    expect(first).toContain("  print('hi')");
    expect(first).toContain("  x = 1");
    expect((v as any).lastParts.some((part: any) => part.kind === "code")).toBe(true);
    expect(v.render(100).slice(2, -1).join("\n")).not.toMatch(/code\s/u);
    v.handleInput("j");
    expect(screen(v)).toMatch(/▌  second/u);
    expect(screen(v)).not.toContain("value & more");
    v.handleInput("k");
    v.handleInput("B");
    const open = screen(v);
    expect(open).toMatch(/▌  first/u);
    expect(open).toContain("  x = 1");
    expect(open).toContain("  ▾ python");
    v.handleInput("B");
    expect(screen(v)).toContain("  x = 1");
    expect(screen(v)).toContain("  ▸ python");
  } finally { v.dispose(); }
});

test("e and E jump between failed cells; / filters by name, variable or code and Esc clears", () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "load" }, { id: "b", code: "boom()" }, { id: "c", code: "z = 3" }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "E", msg: "m" }] } });
  const v = make(f);
  try {
    v.handleInput("e");
    expect(screen(v)).toMatch(/▌✗ boom\(\) +\[ err\]/u);
    v.handleInput("E");
    expect(screen(v)).toMatch(/▌✗ boom\(\) +\[ err\]/u);
    expect(screen(v)).toContain("E: m");
    v.handleInput("/");
    expect(v[INPUT_CONTEXT]()).toBe("filter");
    for (const ch of "load") v.handleInput(ch);
    const filtered = screen(v);
    expect(filtered).toContain("load");
    expect(filtered).not.toContain("boom()");
    // Enter goes to the match and shows every cell again.
    v.handleInput("\r");
    expect(v[INPUT_CONTEXT]()).toBe("viewer");
    expect(screen(v)).toMatch(/▌  load/u);
    expect(screen(v)).toContain("boom()");
    // Esc while finding goes back to where the cursor was.
    v.handleInput("j");
    v.handleInput("/");
    for (const ch of "load") v.handleInput(ch);
    v.handleInput("\x1b");
    expect(screen(v)).toMatch(/▌✗ boom\(\)/u);
    // Esc with no filter goes back.
    let closed = false;
    const w = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => { closed = true; });
    w.handleInput("\x1b");
    expect(closed).toBe(true);
    w.dispose();
  } finally { v.dispose(); }
});

test("following keeps the cursor on the running cell until the user moves; f follows again", () => {
  const f = nbWith(Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, code: `v${i} = ${i}` })));
  f.notebook.apply("cell-op", { cell_id: "c40", status: "running", timestamp: 1 });
  const v = make(f);
  try {
    expect(screen(v)).toMatch(/▌[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] v40 = 40/u);
    v.handleInput("k");
    expect(screen(v)).toMatch(/▌  v39 = 39/u);
    v.handleInput("f");
    expect(screen(v)).toMatch(/▌[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] v40 = 40/u);
  } finally { v.dispose(); }
});

test("r runs the cell under the cursor with its current code; R and A need a second press", async () => {
  const f = nbWith([{ id: "a", code: "x = 1" }, { id: "b", code: "y = x" }, { id: "m", code: 'mo.md("# T")' }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", stale_inputs: true });
  const run = vi.fn(async () => {});
  const v = make(f, { run });
  try {
    v.handleInput("j");
    v.handleInput("r");
    expect(run).toHaveBeenCalledExactlyOnceWith(f, [{ id: "b", code: "y = x" }]);
    v.handleInput("R");
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen(v)).toContain("R again to run stale cells");
    v.handleInput("R");
    expect(run).toHaveBeenLastCalledWith(f, [{ id: "b", code: "y = x" }]);
    v.handleInput("A");
    v.handleInput("j");
    v.handleInput("A");
    expect(run).toHaveBeenCalledTimes(2);
    // The armed A fires on the next A.
    v.handleInput("A");
    expect(run).toHaveBeenLastCalledWith(f, [{ id: "a", code: "x = 1" }, { id: "b", code: "y = x" }]);
    expect(run).toHaveBeenCalledTimes(3);
    f.connection = "disconnected";
    v.handleInput("r");
    expect(run).toHaveBeenCalledTimes(3);
    expect(screen(v)).toContain("not connected");
  } finally { v.dispose(); }
});

test("a failed run shows the reason above the footer", async () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const v = make(f, { run: async () => { throw new Error("marimo answered 500"); } });
  try {
    v.handleInput("r");
    await new Promise((r) => setTimeout(r, 5));
    expect(screen(v)).toContain("Could not run x = 1: marimo answered 500");
    // The cell shown as queued at once goes back to idle.
    expect(f.notebook.cells.get("a")!.status).toBe("idle");
  } finally { v.dispose(); }
});

test("S stops the server the notebook's row stands for, after a second press, and only when there is one", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const stopServers = vi.fn(() => 1);
  const none = make(f, { stopServers });
  try {
    none.handleInput("S");
    none.handleInput("S");
    expect(stopServers).not.toHaveBeenCalled();
    expect(screen(none)).not.toContain("stop server");
  } finally { none.dispose(); }
  const v = make(f, { servers: () => ["marimo nb.py"], stopServers });
  try {
    v.handleInput("S");
    expect(screen(v)).toContain("S again to stop the server");
    v.handleInput("j");
    v.handleInput("S");
    expect(stopServers).not.toHaveBeenCalled();
    v.handleInput("S");
    expect(stopServers).toHaveBeenCalledExactlyOnceWith(f);
    expect(screen(v)).toContain("Stopping the marimo server");
  } finally { v.dispose(); }
});

test("a png output draws inline only when its whole block is on screen, and only on a terminal that shows images", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  const f = nbWith([{ id: "a", code: "plot()" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "image/png", data: png } });
  const v = make(f);
  try {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any);
    expect(screen(v)).toContain("[image png]");
    expect(screen(v)).not.toContain("\x1b_G");
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
    v.invalidate?.();
    const shown = v.render(100);
    expect(shown.filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
    expect(shown.every((l) => visibleWidth(l) === 100)).toBe(true);
    // The agent-facing outline never carries image escapes.
    expect(notebookLines(f.notebook, theme2, 0).lines.join("\n")).not.toContain("\x1b_G");
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test("a Vega-Lite chart shows a drawing note, then the image once the renderer finishes", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const { VegaRenderer } = await import("../src/core/vega.js");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  const f = nbWith([{ id: "a", code: "chart" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "application/vnd.vegalite.v6+json", data: '{"mark":"bar"}' } });
  let release!: (png: string) => void;
  const renderer = new VegaRenderer(() => new Promise<string>((r) => { release = r; }));
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {}, renderer);
  try {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
    expect(screen(v)).toContain("drawing");
    release(png);
    await new Promise((r) => setTimeout(r, 0));
    expect(v.render(100).filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
    // Without image support it stays the label and never starts a render.
    setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any);
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test("a Plotly figure is drawn through its own renderer", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const { ChartRenderer } = await import("../src/core/vega.js");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  const f = nbWith([{ id: "a", code: "fig" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: `<marimo-plotly data-figure='{&quot;data&quot;:[],&quot;layout&quot;:{}}'></marimo-plotly>` } });
  const asked: string[] = [];
  const plotly = new ChartRenderer(async (spec) => { asked.push(spec); return png; });
  // The live browser is unavailable, so the figure falls back to the static render.
  const { LiveCharts } = await import("../src/ui/live-charts.js");
  const noLive = new LiveCharts(() => {}, () => ({ stop() {} }) as any, async () => { throw new Error("no browser"); });
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {}, undefined, plotly, noLive);
  try {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
    v.render(100);
    await new Promise((r) => setTimeout(r, 0));
    v.render(100);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen(v)).toContain("static image (live chart failed: no browser)");
    expect(asked).toEqual(['{"data":[],"layout":{}}']);
    expect(v.render(100).filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test.each([46, 80, 100, 120, 180])("a live Plotly chart is drawn from its page's frames, and the mouse over it goes to that page (%i columns)", async (width) => {
  const { setCapabilities, setCellDimensions } = await import("@earendil-works/pi-tui");
  const { LiveCharts, liveGeometry } = await import("../src/ui/live-charts.js");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
  const f = nbWith([{ id: "a", code: "fig" }, { id: "b", code: "y = 2" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: `<marimo-plotly data-figure='{&quot;data&quot;:[],&quot;layout&quot;:{}}'></marimo-plotly>` } });
  const events: any[] = [];
  let closed = false;
  const live = new LiveCharts(() => {}, () => ({ stop() {} }) as any, async () => ({ frame: png, pointer: (p: any) => events.push(p), close: () => { closed = true; } }), (d: string) => { written.push(d); });
  const written: string[] = [];
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {}, undefined, undefined, live);
  try {
    expect(v.render(width).join("\n")).toContain("starting");
    await new Promise((r) => setTimeout(r, 0));
    const shown = v.render(width);
    expect(shown.filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
    // The frame was uploaded out of band and the line only places it.
    expect(written.at(-1)).toMatch(/^\x1b_Ga=t,f=100,q=2,i=\d+;/u);
    expect(shown.find((l) => l.includes("\x1b_G"))).toMatch(/\x1b_Ga=p,i=\d+,p=1,c=\d+,r=\d+,C=1,q=2\x1b\\/u);
    expect(live.rects).toHaveLength(1);
    const r = live.rects[0]!;
    expect(shown[r.top]).toContain("\x1b_G");
    expect(visibleWidth(shown[r.top]!.split("\x1b_G")[0]!)).toBe(r.left);
    const imageRows = (v as any).lastPage - (v as any).panes.detailTop - 5;
    expect(r.geometry).toEqual(liveGeometry(width - r.left - CONTENT_LEFT, imageRows));
    expect(shown.every((l) => visibleWidth(l) === width)).toBe(true);
    const ev = (type: string, x: number, y: number, extra = {}) => ({ type, button: "left", x, y, screenX: x, screenY: y, width, height: 40, shift: false, alt: false, ctrl: false, ...extra }) as any;
    // Hover inside the chart reaches the page, in cells from its corner; outside it is left alone.
    expect(v.handleMouse(ev("move", r.left + 3, r.top + 2, { button: "none" }))).toEqual({ handled: true });
    expect(events.at(-1)).toMatchObject({ type: "move", x: 3.5, y: 2.5 });
    expect(v.handleMouse(ev("move", 0, 0, { button: "none" }))).toBeUndefined();
    // A press captures the drag, which keeps going when the pointer leaves the chart.
    expect(v.handleMouse(ev("press", r.left + 1, r.top + 1))).toEqual({ handled: true, capture: true });
    expect(v.handleMouse(ev("drag", 0, 0))).toEqual({ handled: true });
    expect(events.at(-1)).toMatchObject({ type: "drag" });
    v.handleMouse(ev("release", 0, 0));
    expect(v.handleMouse(ev("move", 0, 0, { button: "none" }))).toBeUndefined();
    // Cell view retains wheel zoom. Section view scrolls until explicitly inspecting.
    const wheel = () => ev("wheel", live.rects[0]!.left + 1, live.rects[0]!.top + 1, { button: "none", wheelDelta: 1 });
    v.handleMouse(wheel());
    expect(events.at(-1)).toMatchObject({ type: "wheel", wheelDelta: 1 });
    v.handleInput("O");
    v.render(width);
    await new Promise(r => setTimeout(r, 0));
    v.render(width);
    const before = events.length;
    const scroll = (v as any).detailScroll;
    v.handleMouse(wheel());
    expect(events).toHaveLength(before);
    expect((v as any).detailScroll).toBe(scroll + 1);
    // Restore the fully visible chart before inspecting it.
    (v as any).detailScroll = 0;
    v.render(width);
    v.handleInput("i");
    expect(live.inspecting).toBe(true);
    v.handleMouse(wheel());
    expect(events.at(-1)).toMatchObject({ type: "wheel", wheelDelta: 1 });
    v.handleInput("\x1b");
    v.handleInput("O");
    // Moving to a cell without the chart closes its page.
    v.handleInput("j");
    v.render(width);
    expect(closed).toBe(true);
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test("the keyboard pointer drives a live chart without a mouse: arrows move it, space drags, plus zooms, esc leaves", async () => {
  const { setCapabilities, setCellDimensions } = await import("@earendil-works/pi-tui");
  const { LiveCharts } = await import("../src/ui/live-charts.js");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
  const f = nbWith([{ id: "a", code: "fig" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: `<marimo-plotly data-figure='{&quot;data&quot;:[],&quot;layout&quot;:{}}'></marimo-plotly>` } });
  const events: any[] = [];
  const rings: any[] = [];
  const live = new LiveCharts(() => {}, () => ({ stop() {} }) as any, async () => ({ frame: png, pointer: (p: any) => events.push(p), cursor: (c: any) => rings.push(c && { x: c.x, y: c.y }), close: () => {} }), () => {});
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {}, undefined, undefined, live);
  try {
    v.handleInput("i");
    expect(screen(v)).toContain("Select a cell with a live chart");
    v.render(100);
    await new Promise((r) => setTimeout(r, 0));
    v.render(100);
    v.handleInput("j");
    screen(v);
    // Clearing the transient error restores a body row and reopens the chart at
    // its new geometry. Let that frame arrive before activating the pointer.
    await editorReady();
    expect(v.render(100).join("\n")).toContain("i inspect chart");
    v.handleInput("i");
    expect(live.inspecting).toBe(true);
    expect(screen(v)).toContain("space start / end drag · ? help");
    const start = events.at(-1);
    v.handleInput("\x1b[C"); // right
    expect(events.at(-1)).toMatchObject({ type: "move", x: start.x + 0.5, y: start.y });
    v.handleInput("J"); // shift-down: farther
    expect(events.at(-1)).toMatchObject({ type: "move", y: start.y + 3 });
    v.handleInput(" ");
    expect(events.at(-1)).toMatchObject({ type: "press", button: "left" });
    v.handleInput("h");
    expect(events.at(-1)).toMatchObject({ type: "drag", button: "left" });
    v.handleInput(" ");
    expect(events.at(-1)).toMatchObject({ type: "release" });
    v.handleInput("+");
    expect(events.at(-1)).toMatchObject({ type: "wheel", wheelDelta: -3 });
    v.handleInput("0");
    expect(events.at(-1)).toMatchObject({ type: "dblclick" });
    expect(rings.at(-1)).not.toBeNull();
    // The pointer holds every key while it is on (j does not move the notebook cursor), and esc hands them back.
    v.handleInput("\x1b");
    expect(live.inspecting).toBe(false);
    expect(rings.at(-1)).toBeNull();
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

// --- reading and steering: outputs, folds, mouse, help, variables, agent changes, widgets, docks ---
const press = (v: NotebookView, keys: string) => { for (const k of keys) v.handleInput(k); };

test("O stacks the cell's whole section in the detail, the markdown as prose; O again shows the cell alone", () => {
  const f = nbWith([{ id: "m", code: 'mo.md("""\n# Title\n\nSome prose here.\n""")' }, { id: "a", code: "x = 1" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/plain", data: "forty-two" } });
  const v = make(f);
  try {
    v.handleInput("j");
    expect(screen(v)).not.toContain("Some prose here.");
    expect(screen(v)).toContain("forty-two");
    v.handleInput("O");
    expect(screen(v)).toContain("Some prose here.");
    expect(screen(v)).toContain("forty-two");
    expect(screen(v)).toContain("Section view: the whole section.");
    expect(screen(v)).toMatch(/▌  x = 1/u);
    v.handleInput("O");
    expect(screen(v)).not.toContain("Some prose here.");
    expect(screen(v)).toContain("Cell view.");
    v.handleInput("O");
    expect(screen(v)).toContain("Some prose here.");
  } finally { v.handleInput("O"); v.dispose(); }
});

test("a table output is a grid in the detail, and its shape is the outline's badge", () => {
  const table = `<marimo-ui-element object-id='a-0' random-id='r'><marimo-table data-data='&quot;[{&#92;&quot;city&#92;&quot;:&#92;&quot;Oslo&#92;&quot;,&#92;&quot;pop&#92;&quot;:709000}]&quot;' data-total-rows='1' data-total-columns='2' data-field-types='[[&quot;pop&quot;,[&quot;integer&quot;,&quot;int64&quot;]]]'></marimo-table></marimo-ui-element>`;
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: table } });
  const v = make(f);
  try {
    expect(screen(v)).toMatch(/▌  table +1×2/u);
    expect(screen(v)).toMatch(/city\s{2,}pop/u);
    expect(screen(v)).toMatch(/Oslo\s{2,}709,000/u);
    expect(screen(v)).toContain("rows 1–1 of 1");
  } finally { v.dispose(); }
});

test("z folds the section the cursor is in, Z folds every one, [ and ] go between sections", () => {
  const f = nbWith([{ id: "h1", code: 'mo.md("# One")' }, { id: "a", code: "a = 1" }, { id: "b", code: "b = 2" }, { id: "h2", code: 'mo.md("# Two")' }, { id: "c", code: "c = 3" }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "E", msg: "m" }] } });
  const v = make(f);
  try {
    expect(screen(v)).toMatch(/▌ One/u);
    v.handleInput("j");
    v.handleInput("z");
    const folded = screen(v);
    expect(folded).toMatch(/▌ One {2}▸ 2 cells · 1 error/u);
    expect(folded).not.toContain("a = 1");
    expect(folded).toContain("c = 3");
    v.handleInput("]");
    expect(screen(v)).toMatch(/▌ Two/u);
    v.handleInput("Z");
    expect(screen(v)).toContain("a = 1");
    v.handleInput("Z");
    expect(screen(v)).toMatch(/Two {2}▸ 1 cell/u);
    expect(screen(v)).not.toContain("c = 3");
    v.handleInput("[");
    expect(screen(v)).toMatch(/▌ One/u);
    // Tab and Shift+Tab fold as z and Z do.
    v.handleInput("\x1b[Z");
    expect(screen(v)).toContain("a = 1");
    v.handleInput("\t");
    expect(screen(v)).toMatch(/▌ One {2}▸ 2 cells/u);
    v.handleInput("\t");
    expect(screen(v)).toContain("a = 1");
  } finally { v.dispose(); }
});

test("{ goes to the previous notebook, } to the next", () => {
  const a = nbWith([{ id: "a", code: "x = 1" }]);
  const b = nbWith([{ id: "b", code: "y = 1" }]);
  b.attachment = { ...b.attachment, path: "/w/other.py" };
  const v = new NotebookView(tui as any, theme2, notebookKey(a), { followed: () => [a, b], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    v.handleInput("{");
    expect(screen(v)).toContain("Notebook other.py");
    v.handleInput("}");
    expect(screen(v)).toContain("Notebook nb.py");
  } finally { v.dispose(); }
});

test("the mouse: the wheel scrolls, a click selects, and a double click edits inline", async () => {
  const f = followed();
  const fake = fakeEditors();
  const v = make(f, { editors: fake.editors });
  const ev = (type: string, y: number, extra = {}) => ({ type, button: type === "wheel" ? "none" : "left", x: 10, y, screenX: 10, screenY: y, width: 100, height: 28, shift: false, alt: false, ctrl: false, ...extra }) as any;
  try {
    v.render(100);
    expect(v.handleMouse(ev("wheel", 10, { wheelDelta: 3 }))).toEqual({ handled: true });
    expect(v.render(100)[2]).toContain("cell-3");
    expect(v.handleMouse(ev("press", 7))).toEqual({ handled: true, render: false });
    v.handleMouse(ev("click", 6));
    expect(screen(v)).toMatch(/▌  cell-7/u);
    expect(screen(v)).toContain("  x = 1");
    // Outside the rows, and moves, are left alone before the editor owns input.
    expect(v.handleMouse(ev("click", 1))).toBeUndefined();
    expect(v.handleMouse(ev("move", 7, { button: "none" }))).toBeUndefined();
    v.handleMouse(ev("click", 6, { clickCount: 2 }));
    await editorReady();
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    expect(fake.editors.state?.cellId).toBe("cell-7");
    expect(plain(screen(v))).toContain("x = 1");
  } finally { v.dispose(); fake.editors.dispose(); }
});

test("? opens context help; navigation and unrelated keys do not close it", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const v = make(f);
  try {
    expect(screen(v)).toContain("? help");
    v.handleInput("?");
    expect(screen(v)).toContain("Keyboard shortcuts");
    expect(screen(v)).toContain("Navigation");
    v.handleInput("j");
    v.handleInput("x");
    expect(screen(v)).toContain("Keyboard shortcuts");
    v.handleInput("?");
    expect(screen(v)).not.toContain("Keyboard shortcuts");
  } finally { v.dispose(); }
});

function dataflow(): Followed {
  const f = nbWith([{ id: "a", code: "x = 1", name: "load" }, { id: "b", code: "y = x + 1" }, { id: "c", code: "z = y * x" }]);
  f.notebook.apply("variables", { variables: [{ name: "x", declared_by: ["a"], used_by: ["b", "c"] }, { name: "y", declared_by: ["b"], used_by: ["c"] }, { name: "z", declared_by: ["c"], used_by: [] }] });
  f.notebook.apply("variable-values", { variables: [{ name: "x", value: "1", datatype: "int" }] });
  return f;
}

test("v lists variables; Enter previews repr, Escape returns to list and d jumps to definition", () => {
  const f = dataflow();
  const v = make(f);
  try {
    v.handleInput("v");
    const pane = screen(v);
    expect(pane).toMatch(/● x\s+int\s+1\s+← load\s+· 2 uses/u);
    expect(pane).toMatch(/ y\s+.*← y\s+· 1 uses/u);
    v.handleInput("j");
    v.handleInput("\r");
    expect(screen(v)).toContain("marimo value preview");
    v.handleInput("\x1b");
    expect(v.snapshot().mode).toBe("variables");
    v.handleInput("d");
    expect(screen(v)).toMatch(/▌  y/u);
    expect(v.snapshot().mode).toBe("cells");
  } finally { v.dispose(); }
});

test("variable repr detail scrolls to complete tail and survives dock transfer", () => {
  const f = dataflow();
  f.notebook.apply("variable-values", { variables: [{ name: "x", datatype: "str", value: Array.from({ length: 100 }, (_, i) => `value ${i}`).join("\n") + "\nLAST VALUE" }] });
  const v = make(f);
  let moved: NotebookView | undefined;
  try {
    v.handleInput("v"); screen(v); v.handleInput("\r"); v.handleInput("G");
    expect(screen(v)).toContain("LAST VALUE");
    moved = make(f, { initial: v.snapshot() });
    expect(screen(moved)).toContain("LAST VALUE");
    moved.handleInput("\x1b"); expect(moved.snapshot().varDetail).toBe(false);
    moved.handleInput("\x1b"); expect(moved.snapshot().mode).toBe("cells");
  } finally { v.dispose(); moved?.dispose(); }
});

test("variable use selector lists all sites, copies supplied values, and sorting retains selection", async () => {
  const f = dataflow();
  f.notebook.apply("variable-values", { variables: [{ name: "x", datatype: "int", value: "one  two\n  three" }] });
  const copy = vi.fn();
  const confirm = vi.fn(async (_question: string, choices: readonly string[]) => choices[2]);
  const v = make(f, { copy, confirm });
  try {
    v.handleInput("v"); screen(v);
    v.handleInput("Y"); expect(copy).toHaveBeenCalledWith("one  two\n  three");
    v.handleInput("s"); expect(v.snapshot().varCursor).toBe("x");
    v.handleInput(">"); await editorReady();
    expect(confirm.mock.calls[0]?.[1]).toEqual(["Cancel", "1. y", "2. z"]);
    expect(v.snapshot().mode).toBe("cells"); expect(v.snapshot().cursor).toBe("c");
  } finally { v.dispose(); }
});

test("packages open/list/Enter never mutate; tree failure leaves list/actions independent", async () => {
  const f = dataflow();
  const snapshot = { fingerprint: { filename: "/w/nb.py", executable: "/env/python", pid: 42, manager: "uv", version: "0.25.0", capabilities: {} }, packages: [{ name: "numpy", version: "1" }] };
  const reconcile = vi.fn(async () => snapshot), dependencyTree = vi.fn(async () => { throw new Error("unsupported"); }), mutate = vi.fn();
  const client = { reconcile, dependencyTree, mutate } as unknown as PackageClient;
  const v = make(f, { packages: async () => client });
  try {
    v.handleInput("P"); await editorReady(); await editorReady();
    expect(screen(v)).toContain("numpy 1"); expect(mutate).not.toHaveBeenCalled();
    v.handleInput("\r"); await editorReady(); await editorReady();
    expect(screen(v)).toContain("Dependency tree unavailable"); expect(mutate).not.toHaveBeenCalled();
    v.handleInput("\x1b"); expect(screen(v)).toContain("numpy 1");
    v.handleInput("r"); await editorReady(); expect(mutate).not.toHaveBeenCalled();
  } finally { v.dispose(); }
});

test("package mutation uses native cancel-first confirmation naming fingerprint and shared risk", async () => {
  const f = dataflow();
  const fingerprint = { filename: "/w/nb.py", executable: "/env/python", pid: 42, manager: "uv", version: "0.25.0", capabilities: {} };
  const question: PackageConfirmation = { action: "remove", spec: "numpy", fingerprint, warning: "Environment shared with server and other notebooks", defaultChoice: "cancel" };
  const mutate = vi.fn(async (_action, _spec, confirm) => ({ status: await confirm(question) ? "succeeded" : "cancelled" }));
  const client = { reconcile: async () => ({ fingerprint, packages: [{ name: "numpy", version: "1" }] }), mutate } as unknown as PackageClient;
  const confirm = vi.fn(async () => "Cancel");
  const v = make(f, { packages: async () => client, confirm });
  try {
    v.handleInput("P"); await editorReady(); await editorReady(); screen(v);
    v.handleInput("x"); await editorReady(); await editorReady();
    expect(mutate).toHaveBeenCalledExactlyOnceWith("remove", "numpy", expect.any(Function));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("/env/python"), ["Cancel", "Confirm"]);
    const text = confirm.mock.calls[0] as unknown as [string];
    expect(text[0]).toContain("/w/nb.py"); expect(text[0]).toContain("pid 42"); expect(text[0]).toContain("shared");
  } finally { v.dispose(); }
});

test("< and > follow the dataflow up and down", () => {
  const f = dataflow();
  const v = make(f);
  try {
    v.handleInput("G");
    v.handleInput("<");
    expect(screen(v)).toMatch(/▌  y/u);
    v.handleInput("<");
    expect(screen(v)).toMatch(/▌  load/u);
    v.handleInput("<");
    expect(screen(v)).toContain("No upstream cell.");
    v.handleInput(">");
    expect(screen(v)).toMatch(/▌  y/u);
  } finally { v.dispose(); }
});

test("the agent's changes since the last prompt: marked, counted, c jumps to them, d shows the diff, removed cells listed", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(1_000_000);
    const f = nbWith([{ id: "a", code: "x = 1" }, { id: "b", code: "y = x + 1" }, { id: "c", code: "z = 3" }]);
    vi.setSystemTime(1_010_000);
    f.notebook.apply("notebook-document-transaction", { transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "b", code: "y = x + 2" }, { type: "delete-cell", cellId: "c" }] } });
    const v = make(f);
    try {
      const text = screen(v);
      expect(text).toMatch(/  y = x \+ 2 +\[ agent\]/u);
      expect(text).toContain("agent: 1 changed · 1 removed");
      expect(text).toMatch(/✗ Removed: z = 3/u);
      v.handleInput("c");
      expect(screen(v)).toMatch(/▌  y = x \+ 2/u);
      expect(screen(v)).toContain(" agent");
      v.handleInput("d");
      const diff = screen(v);
      expect(diff).toMatch(/-\s*\d+ y = x \+ 1/u);
      expect(diff).toMatch(/\+\s*\d+ y = x \+ 2/u);
      v.handleInput("k");
      v.handleInput("d");
      expect(screen(v)).toContain("The agent has not changed this cell since your last message.");
    } finally { v.dispose(); }
  } finally { vi.useRealTimers(); }
});

const widgetHtml = [
  "<marimo-ui-element object-id='a-0' random-id='1'><marimo-slider data-initial-value='3' data-label='&quot;n&quot;' data-start='0' data-stop='10' data-steps='[]'></marimo-slider></marimo-ui-element>",
  "<marimo-ui-element object-id='a-1' random-id='2'><marimo-checkbox data-initial-value='true' data-label='&quot;on&quot;'></marimo-checkbox></marimo-ui-element>",
  "<marimo-ui-element object-id='a-2' random-id='3'><marimo-text data-initial-value='&quot;hi&quot;' data-label='&quot;t&quot;'></marimo-text></marimo-ui-element>",
].join("");

test("widget value prompt strips JSON-encoded terminal commands before styling", () => {
  const f = nbWith([{ id: "a", code: "text" }]);
  const label = "safe\x1b]52;c;PAYLOAD\x07 title";
  const encoded = JSON.stringify(label).replaceAll('"', "&quot;");
  const html = `<marimo-ui-element object-id='text-0'><marimo-text data-initial-value='&quot;hi&quot;' data-label='${encoded}'></marimo-text></marimo-ui-element>`;
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: html } });
  expect(f.notebook.cells.get("a")!.output!.widgets![0]!.label).toBe(label);
  const setWidget = vi.fn(); const v = make(f, { setWidget });
  try {
    v.render(100); v.handleInput("w"); v.handleInput("\r");
    const rendered = screen(v);
    expect(rendered).toContain("safe title: new value");
    expect(rendered).not.toContain("\x1b]52");
    expect(rendered).not.toContain("PAYLOAD");
    press(v, "!"); v.handleInput("\r");
    expect(setWidget).toHaveBeenCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "text-0" }), "hi!");
  } finally { v.dispose(); }
});

test.each([12, 10, 7, 6, 4, 2, 1])("focused prompt exposes its input and cursor before submission at 46x%i", height => {
  const f = dataflow(); const ask = vi.fn(); const terminal = shortTui();
  terminal.terminal.rows = height;
  const v = new NotebookView(terminal as any, theme, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, ask }, () => {});
  try {
    v.handleInput("a"); press(v, "draft?");
    (v as any).note = "a transient warning that must not displace focused input";
    const lines = v.render(46);
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.every(line => visibleWidth(line) === 46)).toBe(true);
    expect(lines.join("\n")).toContain("draft?");
    expect(lines.join("\n")).toContain(CURSOR_MARKER);
    v.handleInput("\r");
    expect(ask).toHaveBeenCalledWith(f, expect.anything(), "draft?");
  } finally { v.dispose(); }
});

test("w drives a cell's widgets: h/l change a slider, space a checkbox, Enter types a text's value", () => {
  const f = nbWith([{ id: "a", code: "n = mo.ui.slider(0, 10)" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: widgetHtml } });
  const setWidget = vi.fn((g: Followed, cell: any, w: any, value: unknown) => g.notebook.setUserValue(cell.id, w.objectId, w.label, value));
  const v = make(f, { setWidget });
  try {
    expect(screen(v)).toMatch(/◆ n {2}━+●─+ {2}3 {2}0–10/u);
    expect(footerText(v.render(100))).toContain("w controls");
    v.handleInput("w");
    expect(footerText(v.render(100))).toBe("Tab next · ←/→ adjust · Enter value · Esc done");
    v.handleInput("l");
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.objectContaining({ id: "a" }), expect.objectContaining({ objectId: "a-0" }), 4);
    expect(screen(v)).toMatch(/▸ n {2}━+●─+ {2}4 {2}0–10/u);
    v.handleInput("j");
    v.handleInput(" ");
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-1" }), false);
    v.handleInput("j");
    v.handleInput("\r");
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    press(v, "!");
    v.handleInput("\r");
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-2" }), "hi!");
    expect(v[INPUT_CONTEXT]()).toBe("viewer");
    v.handleInput("\x1b");
    expect(footerText(v.render(100))).not.toContain("Tab next");
  } finally { v.dispose(); }
});

test.each(["\r", "\n"])("Enter %j and Tab traverse controls across folded cells, disabled controls and notebook ends", enter => {
  const f = nbWith([{ id: "a", code: "first" }, { id: "h", code: 'mo.md("# Controls")' }, { id: "b", code: "second" }, { id: "c", code: "third" }]);
  const checkbox = (id: string, disabled = false) => `<marimo-ui-element object-id='${id}'><marimo-checkbox data-label='&quot;${id}&quot;' data-initial-value='false' data-disabled='${disabled}'></marimo-checkbox></marimo-ui-element>`;
  for (const id of ["a", "b", "c"]) f.notebook.apply("cell-op", { cell_id: id, output: { channel: "output", mimetype: "text/html", data: checkbox(id, id === "b") } });
  const setWidget = vi.fn();
  const v = make(f, { setWidget });
  const focus = (cell: string) => { screen(v); expect(v.snapshot().widget).toMatchObject({ cell, index: 0 }); };
  try {
    screen(v); v.handleInput("j"); v.handleInput("z"); // fold the destination section
    v.handleInput("k"); v.handleInput(enter);
    focus("a");
    v.handleInput("\t"); focus("b");
    expect(v.snapshot().cursor).toBe("b");
    expect(screen(v)).toContain("▸ b");
    v.handleInput(" "); expect(setWidget).not.toHaveBeenCalled();
    v.handleInput("j"); focus("c");
    v.handleInput("\t"); focus("a");
    v.handleInput("\x1b[Z"); focus("c");
    v.handleInput("k"); focus("b");
    v.handleInput("k"); focus("a");
    v.handleInput(" ");
    expect(setWidget).toHaveBeenCalledExactlyOnceWith(f, expect.objectContaining({ id: "a" }), expect.objectContaining({ objectId: "a" }), true);
    f.notebook.apply("cell-op", { cell_id: "a", output: { channel: "output", mimetype: "text/plain", data: "removed" } });
    screen(v); expect(v.snapshot().widget).toBeUndefined();
    v.handleInput("j"); v.handleInput("j"); v.handleInput("w"); focus("b");
    f.connection = "disconnected";
    screen(v); expect(v.snapshot().widget).toBeUndefined();
    v.handleInput(" "); expect(setWidget).toHaveBeenCalledTimes(1);
  } finally { v.dispose(); }
});

test("b still edits a control cell, and Enter edits an explicitly focused source part", async () => {
  const f = nbWith([{ id: "a", code: "controls = make_controls()" }]);
  f.notebook.apply("cell-op", { cell_id: "a", output: { channel: "output", mimetype: "text/html", data: widgetHtml } });
  const fake = fakeEditors();
  const v = make(f, { editors: fake.editors, setWidget: vi.fn() });
  try {
    screen(v); v.handleInput("b"); await editorReady();
    expect(fake.editors.state).toMatchObject({ cellId: "a", kind: "python" });
    expect(v.snapshot().widget).toBeUndefined();
    await fake.editors.close(); screen(v);
    const parts = (v as any).lastParts;
    (v as any).partCell = "a"; (v as any).part = parts.findIndex((p: any) => p.kind === "code");
    expect((v as any).part).toBeGreaterThanOrEqual(0);
    v.handleInput("\r"); await editorReady();
    expect(fake.editors.state).toMatchObject({ cellId: "a", kind: "python" });
    expect(v.snapshot().widget).toBeUndefined();
  } finally { v.dispose(); fake.editors.dispose(); }
});

test("a asks the agent about the cell from a prompt docked in the view", () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "load" }]);
  const ask = vi.fn();
  const v = make(f, { ask, agentBusy: () => true });
  try {
    v.handleInput("a");
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    const open = screen(v);
    expect(open).toContain("Ask the agent about load in nb.py");
    expect(open).toContain("the agent is working: this goes in as a follow-up");
    for (const width of [46, 120]) for (const l of v.render(width)) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
    press(v, "why?");
    v.handleInput("\r");
    expect(ask).toHaveBeenCalledExactlyOnceWith(f, expect.objectContaining({ id: "a" }), "why?");
    expect(v[INPUT_CONTEXT]()).toBe("viewer");
    expect(screen(v)).toContain("Sent to the agent.");
  } finally { v.dispose(); }
});

test(": runs Python in the kernel and shows what it printed and returned", async () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const scratch = vi.fn(async (_f: Followed, _code: string, onEvent: (e: any) => void) => {
    onEvent({ stream: "stdout", text: "two" });
    onEvent({ stream: "stderr", text: "careful" });
    return { success: true, output: { mimetype: "text/plain", data: "'ok'" } };
  });
  const v = make(f, { scratch });
  try {
    v.handleInput(":");
    expect(screen(v)).toContain("Python in nb.py's kernel");
    press(v, "1+1");
    v.handleInput("\r");
    expect(scratch).toHaveBeenCalledWith(f, "1+1", expect.any(Function), expect.any(AbortSignal));
    await new Promise((r) => setTimeout(r, 0));
    const text = screen(v);
    expect(text).toContain(">>> 1+1");
    expect(text).toContain("two");
    expect(text).toContain("careful");
    expect(text).toContain("'ok'");
    v.handleInput("\x1b");
    expect(screen(v)).not.toContain(">>> 1+1");
  } finally { v.dispose(); }
});

test("m marks the cell for the agent through Lens (or says there is none), M twice removes its mark", async () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "chart" }]);
  const mark = vi.fn(async () => "S1");
  const unmark = vi.fn(async () => {});
  const v = make(f, { mark, unmark });
  try {
    v.handleInput("m");
    expect(screen(v)).toContain("No Lens in this notebook");
    const lensState = (selections: unknown[]) => ({ revision: selections.length, nextLabel: `S${selections.length + 1}`, currentSelectionId: null, selections, history: [] });
    f.notebook.apply("model-lifecycle", { model_id: "m1", message: { method: "open", state: { _state: lensState([]), _lens_id: "l" } } });
    v.handleInput("m");
    expect(screen(v)).toContain("Note for the agent on chart (Lens S1)");
    press(v, "look");
    v.handleInput("\r");
    expect(mark).toHaveBeenCalledExactlyOnceWith(f, expect.objectContaining({ id: "a" }), "look");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen(v)).toContain("Marked S1.");
    f.notebook.apply("model-lifecycle", { model_id: "m1", message: { method: "update", state: { _state: lensState([{ id: "sel-1", label: "S1", note: "look", target: { kind: "notebook", cellIds: ["a"] } }]) } } });
    v.handleInput("M");
    expect(screen(v)).toContain("M again removes S1");
    v.handleInput("M");
    expect(unmark).toHaveBeenCalledExactlyOnceWith(f, "sel-1");
  } finally { v.dispose(); }
});

// --- the outline and the detail ---
function notebookWithResults(): Followed {
  const f = nbWith([
    { id: "Zx1a", code: "import marimo as mo\nimport pandas as pd" },
    { id: "Hd2b", code: 'mo.md("# Coffee sales")' },
    { id: "Ld3c", code: "daily = load()\nsmooth = daily.rolling(7).mean()" },
    { id: "Bm4d", code: "model = boom(daily)" },
    { id: "Ch5e", code: "alt.Chart(daily)" },
  ]);
  f.notebook.apply("variables", { variables: [
    { name: "mo", declared_by: ["Zx1a"], used_by: ["Hd2b"] }, { name: "pd", declared_by: ["Zx1a"], used_by: [] },
    { name: "daily", declared_by: ["Ld3c"], used_by: ["Bm4d", "Ch5e"] }, { name: "smooth", declared_by: ["Ld3c"], used_by: [] }, { name: "model", declared_by: ["Bm4d"], used_by: [] },
  ] });
  f.notebook.apply("variable-values", { variables: [{ name: "mo", value: "<module 'marimo'>", datatype: "module" }, { name: "pd", value: "<module 'pandas'>", datatype: "module" }, { name: "daily", value: "<Series object at 0x1042>", datatype: "Series" }] });
  f.notebook.apply("cell-op", { cell_id: "Ld3c", status: "idle" });
  f.notebook.apply("cell-op", { cell_id: "Bm4d", status: "idle", console: [{ channel: "stderr", mimetype: "text/plain", data: "Traceback (most recent call last):\n  File \"cell\", line 1\nKeyError: 'revenue'\n" }], output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "KeyError", msg: "'revenue'" }] } });
  f.notebook.apply("cell-op", { cell_id: "Ch5e", status: "idle", output: { channel: "output", mimetype: "image/png", data: "iVBOR" } });
  return f;
}

test("wide, the outline and the detail sit side by side, every line exactly as wide as the view, with no ids and no reprs", () => {
  const v = make(notebookWithResults());
  try {
    for (const width of [100, 140]) {
      const lines = v.render(width);
      for (const l of lines) expect(visibleWidth(l)).toBe(width);
      const text = lines.join("\n");
      // The title is where its markdown cell is, after the imports cell, and the cells are titled by what they are.
      expect(text).toMatch(/imports[\s\S]*Coffee sales[\s\S]*daily[\s\S]*model[\s\S]*chart/u);
      expect(text).toMatch(/▌ ?  imports\s{3,}imports/u);
      expect(text).not.toContain(" │ ");
      expect(lines.some(line => /^\s*[─━]{10,}\s*$/u.test(plain(line)))).toBe(false);
      for (const id of ["Zx1a", "Hd2b", "Ld3c", "Bm4d", "Ch5e"]) expect(text).not.toContain(id);
    }
    v.handleInput("j");
    v.handleInput("j");
    const detail = screen(v);
    expect(detail).toMatch(/▌ {2}  daily/u);
        expect(detail).not.toContain("<Series object");
    expect(detail).toContain("used by model, chart");
  } finally { v.dispose(); }
});

test("narrow, a few outline rows around the cursor sit above the detail, and the mouse knows which is which", async () => {
  const f = notebookWithResults();
  await f.notebook.settled();
  let closed = false;
  const fake = fakeEditors();
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, editors: fake.editors }, () => { closed = true; });
  const ev = (type: string, y: number, extra = {}) => ({ type, button: type === "wheel" ? "none" : "left", x: 10, y, screenX: 10, screenY: y, width: 80, height: 28, shift: false, alt: false, ctrl: false, ...extra }) as any;
  try {
    for (const l of v.render(80)) expect(visibleWidth(l)).toBe(80);
    v.handleInput("j");
    v.handleInput("j");
    v.handleInput("j");
    const lines = v.render(80);
    const text = lines.join("\n");
    // A single blank gap separates the outline from the detail, not a decorative rule.
    expect(text).toMatch(/daily[\s\S]*▌ {2}✗ model +\[ err\][\s\S]*chart[\s\S]*Traceback \(most recent call last\)/u);
    expect(text).toContain("enter edit");
    const rule = 2 + (v as any).panes.detailTop - 1;
    expect(plain(lines[rule]!).trim()).toBe("");
    // As many outline rows above the cursor as below it.
    const cursorRow = lines.findIndex((l) => l.includes("▌  ✗ model"));
    expect(cursorRow - 2).toBe(rule - 1 - cursorRow);
    expect(rule).toBeGreaterThan(3);
    expect(rule).toBeLessThan(12);
    // B opens the code for reading in place.
    v.handleInput("B");
    expect(v.render(80).join("\n")).toContain("model = boom(daily)");
    // A click on an outline row selects it; a click on the detail's code starts inline editing.
    const row = v.render(80).findIndex((l) => l.includes("  chart"));
    v.handleMouse(ev("click", row, { clickCount: 1 }));
    expect(v.render(80).join("\n")).toMatch(/▌ {2}  chart/u);
    v.handleInput("k");
    const code = v.render(80).findIndex((l) => l.includes(" model = boom(daily)"));
    v.handleMouse(ev("click", code));
    await editorReady();
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    expect(f.notebook.cells.get(fake.editors.state!.cellId)?.code).toBe("model = boom(daily)");
    expect(plain(v.render(80).join("\n"))).toContain("model = boom(daily)");
    await fake.editors.close();
    // The wheel over the outline moves the cursor.
    v.handleMouse(ev("wheel", 4, { wheelDelta: 1 }));
    expect(v.render(80).join("\n")).toMatch(/▌ {2}  chart/u);
    v.handleInput("\x1b");
    expect(closed).toBe(true);
  } finally { v.dispose(); fake.editors.dispose(); }
});

test("the detail of a failed cell shows its error, traceback and source", async () => {
  const f = notebookWithResults();
  await f.notebook.settled();
  const v = make(f);
  try {
    v.handleInput("e");
    const text = screen(v);
    expect(text).toMatch(/▌ {2}✗ model +\[ err\]/u);
    expect(text).toContain("KeyError: 'revenue'");
    expect(text).toContain("Traceback (most recent call last)");
    expect(text).toContain("  model = boom(daily)");
    expect((v as any).lastParts.map((part: any) => part.kind)).toEqual(["error", "code"]);
    expect((v as any).lastDetail.filter((r: any) => /^[─━]+$/u.test(plain(r.text)))).toHaveLength(0);
  } finally { v.dispose(); }
});

test("the view's own picture stays on screen while the painter takes the transcript's away", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  const f = nbWith([{ id: "a", code: "plot()" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "image/png", data: png } });
  const writes: string[] = [];
  const painted = { requestRender: () => {}, getScreenLines: () => [] as string[], doRender: () => {}, terminal: { rows: 28, write: (d: string) => { writes.push(d); } } };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
  const v = new NotebookView(painted as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    const line = v.render(120).find((l) => l.includes("\x1b_G"))!;
    const id = /(?:,|G)i=(\d+)/u.exec(line)![1];
    writes.length = 0;
    // Pi writes the frame, with the view's picture and a transcript image under the overlay.
    painted.terminal.write(`${line}\x1b_Ga=p,q=2,i=999\x1b\\`);
    painted.doRender();
    const after = writes.slice(1).join("");
    expect(after).toContain("a=d,d=i,i=999");
    expect(after).not.toContain(`i=${id},`);
    expect(after).not.toContain("a=d,d=a");
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

// --- docked beside the chat ---
test("docked: the banner says how to switch, Esc goes to the chat, q closes, and it never wipes the chat's pictures", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const writes: string[] = [];
  const painted = { requestRender: () => {}, getScreenLines: () => [] as string[], doRender: () => {}, terminal: { rows: 28, write: (d: string) => { writes.push(d); } } };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
  const focusMain = vi.fn();
  const done = vi.fn();
  const v = new NotebookView(painted as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, docked: { focused: () => false, focusMain } }, done);
  try {
    const lines = v.render(100);
    expect(lines[0]).toContain("Notebook nb.py · ctrl+] focus");
    expect(lines.join("\n")).toContain("enter edit / activate · ? help");
    v.handleInput("\x1b");
    expect(focusMain).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    v.handleInput("q");
    expect(done).toHaveBeenCalledOnce();
    painted.terminal.write("x");
    painted.doRender();
    expect(writes.join("")).not.toContain("a=d,d=a");
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test("| docks the full-screen view with its state, and undocks the docked one", () => {
  const cells = Array.from({ length: 12 }, (_, i) => ({ id: `cell-${i}`, code: `x = ${i}` }));
  const f = nbWith(cells);
  const dock = vi.fn();
  const done = vi.fn();
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, dock }, done);
  try {
    for (let i = 0; i < 10; i++) v.handleInput("j");
    v.handleInput("B");
    v.handleInput("O");
    v.handleInput("|");
    expect(dock).toHaveBeenCalledWith(notebookKey(f), expect.objectContaining({ cursor: "cell-10", codeOpen: ["cell-10"], section: true }));
    expect(done).toHaveBeenCalled();
  } finally { v.dispose(); const reset = make(f); reset.handleInput("O"); reset.dispose(); }
  const undock = vi.fn();
  const d = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, docked: { focused: () => true, focusMain: () => {} }, undock }, () => {});
  try {
    d.handleInput("|");
    expect(undock).toHaveBeenCalledOnce();
  } finally { d.dispose(); }
});

test("a view started from a state shows the same cell and code", () => {
  const f = nbWith(Array.from({ length: 12 }, (_, i) => ({ id: `cell-${i}`, code: `x = ${i}`, name: `cell-${i}` })));
  const v = make(f, { initial: { cursor: "cell-10", codeOpen: ["cell-10"], section: false, follow: false, scroll: 0, detailScroll: 0, folded: [], diffs: [], filter: "", mode: "cells", varFilter: "" } });
  try {
    const text = screen(v);
    expect(text).toContain("▌  cell-10");
    expect(text).toContain("  x = 10");
  } finally { v.dispose(); }
});

// --- parts, tables, markdown editing, code blocks ---

test.each([false, true])("section renders Python source before its output, including inline editing (editor=%s)", editing => {
  const f = nbWith([{ id: "a", code: "value = 42" }]);
  const cell = f.notebook.cells.get("a")!;
  cell.output = { kind: "text", text: "result text" };
  const d = detailRows(f.notebook, theme, 0, {
    cell, width: 80, section: true, codeOpen: false, diff: false,
    sectionCodeFolded: editing ? new Set(["a"]) : undefined,
    inlineEditor: editing ? { cellId: "a", kind: "python", rows: () => [{ text: "inline draft", editorRow: 0 }] } : undefined,
  });
  expect(d.parts.map(p => p.kind)).toEqual(["code", "output"]);
  const source = d.rows.findIndex(r => editing ? r.editorRow === 0 : r.sourceLine === 0);
  const output = d.rows.findIndex(r => r.text.includes("result text"));
  expect(source).toBeGreaterThanOrEqual(0);
  expect(output).toBeGreaterThan(source);
});

test.each([false, true])("detail finalization drops mixed-output wrappers and remaps anchors (section=%s)", section => {
  const f = nbWith([{ id: "a", code: "mo.md(dynamic)" }]);
  const cell = f.notebook.cells.get("a")!;
  vi.spyOn(f.notebook, "isMarkdown").mockReturnValue(true);
  const first = { kind: "text" as const, text: "first" };
  const second = { kind: "widgets" as const, text: "", widgets: [] as NonNullable<typeof cell.output>["widgets"] };
  cell.output = { kind: "text", text: "", blocks: [{ id: "one", output: first }, { id: "two", output: second }] };
  // An ordered widget leaf retains its flat cell index, even after its wrapper disappears.
  const widget = { objectId: "control", kind: "checkbox", tag: "marimo-checkbox", label: "control", options: [], value: false } as any;
  second.widgets!.push(widget);
  cell.output.widgets = [widget];
  const render = (partFocus?: number) => detailRows(f.notebook, theme, 0, { cell, width: 80, section, codeOpen: true, diff: false, partFocus });
  const d = render();
  expect(d.parts.map(p => p.kind)).toEqual(section ? ["output", "widgets"] : ["output", "widgets", "code"]);
  expect(d.parts[0]!.output).toBe(first);
  expect(d.parts[1]!.output).toBe(second);
  expect(d.parts[1]!.widgetIndices).toEqual([0]);
  d.parts.forEach((p, index) => {
    expect(d.rows[p.row]!.part).toBe(index);
    expect(d.rows.some(r => r.part === index && r.text.trim())).toBe(true);
  });
  const widgetRow = d.widgetRows.get("a\0" + 0)!;
  expect(d.rows[widgetRow]!.widget).toEqual({ cell: "a", index: 0 });
  expect(d.rows.every(r => !/^[─━]+$/.test(plain(r.text)))).toBe(true);
  if (section) expect(d.focusRow).toBe(d.parts[0]!.row);
  const focused = render(1);
  expect(plain(focused.rows[focused.parts[1]!.row]!.text)).toBe("▸");
});

test.each([46, 80, 100, 120].flatMap(width => [false, true].map(section => ({ width, section }))))("clipped images show one alt on the first visible image row (width=$width, section=$section)", ({ width, section }) => {
  const f = nbWith([{ id: "a", code: "diagram" }]);
  f.notebook.cells.get("a")!.output = { kind: "chart", text: "", mermaid: ["graph TD; A-->B"] };
  const v = make(f);
  (v as any).section = section;
  (v as any).diagramRows = () => Array.from({ length: 40 }, (_, index) => ({
    text: index === 0 ? "IMAGE PLACEMENT" : "",
    image: { index, height: 40, alt: "[clipped diagram]" },
  }));
  try {
    expect(screen(v, width).match(/\[clipped diagram\]/g)).toHaveLength(1);
    const start = (v as any).lastDetail.findIndex((r: any) => r.image);
    (v as any).detailScroll = start + 3;
    const shown = screen(v, width);
    expect(shown).toContain("[clipped diagram]");
    expect(shown).not.toContain("IMAGE PLACEMENT");
    expect(shown.match(/\[clipped diagram\]/g)).toHaveLength(1);
  } finally { v.dispose(); }
});

test("structural gaps compact without consuming source padding, blank lines or editor rows", () => {
  const f = nbWith([{ id: "a", code: "x = 1\n\n" }]);
  const cell = f.notebook.cells.get("a")!;
  const options = { cell, width: 80, section: false, codeOpen: true, diff: false };
  const d = detailRows(f.notebook, theme, 0, options);
  const p = d.parts.find(p => p.kind === "code")!;
  expect(d.rows[p.row]!.text).toBe("");
  expect(d.rows[p.row - 1]!.text.trim()).not.toBe("");
  expect(d.rows.filter(r => r.sourceLine !== undefined).map(r => r.sourceLine)).toEqual([0, 1, 2]);
  const source = d.rows.filter(r => r.blockId === "a:source");
  expect(source[1]!.text.trim()).toBe("");
  expect(source.at(-1)!.text.trim()).toBe("");
  const edited = detailRows(f.notebook, theme, 0, { ...options, inlineEditor: { cellId: "a", kind: "python", rows: () => [{ text: "", editorRow: 0 }, { text: "", editorRow: 1 }] } });
  expect(edited.rows.filter(r => r.editorRow !== undefined).map(r => r.editorRow)).toEqual([0, 1]);
  cell.output = { kind: "chart", text: "", mermaid: ["graph TD; A-->B"] };
  const image = detailRows(f.notebook, theme, 0, { ...options, diagramRows: () => [
    { text: "picture", image: { index: 0, height: 3, alt: "diagram" } },
    { text: "", image: { index: 1, height: 3, alt: "diagram" } },
    { text: "", image: { index: 2, height: 3, alt: "diagram" } },
  ] });
  expect(image.rows.filter(r => r.image).map(r => r.image!.index)).toEqual([0, 1, 2]);
});

test("ctrl+d and ctrl+u move between sections; ctrl+k no longer navigates", () => {
  const f = nbWith([{ id: "h1", code: 'mo.md("# One")' }, { id: "a", code: "a = 1" }, { id: "h2", code: 'mo.md("# Two")' }, { id: "c", code: "c = 3" }]);
  const v = make(f);
  try {
    expect(screen(v)).toMatch(/▌ One/u);
    v.handleInput("\x0b");
    expect(screen(v)).toMatch(/▌ One/u);
    v.handleInput("\x04");
    expect(screen(v)).toMatch(/▌ Two/u);
    v.handleInput("\x15");
    expect(screen(v)).toMatch(/▌ One/u);
  } finally { v.dispose(); }
});

test("n and p walk a cell's parts and B opens the code for reading", async () => {
  const f = nbWith([{ id: "a", code: "x = 1\nprint(x)" }, { id: "b", code: "y = 2" }]);
  const slider = "<marimo-ui-element object-id='a-0' random-id='x'><marimo-slider data-initial-value='1' data-label='&quot;s&quot;' data-start='0' data-stop='2' data-step='1' data-steps='[]'></marimo-slider></marimo-ui-element>";
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", console: [{ channel: "stdout", mimetype: "text/plain", data: "one\ntwo\n" }], output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "KeyError", msg: "k" }] } });
  f.notebook.apply("cell-op", { cell_id: "a", output: { channel: "output", mimetype: "text/html", data: slider } });
  // The error output was replaced by the widget; set the error again through the cell's own state.
  f.notebook.cells.get("a")!.error = "KeyError: k";
  await f.notebook.settled();
  const v = make(f, { setWidget: () => {}, code: "folded" });
  try {
    // Focus belongs to the short header, not the content rows.
    const focused = () => { screen(v); return (v as any).lastParts[(v as any).part]?.kind ?? ""; };
    screen(v);
    expect((v as any).lastDetail.some((r: any) => /^(code|printed|output|chart|table|widgets|markdown)$/.test(plain(r.text).trim()))).toBe(false);
    v.handleInput("n");
    expect(focused()).toBe("error");
    expect(screen(v)).toContain("KeyError: k");
    v.handleInput("n");
    expect(focused()).toBe("printed");
    expect((v as any).lastDetail.map((row: { text: string }) => plain(row.text).trim())).toEqual(expect.arrayContaining(["one", "two"]));
    v.handleInput("n");
    expect(focused()).toBe("widgets");
    expect(screen(v)).toMatch(/◆ s/u);
    v.handleInput("n");
    expect(focused()).toBe("code");
    expect(screen(v)).toContain("▸ python");
    v.handleInput("B");
    expect(screen(v)).toContain("▾ python");
    expect(screen(v)).toContain("print(x)");
    v.handleInput("p");
    expect(focused()).toBe("widgets");
    v.handleInput("j");
    v.handleInput("k");
    expect(focused()).toBe("");
  } finally { v.dispose(); }
});

const tableHtml = (selection = "multi") => `<marimo-ui-element object-id='t-0' random-id='r'><marimo-table data-data='&quot;[{&#92;&quot;city&#92;&quot;:&#92;&quot;Oslo&#92;&quot;,&#92;&quot;pop&#92;&quot;:709000,&#92;&quot;_marimo_row_id&#92;&quot;:&#92;&quot;0&#92;&quot;}]&quot;' data-total-rows='30' data-total-columns='2' data-page-size='1' data-selection='&quot;${selection}&quot;' data-field-types='[[&quot;city&quot;,[&quot;string&quot;,&quot;object&quot;]],[&quot;pop&quot;,[&quot;integer&quot;,&quot;int64&quot;]]]'></marimo-table></marimo-ui-element>`;

test.each([46, 80, 100, 120, 180])("table focus uses the rendered column width (%i columns)", async (width) => {
  const { clearTableSessions, tableSession } = await import("../src/ui/table-session.js");
  clearTableSessions();
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: tableHtml() } });
  const cell = f.notebook.cells.get("a")!;
  const data = cell.output!.table!;
  const session = tableSession(`${notebookKey(f)}\0${data.objectId}`, cell, data);
  const ensure = vi.spyOn(session, "ensureVisible");
  const v = make(f, { table: { call: async () => ({}), file: async () => "[]" } });
  try {
    v.render(width);
    v.handleInput("t");
    for (const selection of ["multi", "single", "single-cell", "multi-cell", undefined] as const) {
      data.selection = selection;
      const lines = v.render(width);
      const detailWidth = width - (v as any).panes.detailLeft - CONTENT_LEFT;
      expect(ensure).toHaveBeenLastCalledWith(detailWidth - 1);
      expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
      const row = (v as any).lastDetail.findIndex((r: any) => r.tableRow === 0);
      const y = 2 + (v as any).panes.detailTop + row - (v as any).detailScroll;
      session.row = 1;
      v.handleMouse({ type: "click", button: "left", x: (v as any).panes.detailLeft, y, screenX: 0, screenY: y, width, height: 28, shift: false, alt: false, ctrl: false } as any);
      expect(session.row).toBe(0);
    }
  } finally { v.dispose(); clearTableSessions(); }
});

test.each([46, 100, 180])("table viewport pins header/status and mouse targets the same column as keyboard (%i columns)", async width => {
  const { clearTableSessions, tableSession } = await import("../src/ui/table-session.js");
  clearTableSessions();
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", output: { channel: "output", mimetype: "text/html", data: tableHtml() } });
  const cell = f.notebook.cells.get("a")!, data = cell.output!.table!;
  data.records = Array.from({ length: 40 }, (_, i) => ({ city: `City ${i}`, pop: i, _marimo_row_id: String(i) }));
  data.rows = data.records.map(r => [String(r.city), String(r.pop)]);
  data.pageSize = 40; data.totalRows = 40;
  const session = tableSession(`${notebookKey(f)}\0${data.objectId}`, cell, data);
  const setTableSelection = vi.fn();
  const call = vi.fn(async () => ({ data: JSON.stringify(data.records), total_rows: 40 }));
  const v = make(f, { table: { call, file: async () => "[]" }, setTableSelection });
  const click = (index: number, column: string, shift = false) => {
    const row = (v as any).lastDetail[index];
    const bounds = row.tableColumns.find((c: any) => c.column === column);
    expect(bounds).toBeDefined();
    const x = (v as any).panes.detailLeft + bounds.start;
    const y = 2 + (v as any).panes.detailTop + index;
    v.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: 28, shift, alt: false, ctrl: false } as any);
  };
  try {
    v.render(width); (v as any).detailScroll = 2;
    v.handleInput("t"); v.render(width);
    const header = (v as any).lastDetail.findIndex((r: any) => r.tableHeader);
    const status = (v as any).lastDetail.length - 1;
    for (let i = 0; i < 30; i++) v.handleInput("j");
    v.render(width);
    expect(session.row).toBe(30); expect(session.rowOffset).toBeGreaterThan(0);
    expect((v as any).lastDetail[header].tableHeader).toBe(true);
    expect(plain((v as any).lastDetail[status].text)).toContain("selected");
    expect((v as any).lastDetail.some((r: any) => r.tableRow === 30)).toBe(true);
    expect((v as any).detailScroll).toBe(0);
    const index = (v as any).lastDetail.findIndex((r: any) => r.tableRow === 30);
    click(index, "pop"); expect(session.col).toBe(1); expect(session.row).toBe(30);
    v.handleInput("h"); expect(session.col).toBe(0);
    v.handleInput("l"); expect(session.col).toBe(1);
    const y = 2 + (v as any).panes.detailTop + index;
    v.handleMouse({ type: "wheel", button: "none", x: (v as any).panes.detailLeft, y, screenX: 0, screenY: y, width, height: 28, shift: false, alt: false, ctrl: false, wheelDelta: 2 } as any);
    v.render(width); expect(session.row).toBe(32);
    expect((v as any).lastDetail[header].tableHeader).toBe(true);
    expect(setTableSelection).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
    click(header, "city"); await editorReady();
    expect(call).toHaveBeenLastCalledWith(f, "t-0", "search", expect.objectContaining({ sort: [{ by: "city", descending: false }] }));
    v.render(width); click(header, "pop", true); await editorReady();
    expect(call).toHaveBeenLastCalledWith(f, "t-0", "search", expect.objectContaining({ sort: [{ by: "city", descending: false }, { by: "pop", descending: false }] }));
    expect(setTableSelection).not.toHaveBeenCalled();
    v.handleInput("\x1b"); expect((v as any).detailScroll).toBe(2);
  } finally { v.dispose(); clearTableSessions(); }
});

test("short table viewports never classify body rows as sortable headers", async () => {
  const { clearTableSessions, tableSession } = await import("../src/ui/table-session.js");
  clearTableSessions();
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", output: { channel: "output", mimetype: "text/html", data: tableHtml() } });
  const cell = f.notebook.cells.get("a")!, data = cell.output!.table!;
  data.label = "Sales"; data.banner = "attention"; data.wrapped = ["city"];
  data.records = [{ city: "A very long description ".repeat(8), pop: 1, _marimo_row_id: "0" }];
  data.rows = [[String(data.records[0]!.city), "1"]]; data.totalRows = 1;
  const session = tableSession(`${notebookKey(f)}\0${data.objectId}`, cell, data);
  const call = vi.fn(async () => ({ data: JSON.stringify(data.records), total_rows: 1 }));
  const tui = { requestRender: vi.fn(), terminal: { rows: 6 } };
  const v = new NotebookView(tui as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, table: { call, file: async () => "[]" },
  }, () => {});
  const click = (index: number) => {
    const x = (v as any).panes.detailLeft + (v as any).lastDetail[index].tableColumns[0].start;
    const y = 2 + (v as any).panes.detailTop + index;
    v.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 46, height: tui.terminal.rows, shift: false, alt: false, ctrl: false } as any);
  };
  try {
    v.render(46); v.handleInput("t"); v.render(46);
    const tinyBody = (v as any).lastDetail.findIndex((r: any) => r.tableRow === 0);
    expect(tinyBody).toBeGreaterThanOrEqual(0);
    expect((v as any).lastDetail[tinyBody].tableHeader).toBeUndefined();
    expect((v as any).lastDetail.some((r: any) => r.tableHeader)).toBe(false);
    click(tinyBody); expect(call).not.toHaveBeenCalled(); expect(session.sort).toEqual([]);
    tui.terminal.rows = 9; v.render(46);
    const body = (v as any).lastDetail.findIndex((r: any) => r.tableRow === 0);
    const header = (v as any).lastDetail.findIndex((r: any) => r.tableHeader);
    expect(header).toBeGreaterThanOrEqual(0);
    expect(header).toBeLessThan(body);
    click(body); expect(call).not.toHaveBeenCalled();
    click(header); await editorReady();
    expect(call).toHaveBeenCalledWith(f, data.objectId, "search", expect.objectContaining({ sort: [{ by: "city", descending: false }] }));
  } finally { v.dispose(); clearTableSessions(); }
});

test("table resize, fit, cancel-first column picker and raw value viewer preserve the session", async () => {
  const { clearTableSessions, tableSession } = await import("../src/ui/table-session.js");
  clearTableSessions();
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", output: { channel: "output", mimetype: "text/html", data: tableHtml() } });
  const cell = f.notebook.cells.get("a")!, data = cell.output!.table!;
  const raw = "first line\n" + "long value ".repeat(20) + "RAW_END";
  data.records![0]!.city = raw;
  const session = tableSession(`${notebookKey(f)}\0${data.objectId}`, cell, data);
  const confirm = vi.fn(async (_title: string, choices: string[]) => choices[2]);
  const call = vi.fn(async () => ({})), copy = vi.fn(), saveTable = vi.fn(async () => "file.csv");
  const v = make(f, { table: { call, file: async () => "[]" }, confirm, copy, saveTable });
  try {
    v.render(100); v.handleInput("t"); v.render(100);
    v.handleInput("H"); const narrow = session.columnWidths.get("city")!;
    v.handleInput("L"); expect(session.columnWidths.get("city")).toBe(narrow + 2);
    v.handleInput("="); expect(session.columnWidths.get("city")).toBeGreaterThan(narrow);
    v.handleInput("v"); expect(v.snapshot().message?.text).toBe(raw);
    v.handleInput("G"); expect(screen(v)).toContain("RAW_END");
    v.handleInput("\x1b"); expect(v.snapshot().message).toBeUndefined();
    expect(v.snapshot().table).toMatchObject({ cell: "a", objectId: "t-0" });
    expect(session.col).toBe(0); expect(session.row).toBe(0);
    v.handleInput("\x07"); await editorReady();
    expect(confirm).toHaveBeenCalledWith("Choose table column", ["Cancel", "1. city", "2. pop"]);
    expect(session.col).toBe(1);
    confirm.mockResolvedValueOnce(undefined);
    v.handleInput("\x07"); await editorReady();
    expect(confirm).toHaveBeenCalledTimes(2); expect(session.col).toBe(1);
    expect(call).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled(); expect(saveTable).not.toHaveBeenCalled();
  } finally { v.dispose(); clearTableSessions(); }
});

test("active tables sanitize producer bytes without merging identically displayed columns", async () => {
  const { clearTableSessions, tableSession } = await import("../src/ui/table-session.js");
  clearTableSessions();
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", output: { channel: "output", mimetype: "text/html", data: tableHtml() } });
  const cell = f.notebook.cells.get("a")!, data = cell.output!.table!;
  const first = "city\x1b[31m";
  const second = "city\x1b[32m";
  const payload = "value\x1b]52;c;Y29weQ==\x07";
  data.columns = [first, second];
  data.records = [{ [first]: payload, [second]: "other", _marimo_row_id: "0" }];
  data.rows = [[payload, "other"]];
  data.numeric = [false, false];
  const session = tableSession(`${notebookKey(f)}\0${data.objectId}`, cell, data);
  const confirm = vi.fn(async (_title: string, choices: string[]) => choices[2]);
  const call = vi.fn(async () => ({ data: JSON.stringify(data.records), total_rows: 1 }));
  const v = make(f, { table: { call, file: async () => "[]" }, confirm });
  try {
    v.render(100); v.handleInput("t");
    const rendered = screen(v);
    expect(rendered).not.toContain("\x1b]52;");
    expect(rendered).not.toContain("\x1b[31m");
    expect(rendered).not.toContain("\x1b[32m");
    expect(session.cellValue()).toBe(payload);
    v.handleInput("\x07"); await editorReady();
    expect(confirm).toHaveBeenCalledWith("Choose table column", ["Cancel", "1. city", "2. city"]);
    expect(session.columnName()).toBe(second);
    v.handleInput("s"); await editorReady();
    expect(call).toHaveBeenCalledWith(f, data.objectId, "search", expect.objectContaining({ sort: [{ by: second, descending: false }] }));
  } finally { v.dispose(); clearTableSessions(); }
});

test("focused ordered chart actions inspect the leaf output object, not its compatibility projection", () => {
  const f = nbWith([{ id: "a", code: "mixed" }]);
  const first = { kind: "chart" as const, plotly: "first" };
  const second = { kind: "chart" as const, plotly: "second" };
  f.notebook.cells.get("a")!.output = { ...first, blocks: [{ id: "first", output: first }, { id: "second", output: second }] };
  const v = make(f);
  try {
    (v as any).cursor = "a"; (v as any).partCell = "a";
    (v as any).lastParts = [{ kind: "chart", cell: "a", output: second }];
    (v as any).part = 0;
    const inspect = vi.spyOn((v as any).live, "inspect").mockReturnValue(true);
    v.handleInput("i"); expect(inspect).toHaveBeenLastCalledWith(second);
    v.handleInput("\r"); expect(inspect).toHaveBeenLastCalledWith(second);
  } finally { v.dispose(); }
});

test("ordered leaf tables drive only their own objectId", async () => {
  const { clearTableSessions } = await import("../src/ui/table-session.js");
  clearTableSessions();
  const f = nbWith([{ id: "a", code: "mixed" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: tableHtml() + "<p>between</p>" + tableHtml().replace("t-0", "t-1") } });
  const call = vi.fn(async () => ({ data: "[]", total_rows: 30 }));
  const setTableSelection = vi.fn();
  const v = make(f, { table: { call, file: async () => "[]" }, setTableSelection });
  try {
    v.render(120);
    const parts = (v as any).lastParts;
    const index = parts.findIndex((part: any) => part.tableObjectId === "t-1");
    expect(index).toBeGreaterThanOrEqual(0);
    (v as any).part = index;
    v.handleInput("t");
    expect(v.snapshot().table?.objectId).toBe("t-1");
    v.render(120); call.mockClear();
    v.handleInput("]"); await editorReady();
    expect(call).toHaveBeenCalledWith(f, "t-1", "search", expect.anything());
    expect(call.mock.calls.every(args => (args as unknown[])[1] === "t-1")).toBe(true);
    v.handleInput(" ");
    expect(setTableSelection.mock.calls.every(args => args[2] === "t-1")).toBe(true);
  } finally { v.dispose(); clearTableSessions(); }
});

test("mixed interactive and static table leaves retain distinct data and static focus cannot drive the remote table", async () => {
  const { clearTableSessions } = await import("../src/ui/table-session.js"); clearTableSessions();
  const f = nbWith([{ id: "a", code: "mixed" }]);
  const html = tableHtml().replace("Oslo", "REMOTE_TABLE") + "<table><tr><th>city</th></tr><tr><td>STATIC_TABLE</td></tr></table>";
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: html } });
  const call = vi.fn(async () => ({ data: "[]" }));
  const v = make(f, { table: { call, file: async () => "[]" } });
  try {
    const rendered = v.render(120).join("\n");
    expect(rendered).toContain("REMOTE_TABLE"); expect(rendered).toContain("STATIC_TABLE");
    const parts = (v as any).lastParts;
    const index = parts.findIndex((p: any) => p.kind === "table" && !p.output?.table?.objectId);
    expect(index).toBeGreaterThanOrEqual(0);
    (v as any).part = index;
    call.mockClear(); v.handleInput("\r");
    expect(v.snapshot().table).toBeUndefined();
    v.handleInput("t"); v.handleInput(" ");
    expect(v.snapshot().table).toBeUndefined(); expect(call).not.toHaveBeenCalled();
  } finally { v.dispose(); clearTableSessions(); }
});

test("Enter on the second ordered widget leaf drives its flat widget index", () => {
  const f = nbWith([{ id: "a", code: "widgets" }]);
  const checkbox = (id: string) => `<marimo-ui-element object-id='${id}'><marimo-checkbox data-initial-value='false' data-label='&quot;${id}&quot;'></marimo-checkbox></marimo-ui-element>`;
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: checkbox("first") + "<p>between</p>" + checkbox("second") } });
  const setWidget = vi.fn(); const v = make(f, { setWidget });
  try {
    v.render(120);
    const parts = (v as any).lastParts;
    const index = parts.findIndex((p: any) => p.widgetIndices?.includes(1));
    expect(index).toBeGreaterThanOrEqual(0);
    (v as any).part = index; v.handleInput("\r");
    expect(v.snapshot().widget?.index).toBe(1);
    v.handleInput(" ");
    expect(setWidget).toHaveBeenCalledExactlyOnceWith(f, expect.anything(), expect.objectContaining({ objectId: "second" }), true);
  } finally { v.dispose(); }
});

test("t drives a marimo table: paging, sorting and selection go through the kernel", async () => {
  const { clearTableSessions } = await import("../src/ui/table-session.js");
  clearTableSessions();
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: tableHtml() } });
  const calls: any[] = [];
  const call = vi.fn(async (_f: unknown, _id: string, fn: string, args: any) => {
    calls.push({ fn, args });
    return { data: JSON.stringify([{ city: "Rome", pop: 5, _marimo_row_id: "9" }]), total_rows: 30 };
  });
  const setTableSelection = vi.fn();
  const v = make(f, { table: { call, file: async () => "[]" }, setTableSelection });
  try {
    v.render(100);
    v.handleInput("t");
    expect(screen(v)).toContain("enter row detail · ? help");
    v.handleInput("]");
    await Promise.resolve();
    expect(calls.at(-1)).toMatchObject({ fn: "search", args: { page_number: 1, page_size: 1 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen(v)).toContain("Rome");
    v.handleInput("s");
    expect(calls.at(-1)?.args.sort).toEqual([{ by: "city", descending: false }]);
    await new Promise((r) => setTimeout(r, 0));
    v.handleInput(" ");
    expect(setTableSelection).toHaveBeenCalledWith(f, expect.anything(), "t-0", ["9"]);
    v.handleInput("\r");
    expect(screen(v)).toContain("row 1");
    v.handleInput("\x1b");
    expect(screen(v)).not.toContain("row 1");
    expect(screen(v)).toContain("enter row detail · ? help");
    v.handleInput("\x1b");
    expect(screen(v)).not.toContain("enter row detail · ? help");
  } finally { v.dispose(); clearTableSessions(); }
});

test("Enter edits native Markdown text and saves its exact body with the original expected code", async () => {
  const original = 'mo.md("# Title")';
  const f = nbWith([{ id: "m", code: original }, { id: "a", code: "x = 1" }]);
  const fake = fakeEditors();
  const saveCell = vi.fn(async (_f: Followed, _id: string, code: string, _expected: string) => ({ canonicalCode: code, requestId: "save-1" }));
  const v = make(f, { editors: fake.editors, saveCell });
  try {
    expect(screen(v)).not.toContain("mo.md");
    v.handleInput("\r");
    await editorReady();
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    expect(fake.options()).toMatchObject({ text: "# Title", filetype: "markdown" });
    expect(plain(screen(v))).toContain("# Title");
    fake.draft("# Title!");
    await fake.options().onWrite("# Title!", "# Title");
    expect(saveCell).toHaveBeenCalledExactlyOnceWith(f, "m", 'mo.md(r"""# Title!""")', original);
    expect(fake.editors.state?.dirty).toBe(false);
  } finally { v.dispose(); fake.editors.dispose(); }
});

test("code has a full-width continuous background block when the theme has one", () => {
  const f = nbWith([{ id: "a", code: "x = 1\n\ny = 2" }]);
  const bgTheme = { ...theme, bg: (c: string, t: string) => `<${c}>${t}</${c}>` };
  const v = new NotebookView(tui as any, bgTheme as any, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    screen(v);
    v.handleInput("B");
    const text = screen(v);
    expect(text).toContain("<toolPendingBg>");
    expect(text).not.toContain("│");
    const source = (v as any).lastDetail.filter((row: any) => row.sourceLine !== undefined);
    expect(source).toHaveLength(3);
    const background = (row: { text: string }) => row.text.replace(/<\/?toolPendingBg>/gu, "");
    const blockWidth = visibleWidth(background((v as any).lastDetail.find((row: any) => row.blockId === "a:source")));
    for (const row of source) {
      expect(row.text).toMatch(/^<toolPendingBg>[\s\S]*<\/toolPendingBg>$/u);
      expect(visibleWidth(background(row))).toBe(blockWidth);
      expect(background(row).startsWith("  ")).toBe(true);
    }
    const detail = (v as any).lastDetail;
    expect(background(detail[detail.indexOf(source[0]) - 1])).toBe(" ".repeat(blockWidth));
    expect(background(detail[detail.indexOf(source.at(-1)) + 1])).toBe(" ".repeat(blockWidth));
  } finally { v.dispose(); }
});

test.each([46, 80, 100, 120, 180])("the mouse drives widgets: a press on a slider sets it and a drag moves it, a click toggles a checkbox, the wheel steps the focused one (%i columns)", (width) => {
  const f = nbWith([{ id: "a", code: "n = mo.ui.slider(0, 10)" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: widgetHtml } });
  const setWidget = vi.fn((g: Followed, cell: any, w: any, value: unknown) => g.notebook.setUserValue(cell.id, w.objectId, w.label, value));
  const v = make(f, { setWidget });
  const ev = (type: string, x: number, y: number, extra = {}) => ({ type, button: type === "wheel" ? "none" : "left", x, y, screenX: x, screenY: y, width, height: 28, shift: false, alt: false, ctrl: false, ...extra }) as any;
  try {
    const lines = v.render(width);
    const sliderRow = lines.findIndex((l) => l.includes("◆ n "));
    const boxRow = lines.findIndex((l) => l.includes("◆ on "));
    // Where the slider's bar starts: the line's text, from the local content origin.
    const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/gu, "");
    const barAt = strip(lines[sliderRow]!).indexOf("━");
    // The press at the bar's last cell sets the top value and captures the drag.
    expect(v.handleMouse(ev("press", barAt + 15, sliderRow))).toEqual({ handled: true, capture: true });
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.objectContaining({ id: "a" }), expect.objectContaining({ objectId: "a-0" }), 10);
    v.handleMouse(ev("drag", barAt, sliderRow));
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-0" }), 0);
    v.handleMouse(ev("release", barAt, sliderRow));
    // The wheel over the focused slider steps it; up is more.
    v.handleMouse(ev("wheel", barAt, sliderRow, { wheelDelta: -1 }));
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-0" }), 1);
    // A click on the checkbox toggles it.
    const boxAt = strip(v.render(width)[boxRow]!).indexOf("[x]");
    v.handleMouse(ev("press", boxAt, boxRow));
    v.handleMouse(ev("click", boxAt, boxRow));
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-1" }), false);
    expect(v.render(width).join("\n")).toContain("▸ on");
    expect((v as any).lastParts[(v as any).part]?.kind).toBe("widgets");
  } finally { v.dispose(); }
});

test("ctrl+d and ctrl+u move through a filter's matches without leaving input", () => {
  const f = nbWith([{ id: "h", code: 'mo.md("# H")' }, { id: "a", code: "xa = 1", name: "load_a" }, { id: "b", code: "y = 2" }, { id: "c", code: "xc = 3", name: "load_c" }]);
  const v = make(f);
  try {
    v.handleInput("/");
    for (const ch of "load") v.handleInput(ch);
    expect(screen(v)).toMatch(/▌  load_a/u);
    v.handleInput("\x04");
    expect(v[INPUT_CONTEXT]()).toBe("filter");
    expect(screen(v)).toMatch(/▌  load_c/u);
    v.handleInput("\x15");
    expect(screen(v)).toMatch(/▌  load_a/u);
    v.handleInput("\x04");
    v.handleInput("\r");
    // Found: every cell shows again, the cursor on the match.
    expect(screen(v)).toMatch(/▌ +  load_c/u);
    expect(screen(v)).toContain("y = 2");
  } finally { v.dispose(); }
});

test("focusing the code does not move it: only the header carries the bar", () => {
  const f = nbWith([{ id: "a", code: "x = 1\ny = 2" }]);
  const bgTheme = { ...theme, bg: (c: string, t: string) => `<${c}>${t}</${c}>` };
  const v = new NotebookView(tui as any, bgTheme as any, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, code: "folded" }, () => {});
  try {
    v.handleInput("B");
    const column = () => { const l = v.render(100).find((x) => x.includes("y = 2"))!; return l.indexOf("y = 2"); };
    const before = column();
    v.handleInput("n");
    expect(v.render(100).join("\n")).toContain("<toolPendingBg>  y = 2");
    expect((v as any).lastParts[(v as any).part]?.kind).toBe("code");
    expect(v.render(100).join("\n")).not.toContain("<toolPendingBg>▌");
    expect(column()).toBe(before);
  } finally { v.dispose(); }
});

test("r shows the cell queued at once, then marimo's run: a spinner in the outline, the detail and the header", () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "load" }, { id: "b", code: "y = x" }]);
  const run = vi.fn(async () => {});
  const v = make(f, { run });
  try {
    expect(screen(v)).toContain("r run");
    v.handleInput("r");
    expect(run).toHaveBeenCalledOnce();
    let text = screen(v);
    expect(text).toMatch(/▌◌ load +\[ wait\]/u);
    expect(text).toContain(" wait");
    expect(text).toContain("◌ 1 queued");
    f.notebook.apply("cell-op", { cell_id: "a", status: "running", timestamp: Date.now() / 1000 });
    text = screen(v);
    expect(text).toMatch(/▌[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] load/u);
    expect(text).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] running load \d+s/u);
    expect(text).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] running \d+(?: ms|s)/u);
    expect(text).toContain("x interrupt");
  } finally { v.dispose(); }
});

test("code is open by default; B folds a cell's code and opens it again", () => {
  const f = nbWith([{ id: "a", code: "x = 1\ny = 2" }]);
  const v = make(f);
  try {
    expect(screen(v)).toContain("  y = 2");
    v.handleInput("B");
    expect(screen(v)).toContain("▸ python");
    expect(screen(v)).toContain("  x = 1");
    expect(screen(v)).toContain("  y = 2");
    v.handleInput("B");
    expect(screen(v)).toContain("  y = 2");
    expect(screen(v)).toContain("▾ python");
  } finally { v.dispose(); }
});

test("STEP3 progress renders every task, proportional counts, unknown totals and all stats", () => {
  const tasks: ProgressTask[] = [
    { id: "a", label: "chain one", completed: 25, total: 100, rate: 2, etaSeconds: 30, state: "running", stats: { Divergences: "3", "Step size": "0.01" } },
    { id: "b", label: "chain two", state: "running", elapsedSeconds: 12, stats: { custom: "retained" } },
    { id: "c", label: "percent only", state: "running", stats: { percent: "50" } },
  ];
  const warning = vi.fn((_: string, value: string) => value);
  const rows = progressRows(tasks, 24, { ...theme, fg: warning }, 0);
  const text = rows.map(r => r.text).join("\n");
  expect(new Set(rows.map(r => r.progress?.id))).toEqual(new Set(["a", "b", "c"]));
  for (const value of ["25/100", "25%", "2/s", "ETA 30s", "12s elapsed", "Divergences: 3", "Step size: 0.01", "custom: retained", "50%"]) expect(text.replace(/\s+/gu, " ")).toContain(value);
  expect(warning).toHaveBeenCalledWith("warning", "Divergences: 3");
  expect(rows.every(r => visibleWidth(r.text) <= 24)).toBe(true);
  expect(rows.find(r => r.text.startsWith("["))!.text).toBe(`[${"━".repeat(6)}${"─".repeat(16)}]`);
  expect(progressRows([{ ...tasks[0]!, completed: 120 }], 80, theme, 0).map(r => r.text).join("\n")).toContain("120/100 · 100%");
});

test("STEP3 diagnostic modes and output are independent; source and active progress always remain", () => {
  const f = nbWith([{ id: "a", code: "source_visible = 1" }]);
  const cell = f.notebook.cells.get("a")!;
  cell.error = "explicit_failure";
  cell.console = [
    { stream: "stdout", severity: "output", text: "printed_result" },
    { stream: "stderr", severity: "warning", text: "warning_record" },
    { stream: "stdout", severity: "error", text: "error_record" },
    { stream: "stderr", severity: "progress", text: "raw_progress_hidden" },
  ];
  cell.output = { kind: "text", text: "result_value" };
  cell.progress = [{ id: "p", label: "active_progress", completed: 1, total: 10, state: "running", stats: {} }];
  for (const diagnostics of ["all", "errors", "warnings", "none"] as const) for (const showOutput of [true, false]) {
    const text = detailRows(f.notebook, theme, 0, { cell, width: 80, section: false, diff: false, codeOpen: true, diagnostics, showOutput }).rows.map(r => r.text).join("\n");
    expect(text.includes("explicit_failure")).toBe(["all", "errors"].includes(diagnostics));
    expect(text.includes("error_record")).toBe(["all", "errors"].includes(diagnostics));
    expect(text.includes("warning_record")).toBe(["all", "warnings"].includes(diagnostics));
    expect(text.includes("printed_result")).toBe(showOutput);
    expect(text.includes("result_value")).toBe(showOutput);
    expect(text).not.toContain("raw_progress_hidden");
    expect(text).toContain("source_visible");
    expect(text).toContain("active_progress");
  }
  cell.code = 'mo.md("literal prose remains")';
  const text = detailRows(f.notebook, theme, 0, { cell, width: 80, section: true, diff: false, codeOpen: true, diagnostics: "none", showOutput: false }).rows.map(r => r.text).join("\n");
  expect(text).toContain("literal prose remains");
  expect(text).toContain("active_progress");
});

test("STEP3 visibility keys release hidden controls to source and transfer preferences", () => {
  const f = nbWith([{ id: "a", code: "source_visible = 1" }]);
  const v = make(f);
  try {
    screen(v);
    (v as any).widget = { cell: "a", index: 0, sub: 0 };
    (v as any).table = { cell: "a", objectId: "t" };
    v.handleInput("\\");
    screen(v);
    expect((v as any).widget).toBeUndefined();
    expect((v as any).table).toBeUndefined();
    expect((v as any).lastParts[(v as any).part]?.kind).toBe("code");
    v.handleInput("!");
    expect(v.snapshot().preferences).toMatchObject({ showOutput: false, diagnostics: "errors" });
    const restored = make(f, { initial: v.snapshot() });
    try { expect(restored.snapshot().preferences).toMatchObject({ showOutput: false, diagnostics: "errors" }); } finally { restored.dispose(); }
    v.handleInput("!"); v.handleInput("!");
    expect(screen(v)).toContain("diagnostics hidden");
    v.handleInput("!");
    expect(v.snapshot().preferences?.diagnostics).toBe("all");
  } finally { v.dispose(); }
});

test("STEP3 T shows exact local timezone start/end and duration without inventing missing times", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const v = make(f);
  try {
    screen(v); v.handleInput("T");
    expect(screen(v)).toContain("Start: unknown");
    v.handleInput("T");
    Object.assign(f.notebook.cells.get("a")!, { lastRunStartedAt: 1_000, lastRunEndedAt: 2_000, lastRunMs: 1_000 });
    v.handleInput("T");
    const text = screen(v);
    expect(text).toContain("Exact timing");
    expect(text).toMatch(/GMT[+-]\d\d:\d\d/u);
    expect(text).toContain("Duration: 1.0s");
    expect(text).not.toContain("Start: unknown");
  } finally { v.dispose(); }
});

// --- Notebook command palette: registry actions through the existing input and safety gates ---
const paletteSearch = (v: NotebookView, query: string) => {
  v.handleInput("\x10");
  for (const ch of query) v.handleInput(ch);
};

test("palette fuzzy search holds notebook focus and runs only the chosen command", () => {
  const f = dataflow(); const run = vi.fn(async () => {}); const v = make(f, { run });
  try {
    screen(v); const before = v.snapshot();
    paletteSearch(v, "run cell");
    expect(v[INPUT_CONTEXT]()).toBe("filter");
    expect(v.snapshot().palette?.query).toBe("run cell");
    expect(screen(v)).toContain("Command palette");
    expect(v.snapshot().cursor).toBe(before.cursor);
    expect(v.render(100).join("\n")).toContain("› run cell");
    expect(run).not.toHaveBeenCalled();
    v.handleInput("\r");
    expect(v.snapshot().palette).toBeUndefined();
    expect(run).toHaveBeenCalledExactlyOnceWith(f, [{ id: "a", code: "x = 1" }]);
    paletteSearch(v, "no-matches-unique");
    v.handleInput("\r");
    expect(v.snapshot().palette).toBeDefined();
    expect(run).toHaveBeenCalledTimes(1);
    v.handleInput("\x1b");
    expect(v.snapshot().palette).toBeUndefined();
  } finally { v.dispose(); }
});

test("palette selection keeps two-press run-all, stop and interrupt gates, and F8 suspends the palette", () => {
  const f = dataflow(); const run = vi.fn(async () => {}), interrupt = vi.fn(async () => {}), stopServers = vi.fn(() => 1);
  const v = make(f, { run, interrupt, stopServers, servers: () => ["marimo nb.py"] });
  try {
    screen(v);
    paletteSearch(v, "run all"); v.handleInput("\r");
    expect(run).not.toHaveBeenCalled();
    expect(screen(v)).toContain("A again to run all cells");
    paletteSearch(v, "stop server"); v.handleInput("\r");
    expect(stopServers).not.toHaveBeenCalled();
    expect(screen(v)).toContain("S again to stop the server");
    paletteSearch(v, "variables");
    v.handleInput("\x1b[19~");
    expect(screen(v)).toContain("message");
    v.handleInput("\x1b");
    expect(v.snapshot().palette?.query).toBe("variables");
    v.handleInput("\x1b");
    expect(v.snapshot().palette).toBeUndefined();
    f.notebook.apply("cell-op", { cell_id: "a", status: "running" });
    paletteSearch(v, "interrupt"); v.handleInput("\r");
    expect(interrupt).not.toHaveBeenCalled();
    expect(screen(v)).toContain("x again to interrupt");
    v.handleInput("x");
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(f);
  } finally { v.dispose(); }
});

test("palette works in Variables and Packages, while package mutations still request confirmation", async () => {
  const f = dataflow();
  const fingerprint = { filename: "/w/nb.py", executable: "/env/python", pid: 42, manager: "uv", version: "0.25.0", capabilities: {} };
  const question: PackageConfirmation = { action: "remove", spec: "numpy", fingerprint, warning: "Shared environment", defaultChoice: "cancel" };
  const confirm = vi.fn(async () => "Cancel");
  const mutate = vi.fn(async (_action, _spec, approve) => ({ status: await approve(question) ? "succeeded" : "cancelled" }));
  const client = { reconcile: async () => ({ fingerprint, packages: [{ name: "numpy", version: "1" }] }), mutate } as unknown as PackageClient;
  const v = make(f, { packages: async () => client, confirm });
  try {
    screen(v); v.handleInput("v"); screen(v);
    paletteSearch(v, "sort");
    expect(v.snapshot().palette?.mode).toBe("variables");
    v.handleInput("\r");
    expect(v.snapshot().varSort).not.toBe("name");
    v.handleInput("P"); await editorReady(); await editorReady(); screen(v);
    paletteSearch(v, "remove");
    expect(v.snapshot().palette?.mode).toBe("packages");
    expect(mutate).not.toHaveBeenCalled();
    v.handleInput("\r"); await editorReady(); await editorReady();
    expect(mutate).toHaveBeenCalledExactlyOnceWith("remove", "numpy", expect.any(Function));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("/env/python"), ["Cancel", "Confirm"]);
  } finally { v.dispose(); }
});

test("table palette exposes sorting but not unsupervised CSV export", () => {
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", output: { channel: "output", mimetype: "text/html", data: tableHtml() } });
  const call = vi.fn(async () => ({}));
  const v = make(f, { table: { call, file: async () => "[]" } });
  try {
    v.render(100); v.handleInput("t"); v.render(100);
    paletteSearch(v, "sort column");
    expect(v.snapshot().palette?.mode).toBe("table");
    expect(v.render(100).join("\n")).toContain("› sort column");
    v.handleInput("\r");
    expect(v.snapshot().palette).toBeUndefined();
    expect(v.snapshot().table).toBeDefined();
    expect(call).toHaveBeenCalled();
  } finally { v.dispose(); }
});

test("palette does not steal literal filters, Neovim, or the docked prompt", async () => {
  const f = dataflow(); const fake = fakeEditors(); const v = make(f, { editors: fake.editors, ask: vi.fn() });
  try {
    screen(v);
    v.handleInput("/"); v.handleInput("\x10");
    expect(v.snapshot().palette).toBeUndefined();
    v.handleInput("\x1b");
    v.handleInput("a"); v.handleInput("\x10");
    expect(v.snapshot().palette).toBeUndefined();
    v.handleInput("\x1b");
    v.handleInput("b"); await editorReady();
    fake.session.input.mockClear();
    v.handleInput("\x10");
    expect(v.snapshot().palette).toBeUndefined();
    expect(fake.session.input).toHaveBeenCalledWith("\x10");
  } finally { v.dispose(); fake.editors.dispose(); }
});

test("palette snapshot, focused dock and mouse click select a command without leaking into widgets", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: widgetHtml } });
  const setWidget = vi.fn();
  const actions = { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, setWidget, docked: { focused: () => true, focusMain: () => {} } };
  const localTui = { requestRender: vi.fn(), terminal: { rows: 28 } };
  const v = new NotebookView(localTui as any, theme, notebookKey(f), actions, () => {});
  let moved: NotebookView | undefined;
  try {
    v.render(100); v.handleInput("w"); v.render(100);
    paletteSearch(v, "diagnostics");
    const saved = v.snapshot();
    moved = new NotebookView(localTui as any, theme, notebookKey(f), { ...actions, initial: saved }, () => {});
    const lines = moved.render(100);
    expect(lines.join("\n")).toContain("Command palette");
    expect(moved.snapshot().palette).toEqual(saved.palette);
    const click = (type: string, x = 3, y = 3) => moved!.handleMouse(helpMouse(type, { x, y, width: 100, height: 28 }));
    expect(click("press")).toEqual({ handled: true, render: false });
    click("wheel"); moved.render(100);
    click("click");
    expect(moved.snapshot().palette).toBeUndefined();
    expect(setWidget).not.toHaveBeenCalled();
  } finally { v.dispose(); moved?.dispose(); }
});

// --- STEP6: compact contextual chrome and modal, searchable registry help ---
test("STEP6 package help cannot refresh, mutate, confirm, or change the selected package", async () => {
  const f = dataflow();
  const reconcile = vi.fn(async () => ({
    fingerprint: { filename: "/w/nb.py", executable: "/env/python", pid: 42, manager: "uv", version: "0.25.0", capabilities: {} },
    packages: [{ name: "numpy", version: "1" }, { name: "pandas", version: "2" }],
  }));
  const mutate = vi.fn(), dependencyTree = vi.fn(), confirm = vi.fn();
  const v = make(f, { packages: async () => ({ reconcile, mutate, dependencyTree }) as unknown as PackageClient, confirm });
  try {
    v.handleInput("P"); await editorReady(); await editorReady(); screen(v);
    const before = v.snapshot(); reconcile.mockClear(); v.handleInput("?");
    for (const key of ["j", "G", "\t", "a", "u", "x", "r", "\r", "P"]) v.handleInput(key);
    for (const spy of [reconcile, mutate, dependencyTree, confirm]) expect(spy).not.toHaveBeenCalled();
    expect(v.snapshot().help).toBeDefined();
    v.handleInput("?"); expect(v.snapshot()).toMatchObject(before);
  } finally { v.dispose(); }
});

test.each(["", "v", "P"])("STEP6 %s filter keeps ? literal and owns input ahead of help", key => {
  const f = dataflow(); const v = make(f);
  try {
    screen(v); if (key) v.handleInput(key);
    v.handleInput("/"); press(v, "value?");
    const state = v.snapshot();
    expect(key === "v" ? state.varFilter : key === "P" ? state.packagePane?.filter : state.filter).toBe("value?");
    expect(state.help).toBeUndefined(); expect(v[INPUT_CONTEXT]()).toBe("filter");
    v.handleInput("\x1b"); expect(v.snapshot().help).toBeUndefined();
  } finally { v.dispose(); }
});

test.each([46, 80, 100, 120, 180].flatMap(width => ["t", "w"].map(key => ({ width, key }))))(
  "STEP6 $key footer and help fit a 12-row terminal at $width columns", ({ width, key }) => {
    const f = nbWith([{ id: "a", code: "value" }]);
    f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: key === "t" ? tableHtml() : widgetHtml } });
    const v = new NotebookView(shortTui() as any, theme, notebookKey(f), {
      followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, setWidget: vi.fn(),
      table: { call: vi.fn(async () => ({})), file: async () => "[]" },
    }, () => {});
    try {
      v.render(width); v.handleInput(key);
      const lines = v.render(width);
      expect(lines).toHaveLength(12);
      expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
      expect(footerText(lines)).toBe(key === "t" ? width === 46 ? "enter row detail · ? help · ! diagnostics" : "enter row detail · ? help · ! diagnostics · \\ output · ctrl+p command palette" : width === 46 ? "Tab next · ←/→ adjust · Enter value" : "Tab next · ←/→ adjust · Enter value · Esc done");
      v.handleInput("?");
      const help = v.render(width);
      expect(help).toHaveLength(12);
      expect(help.every(line => visibleWidth(line) === width)).toBe(true);
      expect(help.join("\n")).toContain("Keyboard shortcuts");
      expect(help.join("\n").match(/Keyboard shortcuts/gu)).toHaveLength(1);
      expect(footerText(help)).toContain("Tab categories · / search · Esc back");
      if (width >= 80) expect(footerText(help)).toContain("j/k scroll");
    } finally { v.dispose(); }
  },
);
const shortTui = () => ({ requestRender: vi.fn(), terminal: { rows: 12 } });
const footerText = (lines: string[]) => plain(lines.at(-1)!).trim();
const helpMouse = (type: string, extra = {}) => ({
  type, button: type === "wheel" ? "none" : "left", x: 6, y: 5,
  screenX: 6, screenY: 5, width: 80, height: 12,
  shift: false, alt: false, ctrl: false, ...extra,
}) as any;

test.each([46, 80, 100, 120, 180])("STEP6 12-row terminal has a whole-token, single-line footer at %i columns", width => {
  const f = dataflow();
  const v = new NotebookView(shortTui() as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, run: vi.fn(),
  }, () => {});
  try {
    for (const [key, action, position] of [
      ["", "r run cell", "1/3"], ["v", "enter detail", ""],
      ["\x1b", "r run cell", "1/3"], ["P", "enter dependency tree", ""],
    ]) {
      if (key) v.handleInput(key!);
      const lines = v.render(width);
      expect(lines).toHaveLength(12);
      expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
      const footer = footerText(lines);
      const tokens = footer.split(" · ");
      expect(tokens.slice(0, 2)).toEqual([action, "? help"]);
      if (position) {
        expect(tokens).toContain("O cell");
        expect(tokens).toContain(position);
      } else expect(footer).not.toMatch(/O (cell|section)/u);
      expect(tokens).not.toContain("# lines on");
      expect(footer).not.toMatch(/[…\n]|\.\.\./u);
      expect(lines.filter(line => plain(line).includes("? help"))).toHaveLength(1);
    }
  } finally { v.dispose(); }
});

test("footer immediately elevates hidden diagnostics and output while keeping contextual action and whole toggles", () => {
  const f = dataflow();
  const v = new NotebookView(shortTui() as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, run: vi.fn(),
  }, () => {});
  try {
    const foot = (width = 120) => footerText(v.render(width));
    expect(foot()).toBe("r run cell · ? help · O cell · 1/3 · ! diagnostics · \\ output · # lines · ctrl+p command palette");
    v.handleInput("!");
    expect(foot()).toBe("r run cell · ? help · ! errors · O cell · 1/3 · \\ output · # lines · ctrl+p command palette");
    expect(v.render(120).join("\n")).toContain("diagnostics errors");
    v.handleInput("\\");
    expect(foot()).toBe("r run cell · ? help · ! errors · \\ output off · O cell · 1/3 · # lines · ctrl+p command palette");
    expect(v.render(120).join("\n")).toContain("output hidden");
    v.handleInput("#");
    expect(foot()).toContain("# lines on");
    v.handleInput("O");
    expect(foot()).toContain("O section");
    f.notebook.apply("cell-op", { cell_id: "a", status: "running", timestamp: Date.now() / 1000 });
    expect(foot()).toMatch(/^x interrupt · \? help · ! errors · \\ output off/u);
    const narrow = foot(46);
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(44);
    expect(narrow).not.toMatch(/…|\.\.\./u);
    expect(narrow).toContain("! errors");
    v.handleInput("!");
    expect(foot()).toContain("! warnings");
    v.handleInput("!");
    expect(foot()).toContain("! hidden");
    v.handleInput("!");
    expect(foot()).toContain("! diagnostics");
    expect(foot()).not.toContain("! hidden");
  } finally {
    if (v.snapshot().section) v.handleInput("O"); // Restore the shared view preference.
    v.dispose();
  }
});

test("notebook footer names the current reading view and disappears outside notebook mode", () => {
  const v = make(dataflow());
  try {
    expect(footerText(v.render(100))).toContain("O cell");
    v.handleInput("O");
    expect(footerText(v.render(100))).toContain("O section");
    v.handleInput("v");
    expect(footerText(v.render(100))).not.toMatch(/O (cell|section)/u);
  } finally { v.dispose(); }
});

test.each([
  ["v", "Variables"], ["P", "Packages"], ["t", "Tables"], ["w", "Widgets"],
])("STEP6 help opens in the %s mode category and restores its underlying mode", async (key, group) => {
  const f = dataflow();
  const html = key === "t" ? tableHtml() : widgetHtml;
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: html } });
  const v = make(f, { table: { call: vi.fn(async () => ({})), file: async () => "[]" }, setWidget: vi.fn() });
  let moved: NotebookView | undefined;
  try {
    screen(v); v.handleInput(key); screen(v);
    const before = v.snapshot();
    if (key === "t") expect(before.table).toMatchObject({ cell: "a", objectId: "t-0" });
    if (key === "w") expect(before.widget).toMatchObject({ cell: "a", index: 0 });
    v.handleInput("?");
    expect(v.snapshot().help).toEqual({ group, query: "", typing: false, scroll: 0 });
    expect(screen(v)).toContain("Keyboard shortcuts");
    moved = make(f, { initial: v.snapshot() });
    expect(screen(moved)).toContain("Keyboard shortcuts");
    moved.handleInput("?"); screen(moved);
    expect(moved.snapshot()).toMatchObject(before);
  } finally { v.dispose(); moved?.dispose(); }
});

test("help navigation moves categories in a fitted tall pane and scrolls in a short pane without moving the cell cursor", () => {
  const f = followed();
  const tui = { requestRender: vi.fn(), terminal: { rows: 90 } };
  const v = new NotebookView(tui as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {},
  }, () => {});
  try {
    v.render(120);
    const before = v.snapshot().cursor;
    v.handleInput("?"); v.render(120);
    expect(v.snapshot().help).toMatchObject({ group: "Navigation", scroll: 0 });
    v.handleInput("j"); v.render(120);
    expect(v.snapshot().help).toMatchObject({ group: "Display", scroll: 0 });
    v.handleInput("\x1b[B"); v.render(120);
    expect(v.snapshot().help?.group).toBe("Execution");
    v.handleInput("k"); v.render(120);
    expect(v.snapshot().help?.group).toBe("Display");
    v.handleInput("\x1b[A"); v.render(120);
    expect(v.snapshot().help?.group).toBe("Navigation");
    expect(v.snapshot().cursor).toBe(before);
    v.handleInput("?");
    expect(v.snapshot().help).toBeUndefined();
    expect(v.snapshot().cursor).toBe(before);
    tui.terminal.rows = 12;
    v.handleInput("?"); v.render(46);
    v.handleInput("j");
    expect(v.snapshot().help).toMatchObject({ group: "Navigation", scroll: 1 });
    expect(v.snapshot().cursor).toBe(before);
  } finally { v.dispose(); }
});

test("help reopens at its last category and scroll after closing or moving the view", () => {
  const f = followed();
  const actions = { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} };
  const v = new NotebookView(shortTui() as any, theme, notebookKey(f), actions, () => {});
  let moved: NotebookView | undefined;
  try {
    v.render(46); v.handleInput("?"); v.render(46);
    v.handleInput("\t"); v.render(46);
    v.handleInput("j");
    expect(v.snapshot().help).toMatchObject({ group: "Display", scroll: 1 });
    v.handleInput("?");
    expect(v.snapshot()).toMatchObject({ lastHelp: { group: "Display", query: "", typing: false, scroll: 1 } });
    v.handleInput("v"); v.handleInput("?"); v.render(46);
    expect(v.snapshot().help).toMatchObject({ group: "Display", scroll: 1 });
    v.handleInput("?");
    moved = new NotebookView(shortTui() as any, theme, notebookKey(f), { ...actions, initial: v.snapshot() }, () => {});
    moved.render(46); moved.handleInput("?"); moved.render(46);
    expect(moved.snapshot().help).toMatchObject({ group: "Display", scroll: 1 });
  } finally { v.dispose(); moved?.dispose(); }
});

test("help rail clicks select categories without changing the notebook; closing help exposes Variables and Packages", () => {
  const f = followed();
  const tui = { requestRender: vi.fn(), terminal: { rows: 90 } };
  const v = new NotebookView(tui as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {},
  }, () => {});
  try {
    v.render(120);
    const before = v.snapshot();
    v.handleInput("?"); v.render(120);
    const click = (x: number, y: number, type = "click") => v.handleMouse(helpMouse(type, { x, y, screenX: x, screenY: y, width: 120, height: 90 }));
    expect(click(2, 4, "press")).toEqual({ handled: true, render: false });
    expect(click(2, 4)).toEqual({ handled: true }); // Display is the second rail row.
    expect(v.snapshot().help?.group).toBe("Display");
    expect(v.render(120).join("\n")).toContain("fold code");
    const selected = v.snapshot().help;
    click(40, 4); // Command text is not a category.
    click(0, 4); // Frame padding is not a category.
    click(2, 1); // Heading is not a category.
    expect(v.snapshot().help).toEqual(selected);
    click(2, 8); // Packages is the sixth rail row.
    expect(v.snapshot().help?.group).toBe("Packages");
    expect(tui.requestRender).toHaveBeenCalled();
    expect(v.snapshot().cursor).toBe(before.cursor);
    v.handleInput("?");
    expect(v.snapshot()).toMatchObject(before);
    v.handleInput("v"); expect(v.snapshot().mode).toBe("variables");
    v.handleInput("P"); expect(v.snapshot().mode).toBe("packages");
  } finally { v.dispose(); }
});

test("STEP6 help scrolls, cycles categories both ways, searches globally and Escape clears before closing", () => {
  const f = followed();
  const v = new NotebookView(shortTui() as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {},
  }, () => {});
  let moved: NotebookView | undefined;
  try {
    v.render(46); v.handleInput("?"); v.render(46);
    v.handleInput("j"); expect(v.snapshot().help?.scroll).toBe(1);
    v.handleInput("\x1b[6~"); expect(v.snapshot().help!.scroll).toBeGreaterThan(1);
    v.render(46); v.handleInput("g"); expect(v.snapshot().help?.scroll).toBe(0);
    v.handleInput("G"); v.render(46); expect(v.snapshot().help!.scroll).toBeGreaterThan(0);
    v.handleInput("\t");
    expect(v.snapshot().help).toMatchObject({ group: "Display", scroll: 0 });
    v.handleInput("\x1b[Z"); expect(v.snapshot().help?.group).toBe("Navigation");
    v.handleInput("\x1b[Z"); expect(v.snapshot().help?.group).toBe("Dock/Mouse");
    v.handleInput("/"); press(v, "scroll"); v.handleInput("\r"); v.render(46);
    expect(v.snapshot().help).toMatchObject({ group: "Dock/Mouse", query: "scroll", typing: false });
    expect(v.render(46).join("\n")).toContain("Search: scroll");
    v.handleInput("j"); v.render(46);
    expect(v.snapshot().help!.scroll).toBeGreaterThan(0);
    const saved = v.snapshot();
    moved = new NotebookView(shortTui() as any, theme, notebookKey(f), {
      followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, initial: saved,
    }, () => {});
    expect(moved.render(46)).toEqual(v.render(46));
    expect(moved.snapshot().help).toEqual(saved.help);
    moved.handleInput("\x1b");
    expect(moved.snapshot().help).toEqual({ group: "Dock/Mouse", query: "", typing: false, scroll: 0 });
    moved.handleInput("/"); press(moved, "unfindable-command-needle");
    expect(moved.render(46).join("\n")).toContain("No matching commands");
    expect(moved[INPUT_CONTEXT]()).toBe("filter");
    moved.handleInput("\x1b"); expect(moved[INPUT_CONTEXT]()).toBe("viewer");
    expect(moved.snapshot().help).toBeDefined();
    moved.handleInput("\x1b"); expect(moved.snapshot().help).toBeUndefined();
  } finally { v.dispose(); moved?.dispose(); }
});

test("STEP6 ? is literal while searching help; typing state transfers and ordinary keys never dismiss help", () => {
  const f = dataflow();
  const v = make(f);
  let moved: NotebookView | undefined;
  try {
    screen(v); const before = v.snapshot();
    v.handleInput("?"); v.handleInput("/"); press(v, "save?");
    expect(v.snapshot().help).toMatchObject({ query: "save?", typing: true });
    moved = make(f, { initial: v.snapshot() }); screen(moved);
    expect(moved[INPUT_CONTEXT]()).toBe("filter");
    moved.handleInput("\x7f"); expect(moved.snapshot().help?.query).toBe("save");
    moved.handleInput("\r");
    for (const key of ["q", "a", "r", "x", "v", "P", "t", "w", "o", "!", "\\", "|", "\x03", "\r"]) {
      moved.handleInput(key);
      expect(moved.snapshot().help).toBeDefined();
    }
    expect(moved.snapshot().cursor).toBe(before.cursor);
    moved.handleInput("?");
    expect(moved.snapshot()).toMatchObject(before);
  } finally { v.dispose(); moved?.dispose(); }
});

test("STEP6 help blocks notebook mutations, navigation and mouse activation", () => {
  const f = dataflow(); busy(f);
  const run = vi.fn(), interrupt = vi.fn(), stopServers = vi.fn(), openInBrowser = vi.fn(), ask = vi.fn(), dock = vi.fn();
  const v = make(f, { run, interrupt, stopServers, servers: () => ["server"], openInBrowser, ask, dock });
  try {
    screen(v); const before = v.snapshot(); v.handleInput("?"); screen(v);
    for (const key of ["j", "G", "]", "}", "r", "R", "R", "A", "A", "x", "x", "S", "S", "o", "a", "m", "M", "M", "!", "\\", "|", "q"]) v.handleInput(key);
    for (const type of ["press", "click", "drag", "release"]) v.handleMouse(helpMouse(type, { clickCount: 2 }));
    expect(v.snapshot().help).toBeDefined();
    for (const spy of [run, interrupt, stopServers, openInBrowser, ask, dock]) expect(spy).not.toHaveBeenCalled();
    v.handleInput("?"); expect(v.snapshot()).toMatchObject(before);
  } finally { v.dispose(); }
});

test.each(["t", "w"])("STEP6 %s help prevents table/widget mutations and navigation from leaking", key => {
  const f = nbWith([{ id: "a", code: "value" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: key === "t" ? tableHtml() : widgetHtml } });
  const call = vi.fn(async () => ({})), setWidget = vi.fn(), setTableSelection = vi.fn();
  const v = make(f, { table: { call, file: async () => "[]" }, setWidget, setTableSelection });
  try {
    screen(v); v.handleInput(key); screen(v); const before = v.snapshot(); call.mockClear();
    v.handleInput("?"); screen(v);
    for (const data of ["j", "l", " ", "s", "S", "]", "+", "x", "r", "\r"]) v.handleInput(data);
    v.handleMouse(helpMouse("click")); v.handleMouse(helpMouse("wheel", { wheelDelta: 1 }));
    expect(call).not.toHaveBeenCalled(); expect(setWidget).not.toHaveBeenCalled(); expect(setTableSelection).not.toHaveBeenCalled();
    v.handleInput("?"); expect(v.snapshot()).toMatchObject(before);
  } finally { v.dispose(); }
});

test("STEP6 editor F1 opens Editing help; wheel scrolls help, native punctuation resumes after close", async () => {
  const f = dataflow(); const fake = fakeEditors(); const terminal = shortTui();
  const v = new NotebookView(terminal as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, editors: fake.editors,
  }, () => {});
  try {
    v.render(46); v.handleInput("b"); await editorReady(); v.render(46);
    fake.draft("x = 2");
    expect(plain(v.render(46)[1]!)).toContain("Neovim · python · unsaved");
    v.handleInput("\x1bOP");
    expect(v.snapshot().help).toMatchObject({ group: "Editing" });
    expect(v[INPUT_CONTEXT]()).toBe("viewer"); v.render(46);
    fake.session.input.mockClear();
    const before = v.snapshot();
    v.handleMouse(helpMouse("wheel", { width: 46, wheelDelta: 2 }));
    expect(v.snapshot().help?.scroll).toBe(2);
    v.handleMouse(helpMouse("wheel", { width: 46, wheelDelta: -1 }));
    expect(v.snapshot().help?.scroll).toBe(1);
    v.handleInput("x"); v.handleInput("\r");
    expect(fake.session.input).not.toHaveBeenCalled();
    expect(fake.editors.state).toMatchObject({ draft: "x = 2", dirty: true });
    expect(v.snapshot().cursor).toBe(before.cursor);
    v.handleInput("?"); expect(v[INPUT_CONTEXT]()).toBe("editor");
    // A 12-row stacked view is deliberately too small for native input; grow it first.
    terminal.terminal.rows = 28; v.render(100);
    for (const key of ["?", "/", "!", "\\", "#", ":", "\t", "\x1b"]) v.handleInput(key);
    expect(fake.session.input.mock.calls.map(([data]) => data)).toEqual(["?", "/", "!", "\\", "#", ":", "\t", "\x1b"]);
    expect(v.snapshot().help).toBeUndefined();
    expect(footerText(v.render(46))).toBe("f2 save · f1 help");
  } finally { v.dispose(); fake.editors.dispose(); }
});

test("STEP6 focused prompt retains its hint and literal ? rather than opening help", () => {
  const f = dataflow(); const ask = vi.fn(); const v = make(f, { ask });
  try {
    v.handleInput("a"); press(v, "why?");
    const lines = v.render(80);
    expect(lines.join("\n")).toContain("enter send · esc cancel");
    expect(footerText(lines)).toBe("esc closes the prompt");
    expect(lines.join("\n")).toContain("why?");
    expect(v.snapshot().help).toBeUndefined(); expect(v[INPUT_CONTEXT]()).toBe("editor");
    v.handleInput("\r"); expect(ask).toHaveBeenCalledWith(f, expect.anything(), "why?");
  } finally { v.dispose(); }
});

test.each([46, 80, 100, 120, 180])("STEP6 bounded errors disclose a complete captured message (%i columns)", async width => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const reason = "kernel refused because " + "environment dependency mismatch ".repeat(4) + "FINAL_ERROR_TOKEN";
  const v = new NotebookView(shortTui() as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, run: async () => { throw new Error(reason); },
  }, () => {});
  try {
    const before = footerText(v.render(width)); v.handleInput("r"); await editorReady();
    const lines = v.render(width);
    expect(lines.length).toBe(12);
    expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
    expect(footerText(lines)).toBe(before);
    const messageRows = lines.slice(0, -1).map(line => plain(line).trim());
    if (width === 46) expect(messageRows.join(" ")).toContain("F8 more");
    else expect(messageRows.join(" ")).toContain("FINAL_ERROR_TOKEN");
    v.handleInput("\x1b[19~"); v.render(width); v.handleInput("G");
    expect(v.render(width).join("\n")).toContain("FINAL_ERROR_TOKEN");
    v.handleInput("\x1b");
    expect(footerText(lines)).not.toContain("kernel");
    v.handleInput("A");
    const armed = v.render(width);
    expect(armed.at(-2)).toContain("A again to run all cells");
    expect(footerText(armed)).toBe(before);
  } finally { v.dispose(); }
});

test("F8 message viewer takes precedence over help, scrolls, and restores help", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const tui = { requestRender: vi.fn(), terminal: { rows: 4 } };
  const v = new NotebookView(tui as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, run: vi.fn(),
  }, () => {});
  try {
    v.render(12);
    v.handleInput("A");
    v.handleInput("?");
    expect(screen(v, 12)).toContain("Keyboard");
    v.handleInput("\x1b[19~");
    expect(v.snapshot().message?.text).toContain("again to run all cells");
    (v as any).messageView.state.text += "\n" + "extra line\n".repeat(5);
    expect(screen(v, 12)).not.toContain("Keyboard shortcuts");
    expect(screen(v, 12)).toContain("again");
    v.handleInput("j");
    expect(v.snapshot().message?.scroll).toBeGreaterThan(0);
    tui.terminal.rows = 2;
    expect(screen(v, 12)).not.toContain("Keyboard shortcuts");
    v.handleInput("\x1b");
    tui.terminal.rows = 5;
    expect(screen(v, 12)).toContain("Keyboard");
    expect(v.snapshot().help).toBeDefined();
  } finally { v.dispose(); }
});

test("help retains the underlying mode and filter without repeating their header", () => {
  const f = dataflow(); const v = make(f);
  try {
    v.handleInput("/"); press(v, "load");
    expect(plain(v.render(120)[1]!)).toContain("notebook · load");
    // A restored, retained filter can exist without an active text owner.
    const moved = make(f, { initial: { ...v.snapshot(), typing: false } });
    try {
      moved.handleInput("?");
      expect(plain(moved.render(120)[1]!).trim()).toBe("Keyboard shortcuts");
      expect(moved.snapshot().filter).toBe("load");
    } finally { moved.dispose(); }
    v.handleInput("\x1b"); v.handleInput("v");
    expect(plain(v.render(120)[1]!)).toContain("variables");
  } finally { v.dispose(); }
});

test.each(["", "v", "P"])("STEP6 active %s search input survives transfer", key => {
  const f = dataflow(); const v = make(f);
  try {
    v.render(80);
    if (key) v.handleInput(key);
    v.handleInput("/"); press(v, "load");
    const moved = make(f, { initial: v.snapshot() });
    try {
      expect(moved[INPUT_CONTEXT]()).toBe("filter");
      moved.handleInput("?");
      expect(moved.snapshot().help).toBeUndefined();
      const state = moved.snapshot();
      expect(key === "P" ? state.packagePane?.filter : key === "v" ? state.varFilter : state.filter).toBe("load?");
    } finally { moved.dispose(); }
  } finally { v.dispose(); }
});

test("STEP6 help supersedes timing and survives removal of the followed notebook", () => {
  const f = dataflow(); let follows = [f];
  const v = make(f, { followed: () => follows });
  try {
    v.render(80); v.handleInput("T");
    expect(screen(v)).toContain("Exact timing");
    v.handleInput("?");
    expect(screen(v)).toContain("Keyboard shortcuts");
    follows = [];
    expect(screen(v)).toContain("Keyboard shortcuts");
    v.handleInput("?");
    expect(screen(v)).not.toContain("Keyboard shortcuts");
  } finally { v.dispose(); }
});

test("STEP6 unregistered notebook keys disarm two-press destructive commands", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const run = vi.fn(async () => {});
  const v = make(f, { run });
  try {
    v.render(80);
    v.handleInput("A");
    expect(v.render(80).join("\n")).toContain("A again to run all cells");
    v.handleInput("unbound-key");
    expect(v.render(80).join("\n")).not.toContain("A again to run all cells");
    v.handleInput("A");
    expect(run).not.toHaveBeenCalled();
    v.handleInput("A");
    expect(run).toHaveBeenCalledOnce();
  } finally { v.dispose(); }
});

test.each([0, 1, 3, 5, 6, 7, 10, 12, 20])("STEP6 many-screen transient is bounded at height %i and its captured tail stays reachable", height => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const terminal = { requestRender: vi.fn(), terminal: { rows: height } };
  const run = vi.fn();
  const note = Array.from({ length: 150 }, (_, i) => `message line ${i}`).join("\n") + "\nFINAL_TAIL";
  const v = new NotebookView(terminal as any, theme, notebookKey(f), {
    followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, run,
  }, () => {});
  try {
    (v as any).note = note;
    const lines = v.render(46);
    expect(lines.length).toBeLessThanOrEqual(height);
    expect((v as any).lastTransient).toBe(Math.min(3, Math.max(0, height - 7)));
    if (height >= 10) expect((v as any).lastPage).toBeGreaterThanOrEqual(4);
    if (height >= 2 && height <= 7) expect(lines.join("\n")).toContain("F8 message");
    terminal.terminal.rows = 12;
    v.render(46); v.handleInput("\x1b[19~");
    (v as any).note = "new asynchronous notice";
    v.render(46); v.handleInput("G");
    expect(v.render(46).join("\n")).toContain("FINAL_TAIL");
    const captured = v.snapshot();
    expect(captured.message?.text).not.toContain("asynchronous");
    for (const key of ["r", "A", "x", "b", "?", "/", "\\", "!"]) v.handleInput(key);
    expect(run).not.toHaveBeenCalled();
    expect(v.snapshot().help).toBeUndefined();
    terminal.terminal.rows = 200;
    v.render(46);
    expect(v.snapshot().message?.scroll).toBe(0);
    v.handleInput("\x1b");
    expect(v.render(46).join("\n")).toContain("new asynchronous notice");
  } finally { v.dispose(); }
});

test("STEP6 message mode suspends Neovim and restores a captured snapshot without input leakage", async () => {
  const f = dataflow(); const fake = fakeEditors(); const v = make(f, { editors: fake.editors });
  try {
    v.render(80); v.handleInput("b"); await editorReady(); fake.draft("draft kept");
    (v as any).note = "first message\n" + "reader text\n".repeat(100) + "TAIL";
    v.handleInput("\x1b[19~"); v.render(46); v.handleInput("G"); v.render(46);
    fake.session.input.mockClear();
    for (const key of ["j", "k", "r", "b", "?", "\r", "\x1bOQ"]) v.handleInput(key);
    expect(fake.session.input).not.toHaveBeenCalled();
    expect(fake.session.dispose).not.toHaveBeenCalled();
    expect(fake.editors.state?.draft).toBe("draft kept");
    const snapshot = v.snapshot();
    expect(snapshot.message?.scroll).toBeGreaterThan(0);
    v.handleInput("\x1b");
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    v.handleInput("j"); expect(fake.session.input).toHaveBeenCalledWith("j");
    const moved = make(f, { initial: snapshot });
    try {
      expect(moved.snapshot().message).toEqual(snapshot.message);
      moved.render(46); moved.handleInput("G");
      expect(moved.render(46).join("\n")).toContain("TAIL");
    } finally { moved.dispose(); }
  } finally { v.dispose(); fake.editors.dispose(); }
});

test("STEP6 message suspends a literal prompt and cancels armed actions without restoring them", () => {
  const f = dataflow(); const ask = vi.fn(); const run = vi.fn(); const v = make(f, { ask, run });
  try {
    v.render(80); v.handleInput("A"); v.handleInput("\x1b[19~");
    v.render(80); v.handleInput("A"); v.handleInput("\x1b");
    v.handleInput("A"); expect(run).not.toHaveBeenCalled();
    v.handleInput("unbound-key");
    v.handleInput("a"); press(v, "draft?");
    (v as any).note = "notice";
    v.handleInput("\x1b[19~"); v.render(80);
    v.handleInput("\r"); v.handleInput("q");
    expect(ask).not.toHaveBeenCalled();
    expect(v.render(80).join("\n")).not.toContain("draft?");
    v.handleInput("\x1b[19~");
    expect(v.render(80).join("\n")).toContain("draft?");
    v.handleInput("\r"); expect(ask).toHaveBeenCalledWith(f, expect.anything(), "draft?");
  } finally { v.dispose(); }
});

test("STEP6 dirty-editor confirmation owns keys and mouse ahead of help and native editing", async () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const fake = fakeEditors();
  let resolve!: (answer: string | undefined) => void;
  const confirm = vi.fn(() => new Promise<string | undefined>(done => { resolve = done; }));
  const v = make(f, { editors: fake.editors, confirm });
  try {
    v.render(80); v.handleInput("b"); await editorReady();
    fake.draft("x = 2");
    v.handleInput("\x1bOS"); await editorReady();
    expect(confirm).toHaveBeenCalledOnce();
    fake.session.input.mockClear();
    v.handleInput("\x1bOP"); v.handleInput("\x1b[19~"); v.handleInput("?"); v.handleInput("q");
    expect(v.snapshot().help).toBeUndefined();
    expect(fake.session.input).not.toHaveBeenCalled();
    expect(v.handleMouse({ type: "wheel", x: 4, y: 4, button: "none", wheelDelta: 3 } as any)).toEqual({ handled: true });
    resolve("Keep editing"); await editorReady();
    expect(fake.editors.state?.draft).toBe("x = 2");
    v.handleInput("\x1bOP");
    expect(v.snapshot().help?.group).toBe("Editing");
  } finally { v.dispose(); fake.editors.dispose(); }
});
