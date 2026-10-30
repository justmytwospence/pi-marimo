import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeovimSession, type NeovimOpenOptions, type NeovimExit } from "../src/core/neovim.js";
import type { SaveReceipt } from "../src/core/edit-cell.js";
import { NotebookState } from "../src/core/notebook.js";
import { markdownCellCode } from "../src/core/markdown.js";
import type { Followed } from "../src/core/watcher.js";
import { InlineEditorManager, type InlineEditorHost } from "../src/ui/inline-editor.js";
import { DEFAULT_VIEW_PREFERENCES } from "../src/ui/settings.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Models the synchronous Lua write boundary, not Vim's editing implementation. */
class FakeSession {
  text: string;
  base: string;
  blocked = false;
  reentrant: string[] = [];
  undo: string[] = [];
  constructor(readonly options: NeovimOpenOptions) { this.text = this.base = options.text; }
  private request(name: string): void {
    if (this.blocked) { this.reentrant.push(name); throw new Error(`Reentrant Neovim request: ${name}`); }
  }
  getText = vi.fn(async () => { this.request("getText"); return this.text; });
  replaceText = vi.fn(async (text: string, updateBase = false) => {
    this.request("replaceText"); this.undo.push(this.text); this.edit(text);
    if (updateBase) this.base = text;
  });
  input = vi.fn(async (_data: string) => { this.request("input"); });
  paste = vi.fn(async (_text: string) => { this.request("paste"); });
  resize = vi.fn(async (_width: number, _height: number) => { this.request("resize"); });
  focus = vi.fn(async (_focused: boolean) => { this.request("focus"); });
  setLineNumbers = vi.fn(async (_value: boolean) => { this.request("setLineNumbers"); });
  dispose = vi.fn(() => { this.request("dispose"); });
  edit(text: string, notify = true): void { this.text = text; if (notify) this.options.onDraft?.(text); }
  async write() {
    const before = this.text;
    this.blocked = true;
    try {
      const receipt = await this.options.onWrite(before, this.base);
      this.base = receipt.canonicalCode;
      if (this.text === before) this.edit(receipt.canonicalCode);
      return receipt;
    } finally { this.blocked = false; }
  }
  exit(exit: Partial<NeovimExit> = {}): void {
    this.options.onExit?.({ deliberate: false, text: this.text, code: 1, signal: null, ...exit });
  }
}

