import { matchesKey } from "@earendil-works/pi-tui";
import { NeovimSession, type NeovimOpenOptions, type NeovimExit } from "../core/neovim.js";
import type { SaveReceipt } from "../core/edit-cell.js";
import { editableMarkdown, markdownCellCode } from "../core/markdown.js";
import type { Followed } from "../core/watcher.js";
import { NeovimGrid, renderNeovimGrid } from "./neovim-grid.js";
import type { ViewPreferences } from "./settings.js";
import { diffLines } from "./rows.js";

export interface InlineEditorState {
  key: string; cellId: string; baseCode: string; baseText: string; draft: string;
  kind: "python" | "markdown"; dirty: boolean; conflict?: string; saving: boolean;
  viewport: { width: number; height: number }; recovery?: string; unavailable?: string;
}
export interface InlineEditorHost {
  preferences(): ViewPreferences;
  highlights?: NeovimOpenOptions["highlights"];
  saveCell(f: Followed, cellId: string, code: string, expectedCode: string): Promise<SaveReceipt>;
  runSavedCell(f: Followed, cellId: string, code: string): Promise<void>;
  confirm(question: string, choices: readonly string[]): Promise<string | undefined>;
  copy(text: string): void;
  changed(): void; note(text: string): void; help(): void; dock(): void; numbers(): void;
}
type OpenSession = (options: NeovimOpenOptions) => Promise<NeovimSession>;
interface Entry { state: InlineEditorState; followed: Followed; sessionId: string | undefined; grid: NeovimGrid; session?: NeovimSession; detached?: string; appliedViewport?: { width: number; height: number }; appliedFocus?: boolean }