const managers: InlineEditorManager[] = [];
function fixture(code = "x = 1") {
  const notebook = new NotebookState();
  notebook.apply("kernel-ready", { cell_ids: ["a"], codes: [code] });
  const followed: Followed = { notebook, attachment: { path: "/fixture.py", url: "http://fixture.invalid", sessionId: "session" }, connection: "connected", current: true, touchedAt: 0 };
  const prefs = structuredClone(DEFAULT_VIEW_PREFERENCES);
  const host = {
    preferences: vi.fn(() => prefs),
    saveCell: vi.fn<InlineEditorHost["saveCell"]>(async (_f, id, text, expected) => {
      const cell = notebook.cells.get(id)!;
      if (cell.code !== expected) throw new Error("Cell changed elsewhere; your draft was not saved");
      cell.code = text;
      return { canonicalCode: text, requestId: "receipt" };
    }),
    runSavedCell: vi.fn<InlineEditorHost["runSavedCell"]>().mockResolvedValue(undefined),
    confirm: vi.fn<InlineEditorHost["confirm"]>().mockResolvedValue("Keep editing"),
    copy: vi.fn(), changed: vi.fn(), note: vi.fn(), help: vi.fn(), dock: vi.fn(),
    numbers: vi.fn(() => { prefs.lineNumbers = !prefs.lineNumbers; }),
  } satisfies InlineEditorHost;
  const sessions: FakeSession[] = [];
  const openSession = vi.fn(async (options: NeovimOpenOptions) => {
    const session = new FakeSession(options); sessions.push(session);
    // NeovimSession has private transport fields; this is the sole injection boundary.
    return session as unknown as NeovimSession;
  });
  const manager = new InlineEditorManager(openSession);
  managers.push(manager);
  const unbind = manager.bind(host);
  return { manager, host, followed, notebook, prefs, sessions, openSession, unbind,
    get session() { return sessions.at(-1)!; },
    remote(text: string) { notebook.cells.get("a")!.code = text; manager.observe(); },
  };
}
// Flush fire-and-forget host actions and the post-write timer without wall-clock polling.
async function settle() { await vi.runAllTimersAsync(); }
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); vi.clearAllTimers(); vi.useRealTimers(); });
const keys = { f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS", f5: "\x1b[15~", f6: "\x1b[17~", f7: "\x1b[18~" };

it.runIf(process.env.PI_MARIMO_NVIM_TEST === "1")("real manager F2 canonical save updates native base before :w and :wq", async () => {
  vi.useRealTimers();
  const f = fixture("x=1");
  f.manager.dispose();
  let session!: NeovimSession;
  const manager = new InlineEditorManager(async options => { session = await NeovimSession.open(options); return session; });
  managers.push(manager);
  manager.bind(f.host);
  const expected: string[] = [];
  f.host.saveCell.mockImplementation(async (_f, id, code, base) => {
    expected.push(base);
    expect(f.notebook.cells.get(id)!.code).toBe(base);
    const canonicalCode = code.replace(/^x=/u, "x = ");
    f.notebook.cells.get(id)!.code = canonicalCode;
    return { canonicalCode, requestId: `${expected.length}` };
  });
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 4_000;
    while (!ready()) { if (Date.now() > deadline) throw new Error("manager live check timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await manager.open(f.followed, "a");
    await session.replaceText("x=2");
    expect(await manager.save()).toBe(true);
    expect(await session.getText()).toBe("x = 2");
    await session.input("A + 3\x1b:w\r");
    await until(() => expected.length === 2 && !manager.state?.saving && manager.state?.baseCode === "x = 2 + 3");
    expect(manager.state?.dirty).toBe(false);
    await session.input(":wq\r");
    await until(() => !manager.active);
    expect(expected).toEqual(["x=1", "x = 2", "x = 2 + 3"]);
    expect(f.host.runSavedCell).not.toHaveBeenCalled();
  } finally { manager.dispose(); }
});

describe("inline editor activation and saves", () => {
  it("explicit source activation on literal Markdown edits Python in that source part", async () => {
    const f = fixture('mo.md("hello")');
    await f.manager.open(f.followed, "a", "python");
    expect(f.manager.state).toMatchObject({ kind: "python", draft: 'mo.md("hello")' });
  });

  it("fresh watcher snapshots update disconnection/session identity without replacing drafts", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("local draft");
    f.manager.updateCurrent({ ...f.followed, connection: "disconnected" });
    expect(f.manager.state?.unavailable).toContain("disconnected");
    expect(await f.manager.save()).toBe(false);
    expect(f.host.saveCell).not.toHaveBeenCalled();
    f.manager.updateCurrent(undefined);
    expect(f.manager.state?.unavailable).toContain("no longer followed");
    f.manager.updateCurrent(f.followed);
    expect(f.manager.state?.unavailable).toBeUndefined();
    expect(f.manager.state?.draft).toBe("local draft");
  });

  it("queues native input while a write is blocked and forwards after the response", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("draft");
    const pending = deferred<SaveReceipt>(); f.host.saveCell.mockReturnValueOnce(pending.promise);
    const writing = f.session.write();
    f.manager.handleInput("q"); f.manager.handleInput("\x1b");
    expect(f.session.input).not.toHaveBeenCalled();
    pending.resolve({ canonicalCode: "draft", requestId: "ack" }); await writing; await settle();
    expect(f.session.input.mock.calls).toEqual([["q"], ["\x1b"]]);
    expect(f.session.reentrant).toEqual([]);
  });
  it.each([
    ["x = 1", "python", "x = 1"],
    ['mo.md(r"""# Heading\n\nbody  """)', "markdown", "# Heading\n\nbody  "],
    ['mo.md(f"hello {name}")', "python", 'mo.md(f"hello {name}")'],
    ['mo.md("hello" + name)', "python", 'mo.md("hello" + name)'],
    ['mo.md("hello")\nprint("important")', "python", 'mo.md("hello")\nprint("important")'],
    ['mo.md("line\\nnext")', "python", 'mo.md("line\\nnext")'],
  ])("opens %s as %s without losing source", async (code, kind, text) => {
    const f = fixture(code);
    expect(await f.manager.open(f.followed, "a")).toBe(true);
    expect(f.manager.state).toMatchObject({ kind, draft: text, baseText: text, baseCode: code, dirty: false });
    expect(f.session.options).toMatchObject({ text, filetype: kind, command: f.prefs.editor.command, options: f.prefs.editor.options });
    expect(f.manager.owns(f.followed)).toBe(true);
    expect(await f.manager.open(f.followed, "a")).toBe(true);
    expect(f.openSession).toHaveBeenCalledTimes(1);
  });

  it("does not capture input when inactive or when the requested cell is missing", async () => {
    const f = fixture();
    expect(await f.manager.open(f.followed, "missing")).toBe(false);
    f.manager.handleInput("q");
    expect(f.manager.active).toBe(false);
    expect(f.manager.render(80, 12)).toEqual([]);
    expect(f.openSession).not.toHaveBeenCalled();
  });

  it.each([false, true])("save(run=%s) waits for save before run acceptance", async run => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("x=2");
    const saving = deferred<SaveReceipt>(), acceptance = deferred<void>();
    f.host.saveCell.mockReturnValueOnce(saving.promise);
    f.host.runSavedCell.mockReturnValueOnce(acceptance.promise);
    const result = f.manager.save(run);
    await Promise.resolve();
    expect(f.host.runSavedCell).not.toHaveBeenCalled();
    saving.resolve({ canonicalCode: "x = 2", requestId: "canonical" });
    if (run) {
      await settle();
      expect(f.host.runSavedCell).toHaveBeenCalledWith(f.followed, "a", "x = 2");
      expect(f.host.note).not.toHaveBeenCalledWith("Saved; run accepted.");
      acceptance.resolve();
    }
    expect(await result).toBe(true);
    expect(f.host.saveCell).toHaveBeenCalledWith(f.followed, "a", "x=2", "x = 1");
    expect(f.session.replaceText).toHaveBeenCalledExactlyOnceWith("x = 2", true);
    expect(f.manager.state).toMatchObject({ draft: "x = 2", baseCode: "x = 2", dirty: false, saving: false });
    expect(f.host.runSavedCell).toHaveBeenCalledTimes(run ? 1 : 0);
    expect(f.host.note).toHaveBeenCalledWith(run ? "Saved; run accepted." : "Saved (not run).");
  });

  it("a rejected run leaves the accepted save clean and is not retried", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("x = 2");
    f.host.runSavedCell.mockRejectedValueOnce(new Error("Saved, but not run: stale source"));
    expect(await f.manager.save(true)).toBe(false);
    expect(f.manager.state).toMatchObject({ dirty: false, baseCode: "x = 2" });
    expect(f.host.note).toHaveBeenCalledWith("Saved, but not run: stale source");
    expect(f.host.saveCell).toHaveBeenCalledTimes(1); expect(f.host.runSavedCell).toHaveBeenCalledTimes(1);
  });

  it.each(["python", "markdown"] as const)("native %s write returns editor text and never makes reentrant requests", async kind => {
    const f = fixture(kind === "markdown" ? markdownCellCode("old") : "old");
    await f.manager.open(f.followed, "a"); f.session.edit("new");
    const canonicalCode = kind === "markdown" ? markdownCellCode("canonical") : "canonical";
    f.host.saveCell.mockResolvedValueOnce({ canonicalCode, requestId: "native" });
    expect(await f.session.write()).toEqual({ canonicalCode: "canonical", requestId: "native" });
    expect(f.session.reentrant).toEqual([]);
    expect(f.session.getText).not.toHaveBeenCalled(); expect(f.session.replaceText).not.toHaveBeenCalled();
    expect(f.host.runSavedCell).not.toHaveBeenCalled();
    expect(f.manager.state).toMatchObject({ baseCode: canonicalCode, baseText: "canonical", draft: "canonical", dirty: false });
    await settle(); expect(f.session.reentrant).toEqual([]);
  });

  it("native write failure retains draft and undo without reentrant RPC or retry", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("draft");
    f.host.saveCell.mockRejectedValueOnce(new Error("Kernel is busy; your draft is kept. Save when idle."));
    await expect(f.session.write()).rejects.toThrow("Kernel is busy");
    await settle();
    expect(f.session.reentrant).toEqual([]); expect(f.session.replaceText).not.toHaveBeenCalled();
    expect(f.manager.state).toMatchObject({ draft: "draft", dirty: true, baseCode: "x = 1", saving: false });
    expect(f.host.saveCell).toHaveBeenCalledTimes(1);
  });

  it("does not replay queued keys from a deliberately closed process into the next editor", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("draft");
    const pending = deferred<SaveReceipt>(); f.host.saveCell.mockReturnValueOnce(pending.promise);
    const old = f.session;
    const write = old.write(); f.manager.handleInput("i");
    pending.resolve({ canonicalCode: "draft", requestId: "quit" }); await write;
    old.exit({ deliberate: true, code: 0 });
    await f.manager.open(f.followed, "a"); await settle();
    expect(f.session).not.toBe(old);
    expect(f.session.input).not.toHaveBeenCalled();
  });

  it("queues input, focus and geometry safely across a synchronous write", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("draft");
    const pending = deferred<SaveReceipt>(); f.host.saveCell.mockReturnValueOnce(pending.promise);
    const write = f.session.write();
    f.manager.handleInput("i"); f.manager.render(30, 6); f.manager.setFocused(false);
    expect(f.session.input).not.toHaveBeenCalled(); expect(f.session.resize).not.toHaveBeenCalled();
    expect(f.session.reentrant).toEqual([]);
    pending.resolve({ canonicalCode: "draft", requestId: "queued" }); await write; await settle();
    expect(f.session.input).toHaveBeenCalledExactlyOnceWith("i");
    // Reconcile geometry on the next UI frame, never an unconditional post-:wq RPC.
    f.manager.render(30, 6);
    expect(f.session.focus).toHaveBeenLastCalledWith(false);
    expect(f.session.resize).toHaveBeenCalledWith(30, 6); expect(f.session.reentrant).toEqual([]);
  });

  it("preserves newer nonblocking edits even when the draft notification is delayed", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("submitted");
    const pending = deferred<SaveReceipt>(); f.host.saveCell.mockReturnValueOnce(pending.promise);
    const save = f.manager.save(); await Promise.resolve();
    f.session.edit("newer", false);
    pending.resolve({ canonicalCode: "canonical", requestId: "slow" });
    expect(await save).toBe(true);
    expect(f.session.text).toBe("newer"); expect(f.session.replaceText).not.toHaveBeenCalled();
    expect(f.manager.state).toMatchObject({ draft: "newer", baseText: "canonical", dirty: true });
  });

  it("serializes Markdown exactly and keeps escape-bearing canonical fallback text editable until reopen", async () => {
    const f = fixture(markdownCellCode("old")); await f.manager.open(f.followed, "a");
    const text = "quotes \"\"\" and ''' with terminal \\";
    f.session.edit(text); expect(await f.manager.save()).toBe(true);
    expect(f.host.saveCell).toHaveBeenCalledWith(f.followed, "a", markdownCellCode(text), markdownCellCode("old"));
    expect(f.manager.state).toMatchObject({ draft: text, baseText: text, dirty: false });
    await f.manager.close(); await f.manager.open(f.followed, "a");
    expect(f.manager.state).toMatchObject({ kind: "python", draft: markdownCellCode(text) });
  });
});