/** Runtime-owned, not view-owned: transferring the view never destroys Vim's buffer/undo. */
export class InlineEditorManager {
  private ids = new WeakMap<object, number>();
  private nextId = 0;
  private drafts = new Map<string, Entry>();
  private entry?: Entry;
  private host?: InlineEditorHost;
  private opening = false;
  private confirming = false;
  private closing = false;
  private focused = true;
  private disposed = false;
  private queuedInput: string[] = [];
  constructor(private readonly openSession: OpenSession = options => NeovimSession.open(options)) {}
  get state(): InlineEditorState | undefined { return this.entry?.state; }
  get active(): boolean { return !!this.entry || this.opening; }
  owns(f: Followed): boolean { return this.entry?.followed.notebook === f.notebook; }
  bind(host: InlineEditorHost): () => void {
    this.host = host;
    return () => { if (this.host === host) this.host = undefined; };
  }
  private changed(): void { this.host?.changed(); }
  private note(error: unknown): void { this.host?.note(error instanceof Error ? error.message : String(error)); this.changed(); }
  private setDraft(e: Entry, text: string): void {
    e.state.draft = text; e.state.dirty = text !== e.state.baseText; this.changed();
  }
  private identity(f: Followed, cellId: string): string {
    let id = this.ids.get(f.notebook);
    if (id === undefined) { id = ++this.nextId; this.ids.set(f.notebook, id); }
    return `${id}\0${f.attachment.sessionId ?? ""}\0${cellId}`;
  }
  async open(f: Followed, cellId: string, kind?: "python" | "markdown"): Promise<boolean> {
    if (this.disposed || this.opening) return false;
    if (this.entry) {
      if (this.entry.state.key === this.identity(f, cellId)) return true;
      if (!await this.close()) return false;
    }
    const cell = f.notebook.cells.get(cellId);
    if (!cell) return false;
    const key = this.identity(f, cellId);
    let e = this.drafts.get(key);
    if (!e) {
      const md = kind === "python" ? undefined : editableMarkdown(cell.code);
      const text = md ?? cell.code;
      e = { followed: f, sessionId: f.attachment.sessionId, grid: new NeovimGrid(), state: {
        key, cellId, baseCode: cell.code, baseText: text, draft: text,
        kind: md === undefined ? "python" : "markdown", dirty: false, saving: false,
        viewport: { width: 80, height: 12 },
      } };
      this.drafts.set(key, e);
    }
    this.entry = e;
    if (!e.session) await this.start(e);
    this.changed();
    return true;
  }
  private async start(e: Entry): Promise<void> {
    this.opening = true;
    e.grid = new NeovimGrid();
    try {
      const prefs = this.host!.preferences();
      const viewport = { ...e.state.viewport };
      const session = await this.openSession({ text: e.state.draft, filetype: e.state.kind,
        command: prefs.editor.command, options: prefs.editor.options, lineNumbers: prefs.lineNumbers,
        highlights: this.host?.highlights,
        ...viewport,
        onRedraw: events => { e.grid.reduce(events); this.changed(); },
        onDraft: text => this.setDraft(e, text),
        // Synchronous RPC handler: only marimo IO and local state, NEVER a Vim request.
        onWrite: async text => {
          try { return await this.saveEntry(e, text, true); }
          catch (error) { this.note(error); setTimeout(() => { void this.conflict(e); }, 0); throw error; }
        },
        onRun: async () => { await this.save(true); },
        onRevert: () => this.revert().catch(error => this.note(error)),
        onClose: async () => { try { await this.close(); } catch (error) { this.note(error); } },
        onExit: exit => this.exited(e, exit),
      });
      if (this.disposed || this.entry !== e) session.dispose();
      else { e.session = session; e.appliedViewport = viewport; e.state.recovery = undefined; e.appliedFocus = this.focused; await session.focus(this.focused); }
    } catch (error) { e.state.recovery = error instanceof Error ? error.message : String(error); this.note(error); }
    finally {
      this.opening = false; this.changed();
      if (e.session && this.entry === e) for (const data of this.queuedInput.splice(0)) this.handleInput(data);
    }
  }
  /** Watcher projections are snapshots; refresh connection/identity without touching the draft. */
  updateCurrent(f: Followed | undefined): void {
    const e = this.entry;
    if (!e) return;
    if (f?.notebook === e.followed.notebook) { e.followed = f; e.detached = undefined; }
    else e.detached = f ? "Notebook session changed; your draft is kept" : "Notebook is no longer followed; your draft is kept";
    this.observe();
  }
  observe(): void {
    const e = this.entry;
    if (!e) return;
    const cell = e.followed.notebook.cells.get(e.state.cellId);
    e.state.unavailable = e.detached ?? (!cell ? "Cell was deleted; your draft is kept" : e.followed.attachment.sessionId !== e.sessionId ? "Notebook session changed; your draft is kept" : e.followed.connection !== "connected" ? "Notebook disconnected; your draft is kept" : undefined);
    if (cell && !e.state.saving && cell.code !== e.state.baseCode) e.state.conflict = cell.code;
  }
  private writable(e: Entry): void {
    this.observe();
    if (e.state.unavailable) throw new Error(e.state.unavailable);
  }
  private async saveEntry(e: Entry, text: string, native: boolean): Promise<SaveReceipt> {
    if (e.state.saving) throw new Error("Save already in progress; your draft is kept");
    this.writable(e);
    e.state.saving = true;
    this.setDraft(e, text);
    try {
      const code = e.state.kind === "markdown" ? markdownCellCode(text) : text;
      const receipt = await this.host!.saveCell(e.followed, e.state.cellId, code, e.state.baseCode);
      const canonicalText = e.state.kind === "markdown" ? (editableMarkdown(receipt.canonicalCode) ?? (receipt.canonicalCode === code ? text : undefined)) : receipt.canonicalCode;
      if (canonicalText === undefined) throw new Error("Save outcome unknown: canonical Markdown could not be decoded; your draft is kept");
      e.state.baseCode = receipt.canonicalCode;
      e.state.baseText = canonicalText;
      e.state.conflict = undefined;
      // A nonblocking host save must not overwrite edits newer than its snapshot.
      if (!native && e.session) this.setDraft(e, await e.session.getText());
      if (e.state.draft === text) {
        this.setDraft(e, canonicalText);
        if (!native) await e.session?.replaceText(canonicalText, true);
      } else e.state.dirty = e.state.draft !== canonicalText;
      // Lua reconciles through the response, not a reentrant RPC.
      return { ...receipt, canonicalCode: canonicalText };
    } catch (error) {
      const current = e.followed.notebook.cells.get(e.state.cellId)?.code;
      if (current !== undefined && current !== e.state.baseCode) e.state.conflict = current;
      throw error;
    } finally {
      e.state.saving = false; this.changed();
      // For native :w this runs after the RPC response releases Lua's synchronous wait.
      setTimeout(() => {
        if (this.entry !== e || e.state.saving) return;
        for (const data of this.queuedInput.splice(0)) this.handleInput(data);
      }, 0);
    }
  }
  async save(run = false): Promise<boolean> {
    const e = this.entry;
    if (!e) return false;
    try {
      const text = e.session ? await e.session.getText() : e.state.draft;
      await this.saveEntry(e, text, false);
      this.host?.note("Saved (not run).");
      if (run) { await this.host!.runSavedCell(e.followed, e.state.cellId, e.state.baseCode); this.host?.note("Saved; run accepted."); }
      this.changed(); return true;
    } catch (error) { this.note(error); await this.conflict(e); }
    this.changed(); return false;
  }
  private async conflict(e: Entry): Promise<void> {
    if (e.state.conflict === undefined || this.confirming || this.entry !== e) return;
    this.confirming = true;
    try {
      const draft = e.state.kind === "markdown" ? markdownCellCode(e.state.draft) : e.state.draft;
      const choice = await this.host?.confirm(`Cell changed elsewhere. No force overwrite.\nCurrent (-) versus draft (+):\n${diffLines(e.state.conflict, draft).join("\n")}`,  ["Continue local editing", "Copy draft", "Discard draft and reload"]);
      if (choice === "Copy draft") this.host?.copy(e.state.draft);
      if (choice === "Discard draft and reload") {
        const code = e.followed.notebook.cells.get(e.state.cellId)?.code;
        if (code === undefined) return;
        const md = editableMarkdown(code);
        e.state.kind = md === undefined ? "python" : "markdown";
        e.state.baseCode = code; e.state.baseText = md ?? code; e.state.conflict = undefined;
        this.setDraft(e, e.state.baseText);
        e.session?.dispose(); e.session = undefined;
        await this.start(e);
      }
    } catch (error) { this.note(error); }
    finally { this.confirming = false; this.changed(); }
  }
  async revert(): Promise<void> {
    const e = this.entry;
    if (!e || e.state.saving) return;
    if (e.state.dirty && await this.host?.confirm("Revert unsaved edits to the latest saved base?", ["Keep editing", "Revert unsaved edits"]) !== "Revert unsaved edits") return;
    try { await e.session?.replaceText(e.state.baseText, true); this.setDraft(e, e.state.baseText); }
    catch (error) { this.note(error); }
  }
  async close(): Promise<boolean> {
    if (this.closing) return false;
    this.closing = true;
    try { return await this.closeEntry(); }
    finally {
      this.closing = false;
      const queued = this.queuedInput.splice(0);
      if (this.entry) for (const data of queued) this.handleInput(data);
    }
  }
  private async closeEntry(): Promise<boolean> {
    const e = this.entry;
    if (!e) return !this.opening;
    if (this.opening || e.state.saving || this.confirming) return false;
    // The subscription is the crash fallback; a live buffer read closes notification races.
    try { if (e.session) this.setDraft(e, await e.session.getText()); } catch { /* retain subscribed draft */ }
    if (this.entry !== e) return true;
    this.observe();
    if (e.state.dirty || e.state.recovery || e.state.unavailable) {
      this.confirming = true;
      let choice: string | undefined;
      try { choice = await this.host?.confirm(e.state.recovery ?? e.state.unavailable ?? "Save unsaved cell edits before leaving?", ["Keep editing", ...(e.state.recovery ? ["Reopen", "Copy draft"] : e.state.unavailable ? ["Copy draft"] : ["Save"]), "Discard"]); }
      finally { this.confirming = false; }
      if (choice === "Copy draft") { this.host?.copy(e.state.draft); return false; }
      if (choice === "Reopen") { await this.start(e); return false; }
      if (choice === "Save") { if (!await this.save() || e.state.dirty) return false; }
      else if (choice !== "Discard") return false;
    }
    e.session?.dispose(); this.drafts.delete(e.state.key); this.entry = undefined; this.changed(); return true;
  }
  private exited(e: Entry, exit: NeovimExit): void {
    // Never replay keys from a dead Vim instance into a later cell/process.
    this.queuedInput = [];
    e.session = undefined;
    this.setDraft(e, exit.text);
    if (exit.deliberate) { this.drafts.delete(e.state.key); if (this.entry === e) this.entry = undefined; }
    else { e.state.recovery = "Neovim exited unexpectedly; your draft is kept. F2 reopens; F4 copies or discards."; this.note(e.state.recovery); }
    this.changed();
  }
  setFocused(focused: boolean): void {
    this.focused = focused;
    const e = this.entry;
    if (e?.session && !e.state.saving) {
      e.appliedFocus = focused;
      void e.session.focus(focused).catch(error => this.note(error));
    }
  }
  handleInput(data: string): void {
    const e = this.entry;
    if (!e || this.confirming) return;
    if (e.state.saving || this.opening || this.closing) { this.queuedInput.push(data); return; }
    if (matchesKey(data, "f1")) this.host?.help();
    else if (matchesKey(data, "f2")) { if (!e.session) void this.start(e); else void this.save(); }
    else if (matchesKey(data, "f3")) void this.save(true);
    else if (matchesKey(data, "f4")) void this.close().catch(error => this.note(error));
    else if (matchesKey(data, "f5")) this.host?.dock();
    else if (matchesKey(data, "f6")) void this.revert().catch(error => this.note(error));
    else if (matchesKey(data, "f7")) { this.host?.numbers(); if (!e.state.saving) void e.session?.setLineNumbers(this.host!.preferences().lineNumbers).catch(error => this.note(error)); }
    else if (!e.state.saving && e.state.viewport.width >= 12 && e.state.viewport.height >= 4) void e.session?.input(data).catch(error => this.note(error));
  }
  render(width: number, height: number): string[] {
    const e = this.entry;
    if (!e) return [];
    this.observe();
    e.state.viewport = { width, height };
    if (!e.state.saving && e.session && (width !== e.appliedViewport?.width || height !== e.appliedViewport?.height)) {
      e.appliedViewport = { width, height };
      void e.session.resize(width, height).catch(error => this.note(error));
    }
    if (e.session && !e.state.saving && e.appliedFocus !== this.focused) {
      e.appliedFocus = this.focused;
      void e.session.focus(this.focused).catch(error => this.note(error));
    }
    const state = e.grid.snapshot();
    if (e.state.recovery) state.error = e.state.recovery;
    return renderNeovimGrid(state, width, height, this.focused);
  }
  dispose(): void {
    this.disposed = true;
    for (const e of this.drafts.values()) e.session?.dispose();
    this.drafts.clear(); this.entry = undefined; this.host = undefined;
  }
}