describe("revert and negotiated close", () => {
  it("F6 restores the latest canonical base with one undoable replacement and dirty confirmation", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a");
    f.session.edit("first saved"); await f.manager.save();
    const session = f.session; session.replaceText.mockClear(); session.undo.length = 0;
    session.edit("unsaved"); f.manager.handleInput(keys.f6); await settle();
    expect(f.host.confirm).toHaveBeenCalledWith(expect.stringContaining("latest saved base"), ["Keep editing", "Revert unsaved edits"]);
    expect(session.replaceText).not.toHaveBeenCalled();
    f.host.confirm.mockResolvedValueOnce("Revert unsaved edits");
    f.manager.handleInput(keys.f6); await settle();
    expect(session.replaceText).toHaveBeenCalledExactlyOnceWith("first saved", true);
    expect(session.undo).toEqual(["unsaved"]);
    expect(f.manager.state).toMatchObject({ draft: "first saved", dirty: false });
    expect(f.manager.active).toBe(true); expect(session.dispose).not.toHaveBeenCalled();
    f.host.confirm.mockClear(); await f.manager.revert(); expect(f.host.confirm).not.toHaveBeenCalled();
  });

  it("clean close disposes without prompting", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a");
    expect(await f.manager.close()).toBe(true);
    expect(f.host.confirm).not.toHaveBeenCalled(); expect(f.session.dispose).toHaveBeenCalledTimes(1);
    expect(f.manager.active).toBe(false);
  });

  it.each([undefined, "Keep editing", "Save", "Discard"])("dirty close choice %s", async choice => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("unnotified draft", false);
    f.host.confirm.mockResolvedValueOnce(choice);
    const closes = choice === "Save" || choice === "Discard";
    expect(await f.manager.close()).toBe(closes);
    expect(f.host.confirm).toHaveBeenCalledWith(expect.any(String), ["Keep editing", "Save", "Discard"]);
    expect(f.host.saveCell).toHaveBeenCalledTimes(choice === "Save" ? 1 : 0);
    expect(f.session.dispose).toHaveBeenCalledTimes(closes ? 1 : 0);
    if (!closes) expect(f.manager.state).toMatchObject({ draft: "unnotified draft", dirty: true });
  });

  it("failed close-save stays active and retains the draft", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("draft");
    f.host.confirm.mockResolvedValueOnce("Save"); f.host.saveCell.mockRejectedValueOnce(new Error("timeout"));
    expect(await f.manager.close()).toBe(false); expect(f.manager.state?.draft).toBe("draft");
    expect(f.session.dispose).not.toHaveBeenCalled(); expect(f.host.saveCell).toHaveBeenCalledTimes(1);
  });
});

describe("conflicts, unavailable notebooks and process recovery", () => {
  it.each(["Continue local editing", "Copy draft", "Discard draft and reload"])("conflict: %s", async choice => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("local = 2");
    const old = f.session; f.remote("remote = 3");
    expect(f.manager.state).toMatchObject({ conflict: "remote = 3", draft: "local = 2" });
    expect(old.replaceText).not.toHaveBeenCalled();
    f.host.confirm.mockResolvedValueOnce(choice); expect(await f.manager.save()).toBe(false);
    const [question, choices] = f.host.confirm.mock.calls[0]!;
    expect(question).toContain("Current (-) versus draft (+)");
    expect(question).toMatch(/-.*remote = 3/); expect(question).toMatch(/\+.*local = 2/);
    expect(choices).toEqual(["Continue local editing", "Copy draft", "Discard draft and reload"]);
    expect(f.host.saveCell).toHaveBeenCalledTimes(1); expect(f.host.runSavedCell).not.toHaveBeenCalled();
    if (choice === "Discard draft and reload") {
      expect(old.dispose).toHaveBeenCalledTimes(1); expect(f.openSession).toHaveBeenCalledTimes(2);
      expect(f.manager.state).toMatchObject({ draft: "remote = 3", baseCode: "remote = 3", dirty: false, conflict: undefined });
    } else {
      expect(f.session).toBe(old); expect(f.manager.state?.draft).toBe("local = 2");
      expect(old.dispose).not.toHaveBeenCalled(); expect(f.host.copy).toHaveBeenCalledTimes(choice === "Copy draft" ? 1 : 0);
      if (choice === "Copy draft") expect(f.host.copy).toHaveBeenCalledWith("local = 2");
    }
  });

  it.each(["disconnect", "deletion", "session change"])("%s retains draft and offers copy/discard, not save", async reason => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("precious");
    if (reason === "disconnect") f.followed.connection = "disconnected";
    else if (reason === "deletion") f.notebook.cells.delete("a");
    else f.followed.attachment.sessionId = "replacement";
    f.manager.observe(); expect(f.manager.state?.unavailable).toContain("draft is kept");
    expect(await f.manager.save()).toBe(false); expect(f.host.saveCell).not.toHaveBeenCalled();
    f.host.confirm.mockResolvedValueOnce("Copy draft"); expect(await f.manager.close()).toBe(false);
    expect(f.host.confirm).toHaveBeenLastCalledWith(expect.stringContaining("draft is kept"), ["Keep editing", "Copy draft", "Discard"]);
    expect(f.host.copy).toHaveBeenCalledWith("precious"); expect(f.manager.state?.draft).toBe("precious");
    f.host.confirm.mockResolvedValueOnce("Discard"); expect(await f.manager.close()).toBe(true);
  });

  it("deliberate normal quit discards without a second host confirmation", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("discard me");
    f.session.exit({ deliberate: true, code: 0 });
    expect(f.manager.active).toBe(false); expect(f.host.confirm).not.toHaveBeenCalled();
    await f.manager.open(f.followed, "a"); expect(f.session.options.text).toBe("x = 1");
  });

  it.each(["Reopen", "Copy draft", "Discard"])("uncertain crash recovery: %s", async choice => {
    const f = fixture(); await f.manager.open(f.followed, "a"); const crashed = f.session;
    crashed.exit({ text: "latest crash draft", signal: "SIGTERM", code: null });
    expect(f.manager.state).toMatchObject({ draft: "latest crash draft", dirty: true, recovery: expect.stringContaining("unexpectedly") });
    f.host.confirm.mockResolvedValueOnce(choice);
    expect(await f.manager.close()).toBe(choice === "Discard");
    expect(f.host.confirm).toHaveBeenCalledWith(expect.stringContaining("unexpectedly"), ["Keep editing", "Reopen", "Copy draft", "Discard"]);
    if (choice === "Reopen") {
      expect(f.openSession).toHaveBeenCalledTimes(2); expect(f.session.options.text).toBe("latest crash draft");
      expect(f.manager.state?.recovery).toBeUndefined(); expect(f.manager.active).toBe(true);
    } else if (choice === "Copy draft") {
      expect(f.host.copy).toHaveBeenCalledWith("latest crash draft"); expect(f.openSession).toHaveBeenCalledTimes(1);
      expect(f.manager.active).toBe(true);
    } else expect(f.manager.active).toBe(false);
  });

  it("F2 reopens after a crash without submitting a save", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.exit({ text: "retained" });
    f.manager.handleInput(keys.f2); await settle();
    expect(f.openSession).toHaveBeenCalledTimes(2); expect(f.session.text).toBe("retained");
    expect(f.host.saveCell).not.toHaveBeenCalled();
  });
});

describe("runtime ownership, geometry and input", () => {
  it("bind transfer and focus preserve the same process, draft and undo history", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a"); const session = f.session;
    await session.replaceText("draft"); const undo = session.undo;
    const next = { ...f.host, changed: vi.fn(), help: vi.fn() };
    f.manager.bind(next); f.unbind();
    f.manager.setFocused(false); f.manager.setFocused(true); await settle();
    expect(session.focus.mock.calls).toEqual([[true], [false], [true]]);
    expect(await f.manager.open(f.followed, "a")).toBe(true);
    expect(f.openSession).toHaveBeenCalledTimes(1); expect(session.dispose).not.toHaveBeenCalled();
    expect(session.undo).toBe(undo); expect(undo).toEqual(["x = 1"]);
    expect(f.manager.state?.draft).toBe("draft");
    f.manager.handleInput(keys.f1); expect(next.help).toHaveBeenCalledOnce(); expect(f.host.help).not.toHaveBeenCalled();
    session.edit("still here"); expect(next.changed).toHaveBeenCalled();
  });

  it.each([[11, 4], [12, 3], [1, 1]])("%sx%s is too small and cannot forward native input", async (width, height) => {
    const f = fixture(); await f.manager.open(f.followed, "a"); f.session.edit("draft");
    const rows = f.manager.render(width, height);
    expect(rows).toHaveLength(height);
    f.manager.handleInput("i"); await settle(); expect(f.session.input).not.toHaveBeenCalled();
    expect(f.manager.state?.draft).toBe("draft");
    f.manager.render(12, 4); f.manager.handleInput("i"); await settle();
    expect(f.session.input).toHaveBeenCalledExactlyOnceWith("i");
  });

  it("ordinary notebook-looking keys remain native, including Escape and Ctrl-R", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a");
    const native = ["?", "#", "\r", "q", "!", "\\", "H", "L", "\x1b", "\x12", ":", "\x1b[200~literal\x1b[201~"];
    for (const data of native) f.manager.handleInput(data);
    await settle(); expect(f.session.input.mock.calls).toEqual(native.map(data => [data]));
    for (const action of [f.host.help, f.host.dock, f.host.numbers, f.host.confirm, f.host.saveCell]) expect(action).not.toHaveBeenCalled();
  });

  it("F1-F7 are host actions and never leak into native input", async () => {
    const f = fixture(); await f.manager.open(f.followed, "a");
    f.manager.handleInput(keys.f1); expect(f.host.help).toHaveBeenCalledOnce();
    f.manager.handleInput(keys.f2); await settle(); expect(f.host.saveCell).toHaveBeenCalledTimes(1); expect(f.host.runSavedCell).not.toHaveBeenCalled();
    f.manager.handleInput(keys.f3); await settle(); expect(f.host.saveCell).toHaveBeenCalledTimes(2); expect(f.host.runSavedCell).toHaveBeenCalledOnce();
    f.manager.handleInput(keys.f5); expect(f.host.dock).toHaveBeenCalledOnce();
    f.session.replaceText.mockClear(); f.manager.handleInput(keys.f6); await settle();
    expect(f.session.replaceText).toHaveBeenCalledExactlyOnceWith("x = 1", true);
    f.manager.handleInput(keys.f7); await settle(); expect(f.host.numbers).toHaveBeenCalledOnce();
    expect(f.session.setLineNumbers).toHaveBeenCalledExactlyOnceWith(true);
    f.manager.handleInput(keys.f4); await settle(); expect(f.manager.active).toBe(false);
    expect(f.session.input).not.toHaveBeenCalled();
  });
});
