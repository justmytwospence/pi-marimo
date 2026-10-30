// A notebook, full screen (frame.ts), where you read and steer it. A one-line header (kernel state,
// the agent's changes, the last run), then two panes: the outline on the left (outline.ts: the
// headings and a short line per cell) and the selected cell on the right (detail.ts: prose, output,
// error with its traceback, folded code, dataflow). Narrower than SPLIT_MIN columns the outline
// fills the view and Enter drills into the detail (Esc comes back). It follows the running cell
// until you move. Controls are declared in keys.ts and shown by context help.
// The prompts (ask, Python, a Lens note, a widget's value) dock at the bottom (dock.ts).
import { type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult, colorToHex, CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { basename } from "../core/io.js";
import { type ChartRenderer, VegaRenderer as VegaRendererImpl, type VegaRenderer } from "../core/vega.js";
import { sharedPlotly } from "../core/plotly.js";
import { LiveCharts } from "./live-charts.js";
import { Painter } from "./painter.js";
import { type Cell, truncate } from "../core/notebook.js";
import type { SaveReceipt } from "../core/edit-cell.js";
import { InlineEditorManager, type InlineEditorHost } from "./inline-editor.js";
import { summarizeOutput, type CellOutput, type TableData, type Widget } from "../core/output.js";
import { elapsed, shortWhere } from "../core/render.js";
import type { Followed } from "../core/watcher.js";
import { kernelStateParts, lensParts } from "../bg.js";
import { INPUT_CONTEXT } from "../activity.js";
import { interruptKey, notebookKey, notebookPath } from "./identity.js";
import type { FrameTheme } from "../frame.ts";
import { banner, bottom, row as frameRow, rule as frameRule, CONTENT_LEFT, bodyWidth } from "./notebook-frame.js";
import { type CodeBlockState, codeRows, scrollCode } from "./code.js";
import type { SyntaxHighlighter, SyntaxTheme } from "./syntax.js";
import type { MermaidRenderer } from "../core/mermaid.js";
import { mermaidRows } from "./outputs.js";
import type { EditorFactoryFn } from "../editor-contract.ts";
import { Dock, type DockSpec } from "./dock.js";
import { type Part, detailRows } from "./detail.js";
import { Help, type HelpState } from "./help.js";
import { MessageView, messagePreview, type MessageState } from "./message.js";
import { clean, oneLine } from "./text.js";
import { commandFor, commandKey, footerTokens, type CommandMode } from "./keys.js";
import { type PaneTheme, outlineRows, spinner } from "./outline.js";
import { MAX_WIDGETS, type Row, type RowOptions, firstLine, foldedCells, selectableCells } from "./rows.js";
import { cellTitle } from "./titles.js";
import type { ScratchEvent, ScratchResult } from "./scratch.js";
import { columnCard, rowCard, tableLines } from "./table.js";
import { type TableRpc, type TableSession, parseFilter, tableSession } from "./table-session.js";
import { variableList, variableRows, variableDetailRows, type VariableSort } from "./variables.js";
import { PackagePane, type PackagePaneState } from "./packages.js";
import type { PackageClient, PackageAction, PackageSnapshot } from "../core/packages.js";
import { SessionPreferences, type ViewPreferences } from "./settings.js";
import { duration } from "./time.js";
import { type WidgetAction, nextValue, typeable, typedValue, widgetHit, widgetValue } from "./widgets.js";

export { notebookLines, outlineRows } from "./outline.js";
export { detailRows } from "./detail.js";
export { selectableCells, type Row, type RowOptions } from "./rows.js";

/** Banner, header, rule, rule above the hints, the hints, bottom border. */
const CHROME = 6;
const TICK_MS = 100;
/** The row the panes start at: banner, header, rule. */
const ROWS_TOP = 3;
/** From this many columns the outline and the detail sit side by side; narrower, one at a time. */
const SPLIT_MIN = 100;
/** The outline's width in the split: a third of the view, within limits. */
const outlineWidth = (width: number): number => Math.max(28, Math.min(44, Math.floor((width - 4) * 0.32)));
/** Rows the stacked outline takes above the detail: about a third of the page, odd (as many rows above the cursor as below it), 1 to 9. */
const stackedOutlineRows = (page: number): number => {
  const rows = Math.max(1, Math.min(9, Math.round(page * 0.3), page - 4));
  return rows % 2 ? rows : rows - 1;
};
/** Columns before a widget's control: its glyph and a space, from the central content origin. */
const WIDGET_TEXT = 2;
/** Between the panes. */
const SEPARATOR_WIDTH = 3;
/** Lines of a scratch run shown above its prompt, at most. */
const SCRATCH_ROWS = 12;

/** One cell or its whole section in the detail: the choice holds for the rest of the Pi process. */
let sectionMode: boolean | undefined;

/** What the docked view needs from the split that hosts it. */
export interface DockedHost { focused(): boolean; focusMain(): void }

/** The view's own state, carried over when it moves between full screen and docked. */
export interface ViewState {
  cursor?: string;
  follow: boolean;
  scroll: number;
  detailScroll: number;
  codeOpen: string[];
  folded: string[];
  diffs: string[];
  section: boolean;
  filter: string;
  typing?: boolean;
  findFrom?: string;
  packageTyping?: boolean;
  mode: "cells" | "variables" | "packages";
  packagePane?: PackagePaneState;
  packageSnapshot?: PackageSnapshot;
  packageTree?: unknown;
  packageTreeError?: string;
  varCursor?: string;
  varFilter: string;
  varSort?: VariableSort;
  varDetail?: boolean;
  varScroll?: number;
  codeOffsets?: Array<[string, CodeBlockState]>;
  diagramSources?: string[];
  sectionCodeOpen?: string[];
  focusedBlock?: string;
  preferences?: ViewPreferences;
  timing?: boolean;
  help?: HelpState;
  message?: MessageState;
  note?: string;
  table?: { cell: string; objectId: string };
  widget?: { cell: string; index: number; sub: number };
}

export interface ViewActions {
  packages?(f: Followed): Promise<PackageClient>;
  preferences?: SessionPreferences;
  syntax?: SyntaxHighlighter;
  diagrams?: MermaidRenderer;
  /** Set when the view is docked beside the chat. */
  docked?: DockedHost;
  /** Start from this state (a view that moved between full screen and docked). */
  initial?: ViewState;
  /** `|` in the full-screen view: dock it beside the chat. */
  dock?(key: string, state: ViewState): void;
  /** `|` in the docked view: back to full screen. */
  undock?(key: string, state: ViewState): void;
  /** The notebooks followed now. */
  followed(): Followed[];
  interrupt(f: Followed): Promise<void>;
  openInBrowser(f: Followed): void;
  /** Runs these cells (id and current code) in the notebook's kernel. */
  run?(f: Followed, cells: Array<{ id: string; code: string }>): Promise<void>;
  /** The servers standing for this notebook (pi-bg's, and one Pi started). */
  servers?(f: Followed): string[];
  /** Stops the servers standing for this notebook; how many. */
  stopServers?(f: Followed): number;
  /** How the notebook's last run went: `ran 2m 3s · 1 error · 5m ago`. */
  lastRun?(f: Followed): string | undefined;
  /** Whether the main agent is working now. */
  agentBusy?(): boolean;
  /** Sends the main agent a message about the notebook (and the cell). */
  ask?(f: Followed, cell: Cell | undefined, text: string): void;
  /** Runs Python in the notebook's kernel, streaming what it prints. */
  scratch?(f: Followed, code: string, onEvent: (e: ScratchEvent) => void, signal: AbortSignal): Promise<ScratchResult>;
  /** Sets one of a cell's widgets. */
  setWidget?(f: Followed, cell: Cell, widget: Widget, value: unknown): void;
  /** Marks a cell for the agent as a Lens selection; resolves with its label. */
  mark?(f: Followed, cell: Cell, note: string): Promise<string>;
  /** Removes a Lens selection. */
  unmark?(f: Followed, selectionId: string): Promise<void>;
  /** Run Plotly figures live (default); false draws them as pictures. */
  liveCharts?: boolean;
  /** Start with the whole section in the detail pane (O toggles it). */
  outputs?: boolean;
  /** Cells' code open (default) or folded to its preview; B flips one cell. */
  code?: "open" | "folded";
  /** A marimo table's kernel functions (search, summaries...), for driving tables. */
  table?: TableRpc;
  /** Writes a table's selection to the kernel as the browser does. */
  setTableSelection?(f: Followed, cell: Cell, objectId: string, value: unknown[]): void;
  /** Saves the whole table as CSV in Pi's working directory; resolves with the file name. */
  saveTable?(f: Followed, cell: Cell, objectId: string): Promise<string>;
  editors?: InlineEditorManager;
  saveCell?(f: Followed, cellId: string, code: string, expectedCode: string): Promise<SaveReceipt>;
  runSavedCell?(f: Followed, cellId: string, canonicalCode: string): Promise<void>;
  confirm?(question: string, choices: readonly string[]): Promise<string | undefined>;
  copy?(text: string): void;
  /** Pi's keybindings and the suite's editor, for the docked prompts. */
  keybindings?: unknown;
  editorFactory?: EditorFactoryFn;
}

interface ScratchState {
  code: string;
  lines: ScratchEvent[];
  result?: ScratchResult;
  error?: string;
  running: boolean;
  started: number;
  abort: AbortController;
}

/** `╭─ Notebook nb.py · ctrl+] focus ──╮` for the docked view: no "back" arrow, it sits beside the chat. */
function dockedBanner(file: string, width: number, th: FrameTheme, focused: boolean): string {
  const label = ` Notebook ${file} · ${focused ? "ctrl+] chat" : "ctrl+] focus"} `;
  return frameRow(th.fg("accent", th.bold(truncateToWidth(label.trim(), bodyWidth(width)))), width, th);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class NotebookView implements Component, Focusable {
  private scroll = 0;
  private follow = true;
  private cursor: string | undefined;
  /** Cells whose code shows in the detail. */
  /** Cells whose code is flipped from the default (`view.code`). */
  private codeOpen = new Set<string>();
  private sectionCodeOpen = new Set<string>();
  private codeOffsets = new Map<string, CodeBlockState>();
  private diagramSources = new Set<string>();
  private focusedBlock: string | undefined;
  private diagramBlocks = new Set<string>();
  private readonly preferences: SessionPreferences;
  private readonly editors: InlineEditorManager;
  private readonly ownsEditors: boolean;
  private unbindEditor?: () => void;
  private _focused = true;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.editors?.setFocused(value); }
  get editing(): boolean { return this.editors.active; }
  private readonly renderReady = () => { if (!this.closed) this.tui.requestRender(); };
  private readonly renderDiagram = (source: string, options: RowOptions & { blockId: string }): Row[] => {
    this.diagramBlocks.add(options.blockId);
    if (this.diagramSources.has(options.blockId)) return codeRows(source, { ...options, language: "mermaid" });
    return mermaidRows(source, this.theme, {
      ...options, bar: "", renderer: this.actions.diagrams,
      appearance: (this.theme as SyntaxTheme).appearance ?? "dark",
    });
  };
  private diagramRows = this.renderDiagram;
  /** The detail's scroll, in its own rows. */
  private detailScroll = 0;
  /** Which cell (and view) the detail last drew, so a new one starts at its top. */
  private detailKey = "";
  private lastOutline: Row[] = [];
  private lastDetail: Row[] = [];
  /** Where the panes are: the outline's width, the detail's left column, which panes show. */
  /**
   * Where the panes are: side by side (`both`), or `stacked` when narrow: a few outline rows around the
   * cursor above a rule, the detail under it, as a mail app's list above its reading pane.
   */
  private panes: { lw: number; detailLeft: number; detailTop: number; outlineHeight: number; shows: "both" | "stacked" } = { lw: 28, detailLeft: 0, detailTop: 0, outlineHeight: 0, shows: "both" };
  private filter = "";
  /** Typing a filter: keys go to it. */
  private typing = false;
  /** Where the cursor was when `/` started, for Esc. */
  private findFrom: string | undefined;
  /** Scroll the cursor's cell into view on the next render (after a move, not after scrolling). */
  private reveal = false;
  private armedTarget: string | undefined;
  /** A run of several cells waits for a second press: which, and in which kernel session. */
  private armedRun: { what: "stale" | "all"; target: string } | undefined;
  /** `S` waits for a second press, like `x`. */
  private armedStop: string | undefined;
  /** `M` waits for a second press: the selection it removes. */
  private armedUnmark: { id: string; label: string } | undefined;
  private note: string | undefined;
  private closed = false;
  private mode: "cells" | "variables" | "packages" = "cells";
  private packagePane = new PackagePane();
  private packageOwner?: Followed["notebook"];
  private packageConfirmation = false;
  /** The detail shows the cell's whole section. */
  private section: boolean;
  private folded = new Set<string>();
  private diffs = new Set<string>();
  private varCursor: string | undefined;
  private varFilter = "";
  private varSort: VariableSort = "name";
  private varDetail = false;
  private varScroll = 0;
  /** The focused part of the cursor's cell (n/p), an index into `lastParts`. */
  private part: number | undefined;
  private partCell: string | undefined;
  private scrollToPart = false;
  private lastParts: Part[] = [];
  /** The table the keys drive (table mode). */
  private table: { cell: string; objectId: string } | undefined;
  /** The widget the keys drive. */
  private widget: { cell: string; index: number; sub: number } | undefined;
  /** A slider being dragged with the mouse. */
  private dragging: { cell: string; index: number } | undefined;
  private help = false;
  private helpView = new Help();
  private lastTransient = 0;
  private messageView?: MessageView;
  private messageOverflow = false;
  private timing = false;
  private sourceFocus = false;
  private dock: Dock | undefined;
  private scratch: ScratchState | undefined;
  private lastRows: Row[] = [];
  private lastPage = 0;
  private lastDock = 0;
  private readonly vega: VegaRenderer;
  private readonly plotly: ChartRenderer;
  private readonly live: LiveCharts;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: Pick<TUI, "requestRender"> & { terminal: { rows: number } },
    private readonly theme: FrameTheme,
    private key: string,
    private readonly actions: ViewActions,
    private readonly done: () => void,
    vega: VegaRenderer = new VegaRendererImpl(),
    plotly: ChartRenderer = sharedPlotly(),
    live?: LiveCharts,
  ) {
    this.preferences = actions.preferences ?? new SessionPreferences();
    this.ownsEditors = !actions.editors;
    this.editors = actions.editors ?? new InlineEditorManager();
    const colors = (theme as SyntaxTheme).colors;
    const highlights: NonNullable<InlineEditorHost["highlights"]> = {};
    if (colors) {
      const fg = (key: string) => colors[key] ? colorToHex(colors[key]!) : undefined;
      highlights.Normal = { ...(fg("text") ? { fg: fg("text")! } : {}), ...(fg("toolPendingBg") ? { bg: fg("toolPendingBg")! } : {}) };
      for (const [group, key] of Object.entries({ Comment: "syntaxComment", String: "syntaxString", Number: "syntaxNumber", Statement: "syntaxKeyword", Function: "syntaxFunction", Type: "syntaxType", Operator: "syntaxOperator", Delimiter: "syntaxPunctuation", LineNr: "dim" })) if (fg(key)) highlights[group] = { fg: fg(key)! };
    }
    const editorHost: InlineEditorHost = {
      highlights,
      preferences: () => this.preferences.snapshot(),
      saveCell: (f, id, code, expected) => actions.saveCell ? actions.saveCell(f, id, code, expected) : Promise.reject(new Error("Saving is not available here; your draft is kept")),
      runSavedCell: (f, id, code) => actions.runSavedCell ? actions.runSavedCell(f, id, code) : Promise.reject(new Error("Saved, but not run: running is not available here")),
      confirm: (question, choices) => this.confirm(question, choices),
      copy: text => { if (!actions.copy) throw new Error("Copying is not available here; your draft is kept"); actions.copy(text); },
      changed: this.renderReady,
      note: text => { this.note = text; this.renderReady(); },
      help: () => { this.openHelp(); this.renderReady(); },
      dock: () => { this.toggleDock(); this.renderReady(); },
      numbers: () => this.preferences.update({ lineNumbers: !this.preferences.snapshot().lineNumbers }),
    };
    this.unbindEditor = this.editors.bind(editorHost);
    this.vega = vega;
    this.plotly = plotly;
    this.section = sectionMode ?? actions.outputs ?? false;
    if (actions.initial) this.restore(actions.initial);
    this.live = live ?? new LiveCharts(() => { if (!this.closed) this.tui.requestRender(); }, undefined, undefined, undefined, () => Painter.for(this.tui), actions.docked ? "base" : "overlay");
    if (!actions.docked) Painter.for(this.tui)?.setExclusive(true);
    this.tui.requestRender();
    // Ticks fast while a cell runs (the spinner turns), once a second otherwise.
    let ticks = 0;
    this.timer = setInterval(() => {
      if (this.closed) return;
      const f = this.current();
      const busy = !!f && (!!f.notebook.running() || f.notebook.queued() > 0);
      if (!busy && ++ticks % 10 !== 0) return;
      this.syncConfirmation();
      this.tui.requestRender();
    }, TICK_MS);
    this.timer.unref?.();
  }

  get notebook(): string {
    return this.key;
  }

  snapshot(): ViewState {
    return {
      ...(this.cursor !== undefined ? { cursor: this.cursor } : {}),
      follow: this.follow,
      scroll: this.scroll,
      detailScroll: this.detailScroll,
      codeOpen: [...this.codeOpen],
      folded: [...this.folded],
      diffs: [...this.diffs],
      section: this.section,
      filter: this.filter,
      typing: this.typing,
      ...(this.findFrom ? { findFrom: this.findFrom } : {}),
      packageTyping: this.packagePane.typing,
      mode: this.mode,
      packagePane: { ...this.packagePane.state, expanded: [...this.packagePane.state.expanded], treeCursor: this.packagePane.treeCursor },
      ...(this.packagePane.snapshot ? { packageSnapshot: this.packagePane.snapshot } : {}),
      ...(this.packagePane.tree ? { packageTree: this.packagePane.tree } : {}),
      ...(this.packagePane.treeError ? { packageTreeError: this.packagePane.treeError } : {}),
      ...(this.varCursor !== undefined ? { varCursor: this.varCursor } : {}),
      varFilter: this.varFilter,
      varSort: this.varSort, varDetail: this.varDetail, varScroll: this.varScroll,
      codeOffsets: [...this.codeOffsets].map(([id, state]) => [id, { ...state }]),
      diagramSources: [...this.diagramSources],
      sectionCodeOpen: [...this.sectionCodeOpen],
      preferences: this.preferences.snapshot(),
      timing: this.timing,
      ...(this.help ? { help: { ...this.helpView.state } } : {}),
      ...(this.messageView ? { message: { ...this.messageView.state } } : {}),
      ...(this.note ? { note: this.note } : {}),
      ...(this.table ? { table: { ...this.table } } : {}),
      ...(this.widget ? { widget: { ...this.widget } } : {}),
      ...(this.focusedBlock ? { focusedBlock: this.focusedBlock } : {}),
    };
  }

  private restore(s: ViewState): void {
    if (s.preferences) this.preferences.update(s.preferences);
    this.timing = s.timing ?? false;
    this.messageView = s.message ? new MessageView(s.message) : undefined;
    this.note = s.note;
    this.help = !!s.help;
    this.helpView = new Help(s.help);
    this.table = s.table ? { ...s.table } : undefined;
    this.widget = s.widget ? { ...s.widget } : undefined;
    this.cursor = s.cursor;
    this.follow = s.follow;
    this.scroll = s.scroll;
    this.detailScroll = s.detailScroll;
    this.codeOpen = new Set(s.codeOpen);
    this.folded = new Set(s.folded);
    this.diffs = new Set(s.diffs);
    this.section = s.section;
    this.filter = s.filter;
    this.typing = s.typing ?? false;
    this.findFrom = s.findFrom;
    this.mode = s.mode;
    this.packagePane = new PackagePane(s.packagePane);
    this.packagePane.typing = s.packageTyping ?? false;
    this.packagePane.snapshot = s.packageSnapshot;
    this.packagePane.tree = s.packageTree;
    this.packagePane.treeError = s.packageTreeError;
    this.varCursor = s.varCursor;
    this.varFilter = s.varFilter;
    this.varSort = s.varSort ?? "name";
    this.varDetail = s.varDetail ?? false;
    this.varScroll = s.varScroll ?? 0;
    this.codeOffsets = new Map(s.codeOffsets ?? []);
    this.diagramSources = new Set(s.diagramSources ?? []);
    this.sectionCodeOpen = new Set(s.sectionCodeOpen ?? []);
    this.focusedBlock = s.focusedBlock;
    // So the detail's scroll survives the first render.
    this.detailKey = `${s.cursor ?? ""}\0${s.section}`;
  }

  /** Esc: docked, back to the chat; full screen, out of the view. */
  private leave(): void {
    if (this.actions.docked) this.actions.docked.focusMain();
    else this.close();
  }

  private toggleDock(): void {
    if (this.actions.docked) {
      if (this.actions.undock) this.actions.undock(this.key, this.snapshot());
      else this.note = "Not available here.";
    } else if (this.actions.dock) {
      this.actions.dock(this.key, this.snapshot());
      this.close(true);
    } else this.note = "Docking is not available here.";
  }

  /** A new cursor cell starts without a focused part. */
  private syncPart(): void {
    if (this.partCell !== this.cursor) {
      this.part = undefined;
      this.partCell = this.cursor;
    }
  }

  private current(): Followed | undefined {
    return this.actions.followed().find((f) => notebookKey(f) === this.key);
  }

  private syncConfirmation(): void {
    const f = this.current();
    if (!f || f.connection !== "connected" || (!f.notebook.running() && f.notebook.queued() === 0) || interruptKey(f) !== this.armedTarget) this.armedTarget = undefined;
    if (!f || interruptKey(f) !== this.armedStop) this.armedStop = undefined;
    if (!f || f.connection !== "connected" || (this.armedRun && this.armedRun.target !== interruptKey(f))) this.armedRun = undefined;
    if (!f || (this.armedUnmark && !f.notebook.lens.selections().some((s) => s.id === this.armedUnmark!.id))) this.armedUnmark = undefined;
  }

  private viewport(): number {
    return Math.max(0, this.tui.terminal.rows - CHROME - this.lastDock - this.lastTransient);
  }

  /** Read-only scrolling content: global listeners leave its keys alone (a filter or a docked prompt takes them). */
  [INPUT_CONTEXT](): "viewer" | "filter" | "editor" {
    return this.messageView ? "viewer" : this.help ? (this.helpView.state.typing ? "filter" : "viewer") : this.editors.active || this.dock ? "editor" : this.typing || this.packagePane.typing ? "filter" : "viewer";
  }

  private cells(f: Followed): Cell[] {
    return selectableCells(f.notebook, this.filter, { folded: this.folded });
  }

  /** Move the cursor to the next/previous selectable cell that passes `want` (wrapping). */
  private step(f: Followed, by: 1 | -1, want: (c: Cell) => boolean = () => true, none = "No such cell."): void {
    const cells = this.cells(f);
    if (!cells.length) return;
    const at = Math.max(0, cells.findIndex((c) => c.id === (this.cursor ?? cells[0]!.id)));
    for (let i = 1; i <= cells.length; i++) {
      const c = cells[((at + by * i) % cells.length + cells.length) % cells.length]!;
      if (want(c)) {
        this.cursor = c.id;
        this.follow = false;
        this.reveal = true;
        return;
      }
    }
    this.note = none;
  }

  private cursorCell(f: Followed): Cell | undefined {
    const cells = this.cells(f);
    return cells.find((c) => c.id === this.cursor) ?? cells[0];
  }

  /** Put the cursor on a cell, opening the fold that hides it. */
  private goTo(f: Followed, id: string): void {
    const head = foldedCells(f.notebook, this.folded).get(id);
    if (head) this.folded.delete(head);
    // A fold inside the opened one may still hide it.
    const inner = foldedCells(f.notebook, this.folded).get(id);
    if (inner) this.folded.delete(inner);
    this.filter = "";
    this.mode = "cells";
    this.table = undefined;
    this.cursor = id;
    this.follow = false;
    this.reveal = true;
  }

  private startRun(f: Followed, cells: Cell[], what: string): void {
    if (!this.actions.run) {
      this.note = "Running cells is not available here.";
      return;
    }
    if (f.connection !== "connected") {
      this.note = "The notebook is not connected.";
      return;
    }
    if (!cells.length) {
      this.note = "Nothing to run.";
      return;
    }
    // Shown as queued at once; marimo's own status replaces it as the run starts.
    const marked = cells.filter((c) => c.status === "idle" && !f.notebook.isMarkdown(c));
    for (const c of marked) c.status = "queued";
    this.note = undefined;
    this.follow = cells.length > 1;
    this.actions.run(f, cells.map((c) => ({ id: c.id, code: c.code }))).then(
      () => { if (!this.closed) this.tui.requestRender(); },
      (e: unknown) => {
        for (const c of marked) if (c.status === "queued") c.status = "idle";
        if (!this.closed) { this.note = `Could not run ${what}: ${message(e)}`; this.tui.requestRender(); }
      },
    );
  }

  private typeFilter(data: string): void {
    const vars = this.mode === "variables";
    // ctrl+j/ctrl+k (and the arrows) move through the matches while typing.
    const by = matchesKey(data, "ctrl+j") || matchesKey(data, "down") ? 1 : matchesKey(data, "ctrl+k") || matchesKey(data, "up") ? -1 : 0;
    if (by) {
      const f = this.current();
      if (vars) {
        const list = f ? variableList(f.notebook, this.varFilter, this.varSort) : [];
        const at = list.findIndex((v) => v.name === this.varCursor);
        this.varCursor = list[Math.max(0, Math.min(list.length - 1, at + by))]?.name ?? this.varCursor;
        this.reveal = true;
      } else if (f) this.step(f, by as 1 | -1);
      this.tui.requestRender();
      return;
    }
    let text = vars ? this.varFilter : this.filter;
    // `/` finds: Enter goes to the match under the cursor and shows everything again; Esc goes back.
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
      const found = matchesKey(data, "enter");
      this.typing = false;
      if (vars) {
        this.varFilter = "";
        if (!found) this.varCursor = this.findFrom;
      } else {
        this.filter = "";
        const target = found ? this.cursor : this.findFrom;
        const f = this.current();
        if (f && target) this.goTo(f, target);
        else this.cursor = target;
      }
      this.findFrom = undefined;
      this.follow = false;
      this.reveal = true;
      this.tui.requestRender();
      return;
    }
    else if (matchesKey(data, "backspace")) text = text.slice(0, -1);
    else if (!data.startsWith("\x1b") && data >= " ") text += data;
    if (vars) {
      this.varFilter = text;
      this.varCursor = undefined;
    } else {
      this.filter = text;
      this.cursor = undefined;
    }
    this.scroll = 0;
    this.follow = false;
    this.reveal = true;
    this.tui.requestRender();
  }

  /** Moves to the next (or previous) followed notebook, starting it afresh. */
  private switchNotebook(by: 1 | -1): void {
    if (this.editors.active) return;
    const all = this.actions.followed();
    const i = all.findIndex((o) => notebookKey(o) === this.key);
    const next = all[((i + by) % Math.max(1, all.length) + all.length) % Math.max(1, all.length)];
    if (!next || notebookKey(next) === this.key) return;
    this.key = notebookKey(next);
    this.scroll = 0;
    this.follow = true;
    this.cursor = undefined;
    this.filter = "";
    this.varFilter = "";
    this.varCursor = undefined;
    this.folded.clear();
    this.diffs.clear();
    this.codeOpen.clear();
    this.detailScroll = 0;
    this.widget = undefined;
    this.table = undefined;
    this.part = undefined;
  }

  // --- docked prompts -------------------------------------------------------------------------

  private openDock(spec: DockSpec): void {
    this.dock?.dispose();
    this.dock = new Dock(this.tui, this.theme, spec, this.actions.editorFactory, this.actions.keybindings);
    this.note = undefined;
  }

  private closeDock(): void {
    this.dock?.dispose();
    this.dock = undefined;
    if (!this.scratch?.running) this.scratch = undefined;
  }

  private openAsk(f: Followed): void {
    const ask = this.actions.ask;
    if (!ask) { this.note = "Not available here."; return; }
    const cell = this.cursorCell(f);
    const file = basename(f.attachment.path);
    const busy = this.actions.agentBusy?.() === true;
    this.openDock({
      kind: "ask",
      title: cell ? `Ask the agent about ${cellTitle(f.notebook, cell)} in ${file}` : `Ask the agent about ${file}`,
      hint: `enter send · esc cancel${busy ? " · the agent is working: this goes in as a follow-up" : ""}`,
      submit: (text) => {
        if (!text.trim()) return;
        this.closeDock();
        ask(f, cell, text);
        this.note = "Sent to the agent.";
        this.tui.requestRender();
      },
      cancel: () => { this.closeDock(); this.tui.requestRender(); },
    });
  }

  private openScratch(f: Followed): void {
    const run = this.actions.scratch;
    if (!run) { this.note = "Not available here."; return; }
    if (f.connection !== "connected") { this.note = "The notebook is not connected."; return; }
    const idle = "enter run · esc close";
    this.openDock({
      kind: "scratch",
      title: `Python in ${basename(f.attachment.path)}'s kernel · a scratch cell, nothing is saved`,
      hint: idle,
      submit: (code) => {
        if (!code.trim() || this.scratch?.running) return;
        const dock = this.dock;
        dock?.addToHistory(code);
        dock?.setText("");
        dock?.setHint("running… · esc cancels (marimo interrupts the kernel)");
        const state: ScratchState = { code, lines: [], running: true, started: Date.now(), abort: new AbortController() };
        this.scratch = state;
        run(f, code, (e) => {
          state.lines.push(e);
          if (state.lines.length > 200) state.lines.splice(0, state.lines.length - 200);
          if (!this.closed) this.tui.requestRender();
        }, state.abort.signal).then(
          (r) => { state.result = r; },
          (e: unknown) => { state.error = state.abort.signal.aborted || (e instanceof Error && e.name === "AbortError") ? "cancelled" : message(e); },
        ).finally(() => {
          state.running = false;
          if (this.dock === dock) dock?.setHint(idle);
          if (!this.closed) this.tui.requestRender();
        });
        this.tui.requestRender();
      },
      cancel: () => {
        if (this.scratch?.running) {
          this.scratch.abort.abort();
          this.note = "Cancelled: marimo interrupts the kernel when a scratch run is cancelled.";
        } else this.closeDock();
        this.tui.requestRender();
      },
    });
  }

  private openMark(f: Followed): void {
    const mark = this.actions.mark;
    if (!mark) { this.note = "Not available here."; return; }
    if (!f.notebook.lens.present) { this.note = "No Lens in this notebook (marimo-lens mounts one when it is installed). a asks the agent about this cell instead."; return; }
    if (f.connection !== "connected") { this.note = "The notebook is not connected."; return; }
    const cell = this.cursorCell(f);
    if (!cell) { this.note = "No cell selected."; return; }
    const next = f.notebook.lens.instances()[0]?.nextLabel ?? "S1";
    this.openDock({
      kind: "mark",
      title: `Note for the agent on ${cellTitle(f.notebook, cell)} (Lens ${next})`,
      hint: "enter mark · esc cancel · the note may be empty",
      submit: (note) => {
        this.closeDock();
        this.note = "Marking…";
        mark(f, cell, note.trim()).then(
          (label) => { if (!this.closed) { this.note = `Marked ${label}. a asks the agent to address it.`; this.tui.requestRender(); } },
          (e: unknown) => { if (!this.closed) { this.note = `Lens did not take the mark: ${message(e)}`; this.tui.requestRender(); } },
        );
        this.tui.requestRender();
      },
      cancel: () => { this.closeDock(); this.tui.requestRender(); },
    });
  }

  private openValue(f: Followed, cell: Cell, w: Widget): void {
    const value = widgetValue(f.notebook, w);
    this.openDock({
      kind: "value",
      title: `${oneLine(w.label || w.kind)}: new value`,
      hint: "enter set · esc cancel",
      initial: value === undefined || value === null ? "" : String(value),
      submit: (text) => {
        const typed = typedValue(w, text);
        if ("error" in typed) { this.note = typed.error; this.tui.requestRender(); return; }
        this.closeDock();
        this.actions.setWidget?.(f, cell, w, typed.value);
        this.tui.requestRender();
      },
      cancel: () => { this.closeDock(); this.tui.requestRender(); },
    });
  }

  private openInlineEditor(f: Followed, cell: Cell, kind?: "python" | "markdown"): void {
    this.follow = false;
    this.cursor = cell.id;
    this.mode = "cells";
    this.filter = "";
    this.folded.clear();
    this.widget = undefined;
    this.table = undefined;
    this.live.leave();
    this.setCode(cell.id, true);
    this.sectionCodeOpen.add(cell.id);
    void this.editors.open(f, cell.id, kind).then(() => this.renderReady(), e => { this.note = message(e); this.renderReady(); });
  }

  /** The session and current data of a cell's marimo table, when the view can drive it. */
  private tableFor(f: Followed, cell: Cell, source?: string | CellOutput): { session: TableSession; data: TableData } | undefined {
    const id = typeof source === "string" ? source : this.table?.cell === cell.id ? this.table.objectId : undefined;
    // A supplied leaf is authoritative, including a static table without an object id.
    const t = typeof source === "object" ? source.table : id ? [cell.output, ...(cell.output?.blocks?.map(block => block.output) ?? [])].find(output => output?.table?.objectId === id)?.table : cell.output?.table;
    if (!t?.objectId || !this.actions.table || f.connection !== "connected") return undefined;
    const session = tableSession(`${this.key}\0${t.objectId}`, cell, t);
    session.onChange = () => { if (!this.closed) this.tui.requestRender(); };
    return { session, data: session.data() };
  }

  private copy(text: string): void {
    const terminal = (this.tui as unknown as { terminal?: { write?(d: string): void } }).terminal;
    if (terminal?.write) {
      terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
      this.note = "Copied.";
    } else this.note = "Copying needs a terminal.";
  }

  private tableKey(f: Followed | undefined, data: string): void {
    const cell = f && this.table ? f.notebook.cells.get(this.table.cell) : undefined;
    const t = f && cell ? this.tableFor(f, cell) : undefined;
    const rpc = this.actions.table;
    if (!f || !cell || !t || !rpc || !this.table) { this.table = undefined; return; }
    const s = t.session;
    const objectId = this.table.objectId;
    this.note = undefined;
    const command = commandFor("table", data)?.id;
    if (command === "table-close") {
      if (s.card) s.closeCard();
      else this.table = undefined;
      return;
    }
    if (command === "help") { this.openHelp(); return; }
    if (command === "table-down") s.move(f, rpc, 1, 0);
    else if (command === "table-up") s.move(f, rpc, -1, 0);
    else if (command === "table-left") s.move(f, rpc, 0, -1);
    else if (command === "table-right") s.move(f, rpc, 0, 1);
    else if (command === "table-next") s.setPage(f, rpc, s.page + 1);
    else if (command === "table-previous") s.setPage(f, rpc, s.page - 1);
    else if (command === "table-first") s.setPage(f, rpc, 0);
    else if (command === "table-last") {
      const n = s.pageCount();
      if (n === undefined) this.note = "marimo did not count the rows: ] pages forward.";
      else s.setPage(f, rpc, n - 1);
    } else if (command === "table-larger") s.setPageSize(f, rpc, 1);
    else if (command === "table-smaller") s.setPageSize(f, rpc, -1);
    else if (command === "table-sort" || command === "table-sort-add") s.toggleSort(f, rpc, s.columnName(), command === "table-sort-add");
    else if (command === "table-search") {
      this.openDock({
        kind: "table",
        title: `Search ${cellTitle(f.notebook, cell)}`,
        hint: "enter search · empty clears · esc cancel",
        initial: s.query,
        submit: (text) => { this.closeDock(); s.setQuery(f, rpc, text); this.tui.requestRender(); },
        cancel: () => { this.closeDock(); this.tui.requestRender(); },
      });
    } else if (command === "table-filter") {
      const column = s.columnName();
      const kind = t.data.fieldTypes?.[column]?.kind ?? "string";
      this.openDock({
        kind: "table",
        title: `Filter ${column} (${kind}): > 5 · 1..10 · in a, b · null · !null · ~regex · text`,
        hint: "enter filter · esc cancel",
        submit: (text) => {
          const parsed = parseFilter(column, kind, text);
          if ("error" in parsed) { this.note = parsed.error; this.tui.requestRender(); return; }
          this.closeDock();
          s.addFilter(f, rpc, parsed);
          this.tui.requestRender();
        },
        cancel: () => { this.closeDock(); this.tui.requestRender(); },
      });
    } else if (command === "table-clear") s.clearFilters(f, rpc);
    else if (command === "table-select") {
      const value = this.actions.setTableSelection ? s.toggleSelect(f.notebook) : undefined;
      if (!value) this.note = "This table has no selection.";
      else this.actions.setTableSelection!(f, cell, objectId, value);
    } else if (command === "table-row") s.openRow();
    else if (command === "table-column") s.openColumn(f, rpc);
    else if (command === "table-summary") s.toggleSummaries(f, rpc);
    else if (command === "table-copy") this.copy(s.cellValue());
    else if (command === "table-copy-row") this.copy(s.toTsv());
    else if (command === "table-csv") {
      const save = this.actions.saveTable;
      if (!save) this.note = "Not available here.";
      else {
        this.note = "Saving…";
        save(f, cell, objectId).then(
          (name) => { if (!this.closed) { this.note = `Saved ${name}.`; this.tui.requestRender(); } },
          (e: unknown) => { if (!this.closed) { this.note = `Could not save: ${message(e)}`; this.tui.requestRender(); } },
        );
      }
    } else if (command === "table-refresh") void s.refresh(f, rpc);
  }

  /** `t`: drive the table of the cursor's cell (or the focused part). */
  private enterTable(f: Followed, cell: Cell | undefined): void {
    const focused = this.part !== undefined ? this.lastParts[this.part] : undefined;
    const target = focused?.kind === "table" ? f.notebook.cells.get(focused.cell) : cell;
    const objectId = focused?.kind === "table" ? focused.tableObjectId ?? focused.output?.table?.objectId : target?.output?.table?.objectId;
    if (!target || !objectId) { this.note = "This cell shows no table marimo can page."; return; }
    if (!this.actions.table || f.connection !== "connected") { this.note = "This cell shows no table marimo can page: the table needs a connected notebook."; return; }
    this.table = { cell: target.id, objectId };
    this.cursor = target.id;
    this.follow = false;
    this.reveal = true;
  }

  // --- keys -----------------------------------------------------------------------------------

  /** The widgets of the driven cell, or undefined (and widget mode ends) when they are gone. */
  private drivenWidgets(f: Followed | undefined): { cell: Cell; widgets: Widget[] } | undefined {
    const w = this.widget;
    const cell = w && f ? f.notebook.cells.get(w.cell) : undefined;
    const widgets = cell?.output?.widgets?.slice(0, MAX_WIDGETS) ?? [];
    if (!f || !cell || !widgets.length || f.connection !== "connected") {
      this.widget = undefined;
      return undefined;
    }
    if (w!.index >= widgets.length) w!.index = widgets.length - 1;
    return { cell, widgets };
  }

  private widgetKey(f: Followed | undefined, data: string): void {
    const driven = this.drivenWidgets(f);
    if (!driven || !f) { this.note = "The widgets are gone."; return; }
    const command = commandFor("widget", data)?.id;
    const focus = this.widget!;
    const w = driven.widgets[focus.index]!;
    if (command === "widget-close") { this.widget = undefined; return; }
    if (command === "widget-previous") {
      focus.index = (focus.index - 1 + driven.widgets.length) % driven.widgets.length;
      focus.sub = 0;
      this.reveal = true;
      return;
    }
    if (command === "widget-next") {
      focus.index = (focus.index + 1) % driven.widgets.length;
      focus.sub = 0;
      this.reveal = true;
      return;
    }
    const act = (action: WidgetAction) => {
      if (w.disabled) { this.note = "This widget is disabled."; return; }
      const next = nextValue(w, widgetValue(f.notebook, w), action, focus.sub);
      if (!next) { this.note = typeable(w) ? "enter types a value" : undefined; return; }
      focus.sub = next.sub;
      this.note = undefined;
      if (next.send) this.actions.setWidget?.(f, driven.cell, w, next.value);
    };
    if (command === "widget-dec") act("dec");
    else if (command === "widget-inc") act("inc");
    else if (command === "widget-dec10") act("dec10");
    else if (command === "widget-inc10") act("inc10");
    else if (command === "widget-toggle") act("toggle");
    else if (command === "widget-type") {
      if (typeable(w) && !w.disabled) this.openValue(f, driven.cell, w);
      else act("toggle");
    }
  }

  private openPackages(f: Followed | undefined): void {
    if (!f) return;
    if (this.packageOwner !== f.notebook) {
      if (this.packageOwner) { this.packagePane.dispose(); this.packagePane = new PackagePane(); }
      this.packageOwner = f.notebook;
    }
    const pane = this.packagePane;
    if (!this.actions.packages) { pane.error = "Package management unavailable"; return; }
    void this.actions.packages(f).then(client => {
      if (!this.closed && pane === this.packagePane) return pane.refresh(client, this.renderReady);
    }).catch(e => { if (pane === this.packagePane) { pane.error = message(e); this.renderReady(); } });
  }

  private packageMutation(f: Followed, action: PackageAction, spec: string): void {
    const pane = this.packagePane;
    if (pane.mutating || !this.actions.packages) return;
    pane.mutating = true;
    void this.actions.packages(f).then(client => client.mutate(action, spec, async question => {
      if (this.closed || this.current()?.notebook !== f.notebook) return false;
      const fp = question.fingerprint;
      this.packageConfirmation = true;
      try {
        const answer = await this.actions.confirm?.(`${question.action}: ${question.spec}\nNotebook: ${fp.filename}\nKernel: ${fp.executable}\npid ${fp.pid} · ${fp.manager}\n${question.warning}`, ["Cancel", "Confirm"]);
        return answer === "Confirm" && !this.closed && this.current()?.notebook === f.notebook;
      } finally { this.packageConfirmation = false; }
    })).then(result => {
      if (pane !== this.packagePane || this.closed) return;
      pane.error = result.status === "restart-required" ? "Restart required; restart manually when safe." : `Package operation: ${result.status}`;
      if (result.status !== "cancelled") this.openPackages(f);
    }).catch(e => { if (pane === this.packagePane) pane.error = message(e); })
      .finally(() => { pane.mutating = false; this.renderReady(); });
  }

  private packagesKey(f: Followed | undefined, data: string): void {
    const pane = this.packagePane, state = pane.state;
    if (pane.typing) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) pane.typing = false;
      else if (matchesKey(data, "backspace")) state.filter = state.filter.slice(0, -1);
      else if (!data.startsWith("\x1b") && data >= " ") state.filter += data;
      state.cursor = 0; state.scroll = 0; pane.treeCursor = 0; return;
    }
    const command = commandFor("packages", data)?.id;
    if (command === "pkg-back" && state.detail) { state.detail = false; state.scroll = 0; return; }
    if (command === "pkg-close" || command === "pkg-back") { this.mode = "cells"; this.reveal = true; return; }
    if (command === "pkg-find") { pane.typing = true; state.filter = ""; state.scroll = 0; return; }
    if (command === "pkg-tab") {
      const tabs = ["Installed", "Missing", "Operations"] as const;
      state.tab = tabs[(tabs.indexOf(state.tab) + 1) % tabs.length]!; state.cursor = 0; state.scroll = 0; state.detail = false; return;
    }
    const delta = command === "pkg-down" ? 1 : command === "pkg-up" ? -1 : 0;
    if (delta) {
      if (state.detail) pane.treeCursor = Math.max(0, Math.min(pane.trees().length - 1, pane.treeCursor + delta));
      else state.cursor = Math.max(0, state.cursor + delta);
      state.scroll = Math.max(0, state.scroll + delta); return;
    }
    if (command === "pkg-page-down" || command === "pkg-page-up") { state.scroll = Math.max(0, state.scroll + (command === "pkg-page-down" ? this.viewport() : -this.viewport())); return; }
    if (command === "pkg-top" || command === "pkg-bottom") { state.scroll = command === "pkg-top" ? 0 : Number.MAX_SAFE_INTEGER; return; }
    if (!f) return;
    if (command === "pkg-refresh") { this.openPackages(f); return; }
    if (command === "pkg-detail") {
      if (state.detail) {
        const treeRow = pane.trees()[pane.treeCursor];
        if (treeRow?.expandable) state.expanded = state.expanded.includes(treeRow.key) ? state.expanded.filter(key => key !== treeRow.key) : [...state.expanded, treeRow.key];
      } else if (state.tab === "Installed" && pane.installed()[state.cursor] && this.actions.packages) {
        const selected = pane.installed()[state.cursor]!;
        state.detail = true; state.scroll = 0; pane.treeError = undefined;
        void this.actions.packages(f).then(client => client.dependencyTree()).then(tree => {
          if (pane === this.packagePane && !this.closed) { pane.tree = tree; pane.selectTree(selected.name); this.renderReady(); }
        }).catch(e => { pane.treeError = `Dependency tree unavailable: ${message(e)}`; this.renderReady(); });
      }
      return;
    }
    if (pane.mutating) { this.note = "A package operation is already pending."; return; }
    if (command === "pkg-add") {
      this.openDock({ kind: "ask", title: "Install kernel requirement", hint: "Requirement, not a shell command · enter review · esc cancel", submit: text => {
        if (!text.trim()) return;
        this.closeDock(); this.packageMutation(f, "install", text.trim()); this.renderReady();
      }, cancel: () => { this.closeDock(); this.renderReady(); } });
    } else if ((command === "pkg-upgrade" || command === "pkg-remove") && state.tab === "Installed" && !state.detail) {
      const selected = pane.installed()[state.cursor];
      if (selected) this.packageMutation(f, command === "pkg-upgrade" ? "upgrade" : "remove", selected.name);
    }
  }

  private variablesKey(f: Followed | undefined, data: string): void {
    const command = commandFor("variables", data)?.id;
    const page = this.viewport();
    const list = f ? variableList(f.notebook, this.varFilter, this.varSort) : [];
    const at = Math.max(0, list.findIndex((v) => v.name === this.varCursor));
    if (command === "var-back" && this.varDetail) { this.varDetail = false; this.varScroll = 0; return; }
    if (this.varDetail) {
      const down = command === "var-down", up = command === "var-up";
      if (down || up || command === "var-first" || command === "var-last") {
        this.varScroll = command === "var-first" ? 0 : command === "var-last" ? Number.MAX_SAFE_INTEGER : Math.max(0, this.varScroll + (down ? 1 : -1)); return;
      }
      const next = command === "var-page-down" || command === "var-half-down";
      const previous = command === "var-page-up" || command === "var-half-up";
      if (next || previous) { this.varScroll = Math.max(0, this.varScroll + (next ? page : -page)); return; }
    }
    if (command === "var-sort") { const sorts: VariableSort[] = ["name", "type", "definition"]; this.varSort = sorts[(sorts.indexOf(this.varSort) + 1) % sorts.length]!; return; }
    const moveTo = (i: number) => { this.varCursor = list[Math.max(0, Math.min(list.length - 1, i))]?.name; this.reveal = true; };
    if (command === "var-leave") { this.leave(); return; }
    if (command === "var-close" || command === "var-back") {
      this.mode = "cells";
      this.scroll = 0;
      this.reveal = true;
      return;
    }
    if (command === "notebook-previous") { this.switchNotebook(-1); this.mode = "variables"; return; }
    if (command === "notebook-next") { this.switchNotebook(1); this.mode = "variables"; return; }
    if (command === "var-find") { this.typing = true; this.findFrom = this.varCursor; this.varFilter = ""; return; }
    if (command === "var-down") return moveTo(at + 1);
    if (command === "var-up") return moveTo(at - 1);
    if (command === "var-first") { this.scroll = 0; return moveTo(0); }
    if (command === "var-last") return moveTo(list.length - 1);
    if (command === "var-half-up") return this.move(-Math.max(1, Math.floor(page / 2)));
    if (command === "var-half-down") return this.move(Math.max(1, Math.floor(page / 2)));
    if (command === "var-page-up") return this.move(-page);
    if (command === "var-page-down") return this.move(page);
    const v = list[at];
    if (!f || !v) return;
    if (command === "var-detail") {
      this.varDetail = true; this.varScroll = 0;
    } else if (command === "var-definition") {
      if (v.definedBy && f.notebook.cells.has(v.definedBy)) this.goTo(f, v.definedBy);
      else this.note = `No cell defines ${v.name}.`;
    } else if (command === "var-copy" || command === "var-copy-value") {
      try { if (this.actions.copy) this.actions.copy(command === "var-copy" ? v.name : v.value); else this.copy(command === "var-copy" ? v.name : v.value); }
      catch (e) { this.note = message(e); }
    } else if (command === "var-ask") {
      const defining = v.definedBy ? f.notebook.cells.get(v.definedBy) : undefined;
      if (this.actions.ask) this.actions.ask(f, defining, `Explain variable ${v.name} (${v.datatype}), defined in ${defining ? cellTitle(f.notebook, defining) : "unknown cell"}.`);
      else this.note = "Asking the agent is not available here.";
    } else if (command === "var-table") {
      const cell = v.definedBy ? f.notebook.cells.get(v.definedBy) : undefined;
      if (!cell?.output?.table) this.note = `No table output for ${v.name}.`;
      else { this.goTo(f, cell.id); this.enterTable(f, cell); }
    } else if (command === "var-uses") {
      const users = f.notebook.order.filter(id => v.usedBy.includes(id));
      if (!users.length) { this.note = `No cell uses ${v.name}.`; return; }
      const choices = ["Cancel", ...users.map((id, i) => `${i + 1}. ${cellTitle(f.notebook, f.notebook.cells.get(id)!)}`)];
      void this.confirm(`Use sites of ${v.name}`, choices).then(choice => {
        const id = users[choices.indexOf(choice ?? "") - 1];
        if (!this.closed && id && this.current()?.notebook === f.notebook) { this.goTo(f, id); this.tui.requestRender(); }
      }).catch(e => { this.note = message(e); this.renderReady(); });
    }
  }

  /** Enter (or a double click): edit source/Markdown or activate the focused control. */
  private activate(f: Followed): void {
    if (this.mode === "variables") return this.variablesKey(f, "\r");
    const c = this.cursorCell(f);
    if (!c) return;
    this.cursor = c.id;
    this.syncPart();
    this.reveal = true;
    const p = this.part !== undefined ? this.lastParts[this.part] : undefined;
    const target = p ? f.notebook.cells.get(p.cell) : undefined;
    if (p && target) {
      switch (p.kind) {
        case "table": this.enterTable(f, target); break;
        case "chart":
          if (!this.live.inspect(p.output ?? target.output)) this.note = "Not a live chart.";
          break;
        case "widgets":
          if (!this.actions.setWidget) this.note = "Widgets cannot be driven here.";
          else if (f.connection !== "connected") this.note = "The notebook is not connected.";
          else this.widget = { cell: target.id, index: p.widgetIndices?.[0] ?? 0, sub: 0 };
          break;
        case "code": this.openInlineEditor(f, target, "python"); break;
        case "markdown": this.openInlineEditor(f, target); break;
        default: this.note = "e jumps to the next failed cell.";
      }
      return;
    }
    this.openInlineEditor(f, c);
  }

  private toggleCode(id: string): void {
    if (this.section) {
      if (!this.sectionCodeOpen.delete(id)) this.sectionCodeOpen.add(id);
    } else if (!this.codeOpen.delete(id)) this.codeOpen.add(id);
  }

  private codeShown(id: string): boolean {
    return this.section ? this.sectionCodeOpen.has(id) : (this.actions.code !== "folded") !== this.codeOpen.has(id);
  }

  private setCode(id: string, open: boolean): void {
    if (this.codeShown(id) !== open) this.toggleCode(id);
  }

  /** The pane under a column and a page row (from the first row under the header); the rule between stacked panes is neither. */
  private paneAt(x: number, line: number): "outline" | "detail" | undefined {
    const { shows, detailLeft, outlineHeight } = this.panes;
    if (shows === "both") return x >= detailLeft ? "detail" : "outline";
    return line < outlineHeight ? "outline" : line >= this.panes.detailTop ? "detail" : undefined;
  }

  /** ^D, PgDn and the like: the detail scrolls (the outline follows the cursor). */
  private scrollBy(by: number): void {
    if (this.mode === "cells") this.detailScroll = Math.max(0, this.detailScroll + by);
    else if (this.mode === "packages") this.packagePane.state.scroll = Math.max(0, this.packagePane.state.scroll + by);
    else if (this.varDetail) this.varScroll = Math.max(0, this.varScroll + by);
    else this.move(by);
  }

  handleInput(data: string): void {
    if (this.closed || this.packageConfirmation) return;
    this.syncConfirmation();
    if (this.messageView) {
      if (!this.messageView.input(data, this.lastPage)) this.messageView = undefined;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "f8")) {
      const text = this.transientMessage(true);
      if (text) {
        this.messageView = new MessageView({ text, scroll: 0 });
        this.armedTarget = undefined;
        this.armedRun = undefined;
        this.armedStop = undefined;
        this.armedUnmark = undefined;
      }
      this.tui.requestRender();
      return;
    }
    if (this.help) {
      this.help = this.helpView.handleInput(data, this.lastPage);
      this.tui.requestRender();
      return;
    }
    if (this.editors.active) {
      this.editors.updateCurrent(this.current());
      this.editors.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.dock) {
      if (this.tui.terminal.rows > 0) this.dock.handleInput(data);
      this.tui.requestRender();
      return;
    }
    // Text owners bypass the command registry: punctuation must remain literal.
    if (this.typing) return this.typeFilter(data);
    if (this.mode === "packages" && this.packagePane.typing) {
      this.packagesKey(this.current(), data); this.tui.requestRender(); return;
    }
    const command = commandFor(this.commandMode(), data);
    if (!command) {
      // Unknown notebook input still cancels a pending two-press action, as before.
      // It must not leave an old destructive confirmation armed for a later key.
      if (this.mode === "cells" && !this.table && !this.widget && !this.live.inspecting) {
        this.armedTarget = undefined;
        this.armedRun = undefined;
        this.armedStop = undefined;
        this.armedUnmark = undefined;
        this.note = undefined;
      }
      this.timing = false;
      this.tui.requestRender();
      return;
    }
    if (command.id === "help") {
      this.openHelp(); this.tui.requestRender(); return;
    }
    if (command.id === "diagnostics" || command.id === "output") {
      const current = this.preferences.snapshot();
      if (command.id === "diagnostics") {
        const modes = ["all", "errors", "warnings", "none"] as const;
        this.preferences.update({ diagnostics: modes[(modes.indexOf(current.diagnostics) + 1) % modes.length]! });
      } else this.preferences.update({ showOutput: !current.showOutput });
      // An invisible control must never retain keyboard or mouse ownership.
      const focused = this.part === undefined ? undefined : this.lastParts[this.part];
      const hidesOutput = !this.preferences.snapshot().showOutput && (!!this.widget || !!this.table || this.live.inspecting || (focused && ["printed", "output", "table", "chart", "widgets"].includes(focused.kind)));
      if (hidesOutput || (command.id === "diagnostics" && focused?.kind === "error")) this.focusSource();
      this.tui.requestRender();
      return;
    }
    if (this.timing) {
      this.timing = false;
      this.tui.requestRender();
      return;
    }
    if (this.live.inspecting && command.id.startsWith("chart-")) {
      // LiveCharts owns the pointer protocol; registry aliases map to its canonical input.
      const key = command.keys[0]!;
      this.live.key(key === "escape" ? "\x1b" : key === "space" ? " " : key);
      this.tui.requestRender();
      return;
    }
    if (this.typing) return this.typeFilter(data);
    const f = this.current();
    if (this.widget) {
      this.widgetKey(f, data);
      this.tui.requestRender();
      return;
    }
    if (this.table && this.mode === "cells") {
      this.tableKey(f, data);
      this.tui.requestRender();
      return;
    }
    if (command.id === "dock") {
      this.toggleDock();
      this.tui.requestRender();
      return;
    }
    if (this.mode === "packages") {
      this.packagesKey(f, data);
      this.tui.requestRender();
      return;
    }
    if (command.id === "packages") {
      this.mode = "packages";
      this.openPackages(f);
      this.tui.requestRender();
      return;
    }
    if (this.mode === "variables") {
      this.variablesKey(f, data);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape") && this.filter) {
      this.filter = "";
      this.cursor = undefined;
      this.tui.requestRender();
      return;
    }
    if (this.actions.docked && data === "q") {
      this.close();
      return;
    }
    if (command.id === "leave") {
      this.leave();
      return;
    }
    if (!this.preferences.snapshot().showOutput && ["table", "widget", "chart"].includes(command.id)) {
      this.focusSource();
      this.tui.requestRender();
      return;
    }
    if (command.id === "timing") {
      this.timing = true;
      this.tui.requestRender();
      return;
    }
    if (command.id === "numbers") {
      this.preferences.update({ lineNumbers: !this.preferences.snapshot().lineNumbers });
      this.tui.requestRender();
      return;
    }
    if (["code-left", "code-right", "code-reset", "diagram"].includes(command.id)) {
      const candidates = this.lastDetail.filter(r => r.blockId && (this.part === undefined || r.part === this.part));
      const blockId = candidates.find(r => r.blockId === this.focusedBlock)?.blockId ?? candidates[0]?.blockId;
      if (blockId) {
        if (command.id === "diagram" && this.diagramBlocks.has(blockId)) {
          if (!this.diagramSources.delete(blockId)) this.diagramSources.add(blockId);
          // Markdown caches the adapter identity; change it only when source visibility changes.
          this.diagramRows = (source, options) => this.renderDiagram(source, options);
        } else if (command.id !== "diagram") {
          const state = this.codeOffsets.get(blockId) ?? { offset: 0 };
          if (command.id === "code-reset") state.offset = 0;
          else scrollCode(state, command.id === "code-left" ? -8 : 8, Number.MAX_SAFE_INTEGER);
          this.codeOffsets.set(blockId, state);
        }
      }
      this.tui.requestRender();
      return;
    }
    if (command.id === "edit" && f) {
      const cell = this.cursorCell(f);
      if (cell) {
        const selected = this.part === undefined ? undefined : this.lastParts[this.part];
        const target = selected ? f.notebook.cells.get(selected.cell) ?? cell : cell;
        this.openInlineEditor(f, target, selected?.kind === "code" ? "python" : undefined);
      }
      this.tui.requestRender();
      return;
    }
    if (command.id === "fold-code" && f) {
      const cell = this.cursorCell(f);
      if (cell) this.toggleCode(cell.id);
      this.tui.requestRender();
      return;
    }
    const page = this.viewport();
    if (command.id === "interrupt") {
      const busy = f && f.connection === "connected" && (f.notebook.running() || f.notebook.queued() > 0);
      this.armedRun = undefined;
      if (!f || !busy) {
        this.armedTarget = undefined;
        this.note = "Nothing is running.";
      } else if (this.armedTarget !== interruptKey(f)) {
        this.armedTarget = interruptKey(f);
      } else {
        this.armedTarget = undefined;
        this.note = "Interrupting…";
        this.actions.interrupt(f).then(
          () => { if (!this.closed) { this.note = "Interrupted."; this.tui.requestRender(); } },
          (e: unknown) => { if (!this.closed) { this.note = `Could not interrupt: ${message(e)}`; this.tui.requestRender(); } },
        );
      }
      this.tui.requestRender();
      return;
    }
    if (f && (command.id === "run-stale" || command.id === "run-all")) {
      const what = command.id === "run-stale" ? "stale" : "all";
      this.armedTarget = undefined;
      if (this.armedRun?.what !== what || this.armedRun.target !== interruptKey(f)) this.armedRun = { what, target: interruptKey(f) };
      else {
        this.armedRun = undefined;
        const all = f.notebook.ordered().filter((c) => !f.notebook.isMarkdown(c) && !c.disabled);
        const cells = what === "all" ? all : all.filter((c) => c.stale || f.notebook.edited(c));
        this.startRun(f, cells, what === "all" ? `all ${cells.length} cells` : `${cells.length} stale cell${cells.length === 1 ? "" : "s"}`);
      }
      this.tui.requestRender();
      return;
    }
    if (f && command.id === "stop" && this.actions.stopServers && (this.actions.servers?.(f).length ?? 0) > 0) {
      this.armedTarget = undefined;
      this.armedRun = undefined;
      if (this.armedStop !== interruptKey(f)) this.armedStop = interruptKey(f);
      else {
        this.armedStop = undefined;
        const n = this.actions.stopServers(f);
        this.note = n ? `Stopping the marimo server${n === 1 ? "" : "s"}…` : "No server to stop.";
      }
      this.tui.requestRender();
      return;
    }
    if (f && command.id === "unmark") {
      this.armedTarget = undefined;
      this.armedRun = undefined;
      this.armedStop = undefined;
      const unmark = this.actions.unmark;
      const c = this.cursorCell(f);
      const selection = c ? f.notebook.lens.selections().filter((s) => s.cells.includes(c.id)).at(-1) : undefined;
      if (!unmark) this.note = "Not available here.";
      else if (!selection) { this.armedUnmark = undefined; this.note = "No Lens selection on this cell."; }
      else if (this.armedUnmark?.id !== selection.id) {
        this.armedUnmark = { id: selection.id, label: selection.label };
        this.note = `M again removes ${selection.label}`;
      } else {
        this.armedUnmark = undefined;
        const label = selection.label;
        this.note = `Removing ${label}…`;
        unmark(f, selection.id).then(
          () => { if (!this.closed) { this.note = `Removed ${label}.`; this.tui.requestRender(); } },
          (e: unknown) => { if (!this.closed) { this.note = `Could not remove ${label}: ${message(e)}`; this.tui.requestRender(); } },
        );
      }
      this.tui.requestRender();
      return;
    }
    this.armedTarget = undefined;
    this.armedRun = undefined;
    this.armedStop = undefined;
    this.armedUnmark = undefined;
    this.note = undefined;
    const nb = f?.notebook;
    this.syncPart();
    if (command.id === "notebook-previous") this.switchNotebook(-1);
    else if (command.id === "notebook-next") this.switchNotebook(1);
    else if (command.id === "browser" && f) {
      this.actions.openInBrowser(f);
      this.note = "Opened in the browser.";
    } else if (command.id === "find") {
      this.typing = true;
      this.findFrom = this.cursor;
      this.filter = "";
    } else if (command.id === "section") {
      this.section = !this.section;
      sectionMode = this.section;
      this.note = this.section ? "Section view: the whole section." : "Cell view.";
      this.reveal = true;
    } else if (f && nb && command.id === "fold-section") {
      const c = this.cursorCell(f);
      const cells = nb.ordered();
      const at = c ? cells.findIndex((x) => x.id === c.id) : -1;
      const head = c && nb.headings(c).length ? c : cells.slice(0, Math.max(0, at)).reverse().find((x) => nb.headings(x).length > 0);
      if (!head) this.note = "No section here.";
      else {
        if (!this.folded.delete(head.id)) this.folded.add(head.id);
        this.cursor = head.id;
        this.follow = false;
        this.reveal = true;
      }
    } else if (f && nb && command.id === "fold-all") {
      if (this.folded.size) this.folded.clear();
      else for (const c of nb.ordered()) if (nb.headings(c).length) this.folded.add(c.id);
      const c = this.cursorCell(f);
      if (c) this.cursor = c.id;
      this.reveal = true;
    } else if (f && nb && this.filter && (matchesKey(data, "ctrl+k") || matchesKey(data, "ctrl+j"))) this.step(f, matchesKey(data, "ctrl+j") ? 1 : -1);
    else if (f && nb && command.id === "section-previous") this.step(f, -1, (c) => nb.headings(c).length > 0, "No section here.");
    else if (f && nb && command.id === "section-next") this.step(f, 1, (c) => nb.headings(c).length > 0, "No section here.");
    else if (command.id === "part-next" || command.id === "part-previous") {
      if (!this.lastParts.length) this.note = "This cell has one part.";
      else {
        const last = this.lastParts.length - 1;
        if (command.id === "part-next") this.part = this.part === undefined ? 0 : Math.min(last, this.part + 1);
        else this.part = this.part === undefined ? last : Math.max(0, this.part - 1);
        this.focusedBlock = undefined;
        this.scrollToPart = true;
      }
    } else if (f && command.id === "table") this.enterTable(f, this.cursorCell(f));
    else if (f && nb && (command.id === "change-next" || command.id === "change-previous")) {
      if (![...nb.agentChanges.keys()].some((id) => nb.cells.has(id))) this.note = "The agent has not changed a cell since your last message.";
      else this.step(f, command.id === "change-next" ? 1 : -1, (c) => nb.agentChanges.has(c.id), "The agent has not changed a cell since your last message.");
    } else if (f && nb && command.id === "diff") {
      const c = this.cursorCell(f);
      if (!c || !nb.agentChanges.has(c.id)) this.note = "The agent has not changed this cell since your last message.";
      else {
        if (!this.diffs.delete(c.id)) { this.diffs.add(c.id); this.setCode(c.id, true); }
        this.cursor = c.id;
        this.reveal = true;
      }
    } else if (f && command.id === "variables") {
      this.mode = "variables";
      this.scroll = 0;
      this.reveal = true;
    } else if (f && nb && (command.id === "parent" || command.id === "child")) {
      const c = this.cursorCell(f);
      const order = nb.order;
      const here = c ? order.indexOf(c.id) : -1;
      const candidates = c ? (command.id === "parent" ? nb.parents(c.id) : nb.children(c.id)) : [];
      const pick = command.id === "parent"
        ? [...candidates].reverse().find((id) => order.indexOf(id) < here) ?? candidates[0]
        : candidates.find((id) => order.indexOf(id) > here) ?? candidates[0];
      if (!pick) this.note = command.id === "parent" ? "No upstream cell." : "No downstream cell.";
      else this.goTo(f, pick);
    } else if (f && command.id === "widget") {
      const c = this.cursorCell(f);
      const widgets = c?.output?.widgets?.slice(0, MAX_WIDGETS) ?? [];
      if (!c || !widgets.length) this.note = "This cell shows no widgets.";
      else if (!this.actions.setWidget) this.note = "Widgets cannot be driven here.";
      else if (f.connection !== "connected") this.note = "The notebook is not connected.";
      else {
        this.widget = { cell: c.id, index: 0, sub: 0 };
        this.cursor = c.id;
        this.follow = false;
        this.reveal = true;
      }
    } else if (f && command.id === "ask") this.openAsk(f);
    else if (f && command.id === "scratch") this.openScratch(f);
    else if (f && command.id === "mark") this.openMark(f);
    else if (f && command.id === "chart") {
      const c = this.cursorCell(f);
      const focused = this.part === undefined ? undefined : this.lastParts[this.part];
      const output = focused?.kind === "chart" ? focused.output : c?.output?.blocks?.find(block => block.output.vega || block.output.plotly)?.output ?? c?.output;
      if (c && this.live.inspect(output)) this.note = "";
      else this.note = "Select a cell with a live chart first, then i.";
    } else if (f && command.id === "activate") this.activate(f);
    else if (f && command.id === "run") {
      const c = this.cursorCell(f);
      if (c) this.startRun(f, [c], cellTitle(f.notebook, c));
      else this.note = "No cell selected.";
    } else if (f && command.id === "error-next") this.step(f, 1, (c) => !!c.error);
    else if (f && command.id === "error-previous") this.step(f, -1, (c) => !!c.error);
    else if (command.id === "follow") {
      this.follow = true;
      this.reveal = true;
    } else if (f && command.id === "down") this.step(f, 1);
    else if (f && command.id === "up") this.step(f, -1);
    else if (command.id === "half-up") this.scrollBy(-Math.max(1, Math.floor(page / 2)));
    else if (command.id === "half-down") this.scrollBy(Math.max(1, Math.floor(page / 2)));
    else if (command.id === "page-up") this.scrollBy(-page);
    else if (command.id === "page-down") this.scrollBy(page);
    else if (command.id === "first") {
      this.move(-Infinity);
      this.cursor = f ? this.cells(f)[0]?.id : undefined;
    } else if (command.id === "last") {
      this.follow = false;
      this.scroll = Number.MAX_SAFE_INTEGER;
      this.cursor = f ? this.cells(f).at(-1)?.id : undefined;
      this.reveal = true;
    }
    this.tui.requestRender();
  }

  private move(by: number): void {
    this.follow = false;
    this.scroll = Math.max(0, by === -Infinity ? 0 : this.scroll + by);
  }

  private focusSource(): void {
    this.widget = undefined;
    this.table = undefined;
    this.dragging = undefined;
    this.live.leave();
    const f = this.current();
    const cell = f && this.cursorCell(f);
    if (!cell) return;
    this.follow = false;
    this.sectionCodeOpen.add(cell.id);
    // The source part may not exist in the old filtered section render; resolve it after rebuilding.
    this.focusedBlock = `${cell.id}:source`;
    this.setCode(cell.id, true);
    this.sourceFocus = true;
    this.part = undefined;
    this.scrollToPart = true;
  }

  // --- drawing --------------------------------------------------------------------------------

  /** `✗ fit.py  running Model fit · agent: 1 changed`, and flush right when last it ran and where the server is. */
  private header(f: Followed, file: string, inner: number): string {
    const editor = this.editors.state;
    if (editor) return truncateToWidth(`Neovim · ${editor.kind}${editor.kind === "python" && f.notebook.cells.has(editor.cellId) && f.notebook.isMarkdown(f.notebook.cells.get(editor.cellId)!) ? " (Python source)" : ""} · ${editor.saving ? "saving" : editor.dirty ? "unsaved" : "saved"}${editor.conflict !== undefined ? " · conflict" : ""}${editor.unavailable ? ` · ${editor.unavailable}` : ""}`, inner);
    const th = this.theme;
    const nb = f.notebook;
    const busy = nb.running() || nb.queued() > 0;
    const errors = nb.errors().length;
    // What runs, by its title, with the spinner; else the kernel's state.
    const run = nb.running();
    const queued = nb.queued();
    const state = run
      ? [th.bold(th.fg("accent", `${spinner(Date.now())} running ${cellTitle(nb, run.cell)}${run.since ? ` ${elapsed(Date.now() - run.since)}` : ""}`)), queued ? th.fg("accent", `${queued} queued`) : "", errors ? th.fg("error", `${errors} error${errors === 1 ? "" : "s"}`) : "", ...lensParts(f)].filter(Boolean).join(" · ")
      : queued && f.connection === "connected" ? [th.fg("accent", `◌ ${queued} queued`), ...lensParts(f)].join(" · ")
        : [...kernelStateParts(f), ...lensParts(f)].join(" · ");
    const dot = th.fg("dim", " · ");
    const working = this.actions.agentBusy?.() === true ? `${dot}${th.fg("accent", "agent working")}` : "";
    const servers = this.actions.servers?.(f) ?? [];
    const changes = [...nb.agentChanges.values()];
    const edited = changes.filter((c) => c.kind === "edited" || c.kind === "moved" || c.kind === "renamed").length;
    const created = changes.filter((c) => c.kind === "created").length;
    const removed = changes.filter((c) => c.kind === "deleted").length;
    const agent = changes.length ? `${dot}${th.fg("accent", `agent: ${[edited ? `${edited} changed` : "", created ? `${created} new` : "", removed ? `${removed} removed` : ""].filter(Boolean).join(" · ")}`)}` : "";
    const prefs = this.preferences.snapshot();
    const context = [this.help ? "help" : this.commandMode(), this.mode === "variables" ? this.varFilter : this.mode === "packages" ? this.packagePane.state.filter : this.filter].filter(Boolean).join(" · ");
    const visibility = [context, prefs.diagnostics !== "all" ? `diagnostics ${prefs.diagnostics === "none" ? "hidden" : prefs.diagnostics}` : "", !prefs.showOutput ? "output hidden" : ""].filter(Boolean).join(" · ");
    const left = `${visibility ? `${th.fg("dim", visibility)}${dot}` : ""}${busy ? `${th.fg("accent", "●")} ` : errors ? `${th.fg("error", "✗")} ` : ""}${th.bold(file)}  ${state}${working}${agent}`;
    const right = th.fg("dim", [this.actions.lastRun?.(f) ?? "", shortWhere(f.attachment.url) ?? "", servers.length ? `server ${servers.join(", ")}` : ""].filter(Boolean).join(" · "));
    const gap = inner - visibleWidth(left) - visibleWidth(right);
    return visibleWidth(right) && gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left;
  }

  /** A scratch run's result, as lines. */
  private resultLines(output: { mimetype: string; data: string }, inner: number): string[] {
    const th = this.theme;
    if (output.mimetype.startsWith("image/")) return [th.fg("dim", "[image]")];
    if (output.mimetype === "text/html") {
      const summary = summarizeOutput({ channel: "output", mimetype: output.mimetype, data: output.data });
      if (summary?.table) return tableLines(summary.table, inner, th, 8);
      return summary?.text ? summary.text.split("\n") : [];
    }
    return output.data ? output.data.split("\n") : [];
  }

  /** What the scratch run printed and returned, newest last. */
  private scratchLines(inner: number): string[] {
    const s = this.scratch;
    if (!s) return [];
    const th = this.theme;
    const lines = [th.fg("accent", `>>> ${truncate(firstLine(s.code), 200)}`)];
    for (const e of s.lines) lines.push(e.stream === "stderr" ? th.fg("warning", e.text) : e.text);
    if (s.running) lines.push(th.fg("dim", `running ${elapsed(Date.now() - s.started)}`));
    else if (s.error) lines.push(s.error === "cancelled" ? th.fg("dim", "cancelled") : th.fg("error", `✗ ${s.error}`));
    else if (s.result && !s.result.success) lines.push(th.fg("error", "✗ failed (the traceback is above)"));
    else if (s.result?.output) lines.push(...this.resultLines(s.result.output, inner));
    return lines.slice(-SCRATCH_ROWS);
  }

  /** The docked prompt, with a scratch run above it: full frame rows. */
  private dockRows(width: number, maxRows: number): string[] {
    const dock = this.dock;
    if (!dock) {
      this.lastDock = 0;
      return [];
    }
    const th = this.theme;
    if (maxRows <= 0) return [];
    // Allocate the focused input/cursor before decoration, previews or notebook body.
    const rendered = dock.render(bodyWidth(width), Number.MAX_SAFE_INTEGER);
    const input = rendered.slice(1, -1);
    const cursor = Math.max(0, input.findIndex(line => line.includes(CURSOR_MARKER)));
    const budget = Math.min(maxRows, Math.max(4, Math.floor(this.tui.terminal.rows / 2)));
    const decoration = Math.min(3, budget - 1);
    const room = Math.max(1, budget - decoration);
    const start = Math.max(0, Math.min(cursor, input.length - room));
    const out = input.slice(start, start + room);
    if (decoration >= 1) out.unshift(rendered[0]!);
    if (decoration >= 2) out.push(rendered.at(-1)!);
    const spare = budget - decoration - Math.min(input.length, room);
    if (dock.kind === "scratch" && this.scratch && spare > 0) out.unshift(...this.scratchLines(bodyWidth(width)).slice(-spare));
    const framed = out.map(line => frameRow(line, width, th));
    if (decoration >= 3) framed.unshift(frameRule(width, th));
    return framed;
  }

  /** Scroll so row `at` shows when asked to, within the rows there are. */
  private place(length: number, at: number | undefined, page: number): void {
    const max = Math.max(0, length - page);
    if (this.reveal && at !== undefined) {
      if (this.scroll === Number.MAX_SAFE_INTEGER) this.scroll = max;
      if (at < this.scroll) this.scroll = at;
      else if (at >= this.scroll + page) this.scroll = at - page + 1;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, max));
    this.reveal = false;
  }

  private whereText(f: Followed): string {
    const servers = this.actions.servers?.(f) ?? [];
    return [f.attachment.path, f.attachment.url, servers.length ? `server ${servers.join(", ")}` : ""].filter(Boolean).join(" · ");
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const th = this.theme;
    const inner = bodyWidth(width);
    const row = (s: string) => frameRow(s, width, th);
    const rule = frameRule(width, th);
    const fit = (text: string, w: number) => truncateToWidth(text, Math.max(1, w), "…", true);
    this.syncConfirmation();
    const f = this.current();
    this.editors.updateCurrent(f);
    const file = basename(f?.attachment.path ?? notebookPath(this.key));
    const out = [this.actions.docked ? dockedBanner(file, width, th, this.actions.docked.focused()) : banner(`Notebook ${file}`, width, th)];
    if (!f && this.dock) this.closeDock();
    if (!f) this.widget = undefined;
    else if (this.widget) this.drivenWidgets(f);
    const height = Math.max(0, this.tui.terminal.rows);
    const dock = this.messageView ? [] : this.dockRows(width, height <= CHROME ? height : height - CHROME);
    this.lastDock = dock.length;
    const transient = this.messageView ? undefined : this.transientMessage();
    const transientRows = messagePreview(transient, inner, Math.max(0, height - CHROME - dock.length));
    this.messageOverflow = !!transient && wrapTextWithAnsi(clean(transient), inner).length > transientRows.length;
    this.lastTransient = transientRows.length;
    if (height < CHROME || (height === CHROME && dock.length)) {
      this.lastPage = 0;
      this.lastRows = []; this.lastDetail = []; this.lastOutline = [];
      if (dock.length) return dock;
      const compact = height === 1 ? [row(this.footer(f, inner))] : [row(file), ...transientRows.map(row)];
      if (height > 1) compact.push(row(this.footer(f, inner)));
      return compact.slice(0, height);
    }
    const page = this.viewport();
    this.lastPage = page;
    if (this.messageView) {
      out.push(row(`${file} · message`), rule);
      const rows = this.messageView.render(inner, page);
      for (let i = 0; i < page; i++) out.push(row(rows[i] ?? ""));
    } else if (this.help) {
      out.push(row(f ? this.header(f, file, inner) : `${file} · help`), rule);
      const rows = this.helpView.render(inner, page, th, width, f ? this.whereText(f) : undefined).map((text): Row => ({ text }));
      this.lastRows = rows;
      for (let i = 0; i < page; i++) out.push(row(rows[i]?.text ?? ""));
    } else if (!f) {
      out.push(row(`${th.bold(file)}  ${th.fg("dim", "No longer followed.")}`), rule);
      const recovery = this.editors.active ? this.editors.render(inner, page) : [];
      for (let i = 0; i < page; i++) out.push(row(recovery[i] ?? ""));
      this.lastRows = [];
      this.lastOutline = [];
      this.lastDetail = [];
    } else if (this.timing) {
      out.push(row(this.header(f, file, inner)), rule);
      const cell = this.cursorCell(f);
      const exact = (at: number | undefined) => at === undefined ? "unknown" : new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23", timeZoneName: "longOffset" }).format(at);
      const rows = cell ? ["Exact timing · local timezone", cellTitle(f.notebook, cell), `Start: ${exact(cell.status === "running" ? cell.runningSince : cell.lastRunStartedAt)}`, `End: ${cell.status === "running" ? "running" : exact(cell.lastRunEndedAt)}`, `Duration: ${cell.status === "running" && cell.runningSince !== undefined ? `${duration(Date.now() - cell.runningSince)} (running)` : cell.lastRunMs !== undefined ? duration(cell.lastRunMs) : "unknown"}`, "T / Esc closes"] : ["No selected cell"];
      this.lastRows = rows.map(text => ({ text }));
      for (let i = 0; i < page; i++) out.push(row(rows[i] ?? ""));
    } else if (this.mode === "packages") {
      out.push(row(this.header(f, file, inner)), rule);
      if (this.packageOwner !== f.notebook) this.openPackages(f);
      const rows = this.packagePane.rows(f.notebook.environment, inner);
      this.packagePane.state.scroll = Math.min(this.packagePane.state.scroll, Math.max(0, rows.length - page));
      this.lastRows = rows;
      for (let i = 0; i < page; i++) out.push(row(rows[this.packagePane.state.scroll + i]?.text ?? ""));
    } else if (this.mode === "variables") {
      out.push(row(this.header(f, file, inner)), rule);
      const nb = f.notebook;
      const list = variableList(nb, this.varFilter, this.varSort);
      if (!this.varCursor || !list.some((v) => v.name === this.varCursor)) this.varCursor = list[0]?.name;
      let built = variableRows(list, nb, th, this.varCursor, inner, this.varFilter);
      const at = this.varCursor !== undefined ? built.index.get(this.varCursor) : undefined;
      this.place(built.rows.length, at, page);
      // Scrolled away from the cursor: it moves to the nearest variable on screen.
      if (at !== undefined && (at < this.scroll || at >= this.scroll + page)) {
        const pick = list[at < this.scroll ? this.scroll : Math.min(list.length - 1, this.scroll + page - 1)];
        if (pick) {
          this.varCursor = pick.name;
          built = variableRows(list, nb, th, this.varCursor, inner, this.varFilter);
        }
      }
      if (this.varDetail && list.length) {
        const selected = list.find(v => v.name === this.varCursor)!;
        const detail = variableDetailRows(selected, nb, inner);
        this.varScroll = Math.min(this.varScroll, Math.max(0, detail.length - page));
        this.lastRows = detail;
        for (let i = 0; i < page; i++) out.push(row(detail[this.varScroll + i]?.text ?? ""));
      } else {
        this.lastRows = built.rows;
        for (let i = 0; i < page; i++) out.push(row(built.rows[this.scroll + i]?.text ?? ""));
      }
    } else {
      out.push(row(this.header(f, file, inner)), rule);
      const nb = f.notebook;
      const cells = this.cells(f);
      const running = nb.running();
      if (this.editors.active) {
        this.follow = false;
        if (this.editors.owns(f) && this.editors.state && nb.cells.has(this.editors.state.cellId)) this.cursor = this.editors.state.cellId;
      }
      // Following: the cursor stays on the running cell, or on the fold that hides it.
      if (this.follow && running) {
        const head = this.filter ? undefined : foldedCells(nb, this.folded).get(running.cell.id);
        const target = head ?? running.cell.id;
        if (cells.some((c) => c.id === target)) this.cursor = target;
      }
      if (!this.cursor || !cells.some((c) => c.id === this.cursor)) this.cursor = cells[0]?.id;
      // The outline and the detail side by side; narrower, a few outline rows around the cursor above the detail.
      const split = width >= SPLIT_MIN;
      const lw = split ? outlineWidth(width) : inner;
      const dw = split ? inner - lw - SEPARATOR_WIDTH : inner;
      const shows = split ? "both" : "stacked";
      // Transient messages may leave only a row or two: omit the stacked outline,
      // rather than giving the detail a negative rectangle or pushing the footer offscreen.
      const oh = split ? page : page < 3 ? 0 : stackedOutlineRows(page);
      const detailTop = split || !oh ? 0 : oh + 1;
      const dh = split ? page : page - detailTop;
      this.panes = { lw, detailLeft: split ? CONTENT_LEFT + lw + SEPARATOR_WIDTH : CONTENT_LEFT, detailTop, outlineHeight: oh, shows };
      const outline = (): ReturnType<typeof outlineRows> => outlineRows(nb, th as PaneTheme, Date.now(), { cursor: this.cursor, folded: this.folded, filter: this.filter, width: lw });
      let built = outline();
      const at = this.cursor !== undefined ? built.cellRows.get(this.cursor) : undefined;
      if (!split) {
        // Stacked: the cursor's neighbours, the cursor in the middle.
        const centre = this.follow && running && built.running !== undefined ? built.running : at;
        if (centre !== undefined) this.scroll = Math.max(0, Math.min(centre - Math.floor((oh - 1) / 2), built.rows.length - oh));
        this.reveal = false;
      } else if (this.follow && running && built.running !== undefined) {
        this.scroll = Math.min(Math.max(0, built.rows.length - page), Math.max(0, built.running - Math.floor(page / 3)));
        this.reveal = false;
      } else this.place(built.rows.length, at, page);
      // Scrolled away from the cursor: it moves to the nearest cell on screen.
      if (split && at !== undefined && !this.follow && !this.widget && !this.editors.active && (at < this.scroll || at >= this.scroll + page)) {
        const visible = cells.filter((c) => { const r = built.cellRows.get(c.id); return r !== undefined && r >= this.scroll && r < this.scroll + page; });
        const pick = at < this.scroll ? visible[0] : visible.at(-1);
        if (pick) {
          this.cursor = pick.id;
          built = outline();
        }
      }
      this.lastOutline = built.rows;
      // The detail: the cursor's cell (or its section), at its own scroll.
      this.live.beginFrame();
      const cell = cells.find((c) => c.id === this.cursor);
      let detail: Row[] = [];
      if (cell) {
        this.syncPart();
        // A table the view drives: its page, cursor and selection; a cell that needs its rows asks for them once.
        const tableSource = (c: Cell, output?: CellOutput) => {
          const t = this.tableFor(f, c, output);
          if (!t) return undefined;
          const s = t.session;
          if (c.id === cell.id && s.needsFetch() && this.actions.table) void s.refresh(f, this.actions.table);
          const focused = this.table?.cell === c.id && this.table.objectId === t.data.objectId;
          // Match tableGrid's selection marker, not the removed detail gutter.
          const rowSelect = t.data.selection === "single" || t.data.selection === "multi";
          if (focused) s.ensureVisible(dw - (rowSelect ? 5 : 0));
          const picked = s.selection(nb);
          const cells = new Set<string>();
          const rows = new Set<string>();
          for (const v of picked) {
            if (typeof v === "object" && v !== null) cells.add(`${String((v as { rowId?: unknown }).rowId)}\0${String((v as { columnName?: unknown }).columnName)}`);
            else rows.add(String(v));
          }
          const status = [s.query ? `search "${s.query}"` : "", s.filters.length ? `${s.filters.length} filter${s.filters.length === 1 ? "" : "s"}` : "", picked.length ? `${picked.length} selected` : "", s.loading ? "loading…" : "", s.error ?? ""].filter(Boolean).join(" · ");
          const sorted = s.sort.map((x) => `sorted ${x.by}`).join(", ");
          const note = [sorted, s.filters.length || s.query ? "filtered" : ""].filter(Boolean).join(" · ");
          return {
            data: t.data,
            ...(note ? { note } : {}),
            render: {
              focused, cursorRow: s.row, cursorCol: s.col, colOffset: s.colOffset, selected: rows, selectedCells: cells, sort: s.sort,
              ...(s.summariesOn && s.summaries ? { summaries: s.summaries } : {}),
              ...(status ? { status } : {}),
              rowIdOf: (i: number) => s.rowId(i), firstRow: s.page * s.pageSize,
              ...(t.data.totalRows !== undefined ? { totalRows: t.data.totalRows } : {}),
            },
          };
        };
        const tableCard = (c: Cell, output?: CellOutput): string[] | undefined => {
          const t = this.tableFor(f, c, output);
          const card = t?.session.card;
          if (!t || !card || this.table?.cell !== c.id || this.table.objectId !== t.data.objectId) return undefined;
          const lines = card.kind === "row"
            ? rowCard(t.data, card.index, dw, th as PaneTheme, t.session.page * t.session.pageSize + card.index)
            : columnCard(t.data, card.column, t.session.summaries, card.top, dw, th as PaneTheme);
          return lines;
        };
        const d = detailRows(nb, th, Date.now(), {
          cell, width: dw, codeOpen: this.codeShown(cell.id), diff: this.diffs.has(cell.id), section: this.section,
          sectionCodeOpen: this.sectionCodeOpen,
          syntax: this.actions.syntax, theme: this.theme as SyntaxTheme,
          diagnostics: this.preferences.snapshot().diagnostics,
          showOutput: this.preferences.snapshot().showOutput,
          lineNumbers: this.preferences.snapshot().lineNumbers,
          tabstop: this.preferences.snapshot().editor.options.tabstop,
          codeOffsets: this.codeOffsets,
          onReady: this.renderReady,
          diagramRows: this.diagramRows,
          table: tableSource, tableCard, partFocus: this.part,
          ...(this.editors.owns(f) && this.editors.state ? { inlineEditor: {
            cellId: this.editors.state.cellId, kind: this.editors.state.kind,
            rows: (width: number, _row: number) => this.editors.render(width, Math.max(1, this.section ? Math.min(dh - 1, Math.max(4, Math.floor(dh * 0.6))) : dh - 1)).map((text, editorRow) => ({ text, editorRow })),
          } } : {}),
          ...(this.widget ? { widgetFocus: this.widget } : {}),
          imageRows: dh - 1, vega: this.vega, plotly: this.plotly,
          ...(this.actions.liveCharts === false ? {} : { live: this.live }),
          onVega: this.renderReady,
        });
        detail = d.rows;
        this.lastParts = d.parts;
        if (this.sourceFocus) {
          const index = d.parts.findIndex(p => p.cell === cell.id && p.kind === "code");
          if (index >= 0) this.part = index;
          this.sourceFocus = false;
        }
        for (const r of detail) if (r.blockId && !this.codeOffsets.has(r.blockId)) this.codeOffsets.set(r.blockId, { offset: 0 });
        if (this.part !== undefined && this.part >= d.parts.length) this.part = d.parts.length ? d.parts.length - 1 : undefined;
        const key = `${cell.id}\0${this.section}`;
        if (key !== this.detailKey) {
          this.detailKey = key;
          this.detailScroll = this.section && d.focusRow !== undefined ? Math.max(0, d.focusRow - 2) : 0;
        }
        if (this.scrollToPart) {
          const at = this.part !== undefined ? d.parts[this.part] : undefined;
          if (at) this.detailScroll = Math.max(0, at.row - 1);
          this.scrollToPart = false;
        }
        const focused = this.widget ? d.widgetRows.get(`${this.widget.cell}\0${this.widget.index}`) : undefined;
        if (focused !== undefined) {
          if (focused < this.detailScroll) this.detailScroll = focused;
          else if (focused >= this.detailScroll + dh) this.detailScroll = focused - dh + 1;
        }
        if (this.editors.active) {
          const first = detail.findIndex(r => r.editorRow === 0);
          if (first >= 0) this.detailScroll = Math.max(0, first - 1);
          else {
            detail = [...this.editors.render(dw, Math.max(1, dh)).map((text, editorRow) => ({ text, editorRow })), ...detail];
            this.detailScroll = 0;
          }
        }
        this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, detail.length - dh)));
      }
      if (!cell && this.editors.active) {
        detail = this.editors.render(dw, Math.max(1, dh)).map((text, editorRow) => ({ text, editorRow }));
        this.detailScroll = 0;
      }
      this.lastDetail = detail;
      // An image draws only when its whole block is on screen; otherwise a note stands in for it.
      const visible = (i: number): boolean => {
        const r = detail[i];
        if (!r?.image) return true;
        const start = i - r.image.index;
        return start >= this.detailScroll && start + r.image.height <= this.detailScroll + dh;
      };
      const detailText = (i: number): string => {
        const r = detail[i];
        if (!r?.image || visible(i)) return r?.text ?? "";
        return r.image.index === 0 ? r.image.alt : r.text;
      };
      for (let i = 0; i < page; i++) {
        const left = i < oh ? built.rows[this.scroll + i]?.text ?? (this.filter && !cells.length && i === 0 ? th.fg("dim", `No cell matches "${this.filter}".`) : "") : "";
        if (!split && oh > 0 && i === oh) { out.push(row(th.fg("dim", "─".repeat(inner)))); continue; }
        if (!split && i < oh) { out.push(row(left)); continue; }
        const di = this.detailScroll + i - detailTop;
        const r = detail[di];
        if (r?.image?.live && r.image.index === 0 && visible(di)) this.live.rects.push({ top: out.length, left: this.panes.detailLeft, geometry: r.image.live.geometry, output: r.image.live.output });
        out.push(row(split ? `${fit(left, lw)}${th.fg("dim", " │ ")}${fit(detailText(di), dw)}` : detailText(di)));
      }
      this.live.endFrame();
    }
    out.push(...dock);
    out.push(...transientRows.map(text => row(th.fg("warning", text))));
    out.push(rule);
    out.push(row(this.footer(f, inner)));
    out.push(bottom(width, th));
    // The images this frame draws stay when the painter wipes the transcript's from under the view.
    const ids = new Set<number>();
    for (const line of out) if (line.includes("\x1b_G")) for (const m of line.matchAll(/\x1b_G([^;\x1b]*)/gu)) {
      const id = /(?:^|,)i=(\d+)(?:,|$)/u.exec(m[1]!)?.[1];
      if (id !== undefined) ids.add(Number(id));
    }
    if (!this.actions.docked) Painter.for(this.tui)?.setViewImages(ids);
    return out;
  }

  private async confirm(question: string, choices: readonly string[]): Promise<string | undefined> {
    this.packageConfirmation = true;
    try { return await this.actions.confirm?.(question, choices); }
    finally { this.packageConfirmation = false; }
  }

  private commandMode(): CommandMode {
    return this.editors.active ? "editor" : this.table ? "table" : this.widget ? "widget" : this.live?.inspecting ? "chart" : this.mode === "cells" ? "notebook" : this.mode;
  }

  private openHelp(): void {
    this.helpView.open(this.commandMode());
    this.help = true;
    this.note = undefined;
  }

  private transientMessage(includeHidden = false): string | undefined {
    if (this.help && !includeHidden) return undefined;
    if (this.armedRun) return `${commandKey(this.armedRun.what === "all" ? "run-all" : "run-stale")} again to run ${this.armedRun.what} cells`;
    if (this.armedTarget) return `${commandKey("interrupt")} again to interrupt`;
    if (this.armedStop) return `${commandKey("stop")} again to stop the server`;
    return this.note;
  }

  private footer(f: Followed | undefined, inner: number): string {
    if (this.messageView) {
      const tokens = ["Esc/F8 back", "j/k scroll", `${this.messageView.state.scroll + 1}`];
      const kept: string[] = [];
      for (const token of tokens) if (visibleWidth([...kept, token].join(" · ")) <= inner) kept.push(token);
      return this.theme.fg("dim", kept.join(" · "));
    }
    if (this.messageOverflow && !this.lastTransient) return this.theme.fg("dim", inner >= 10 ? "F8 message" : inner >= 2 ? "F8" : "");
    // Dock owns its focused prompt hints; never replace those with a key inventory.
    if (this.dock) return this.theme.fg("dim", "esc closes the prompt");
    const mode = this.commandMode();
    if (this.help) return this.theme.fg("dim", footerTokens(inner, "help-search", `${this.helpView.state.scroll + 1}`, mode === "editor"));
    const focused = this.part === undefined ? undefined : this.lastParts[this.part];
    const cell = f ? this.cursorCell(f) : undefined;
    const contextual = focused?.kind ?? (cell?.output?.widgets?.length ? "widgets" : cell?.output?.table ? "table" : this.live.rects.length ? "chart" : undefined);
    const busy = !!f && (!!f.notebook.running() || f.notebook.queued() > 0);
    const primary = mode === "editor" ? "editor-f2" : mode === "table" ? "table-row" : mode === "widget" ? "widget-type" : mode === "chart" ? "chart-drag" : mode === "variables" ? "var-detail" : mode === "packages" ? "pkg-detail" : contextual === "table" ? "table" : contextual === "widgets" ? "widget" : contextual === "chart" ? "chart" : this.actions.run && cell && f && !f.notebook.isMarkdown(cell) ? busy ? "interrupt" : "run" : "activate";
    const cells = f ? this.cells(f) : [];
    const at = cells.findIndex(cell => cell.id === this.cursor);
    const position = mode === "notebook" && at >= 0 ? `${at + 1}/${cells.length}` : undefined;
    return this.theme.fg("dim", footerTokens(inner, primary, position, mode === "editor"));
  }

  /** A theme change or resize: the terminal may have dropped image data with the redraw, so live charts upload their frames again. */
  invalidate(): void {
    this.actions.syntax?.invalidate();
    this.live.refresh();
  }

  /** Actual close negotiates; a dock transfer only detaches this view. */
  async requestClose(): Promise<boolean> {
    try { return await this.editors.close(); }
    catch (error) { this.note = message(error); this.renderReady(); return false; }
  }

  private close(transfer = false): void {
    if (this.closed) return;
    const finish = () => { this.dispose(); this.done(); };
    if (transfer || !this.editors.active) finish();
    else void this.requestClose().then(ok => { if (ok) finish(); });
  }

  /** A live chart takes the mouse over it; elsewhere the wheel scrolls the pane under it, a click selects, a double click opens the code. */
  /** The widget under the pointer in the detail, and the column inside its line (after the bar and its glyph). */
  private widgetAt(event: TuiMouseEvent): { f: Followed; cell: Cell; w: Widget; index: number; col: number } | undefined {
    const f = this.current();
    const line = event.y - ROWS_TOP;
    if (!f || this.mode !== "cells" || this.paneAt(event.x, line) !== "detail") return undefined;
    const r = this.lastDetail[this.detailScroll + line - this.panes.detailTop];
    if (!r?.widget) return undefined;
    const cell = f.notebook.cells.get(r.widget.cell);
    const w = cell?.output?.widgets?.[r.widget.index];
    return cell && w ? { f, cell, w, index: r.widget.index, col: event.x - this.panes.detailLeft - WIDGET_TEXT } : undefined;
  }

  /** A click (or a drag) on a widget: focuses it, and does what the click means at that place on its control. */
  private clickWidget(at: { f: Followed; cell: Cell; w: Widget; index: number; col: number }, dragging = false): boolean {
    const { f, cell, w, index } = at;
    if (!this.actions.setWidget || f.connection !== "connected") return false;
    const sub = this.widget?.cell === cell.id && this.widget.index === index ? this.widget.sub : 0;
    this.widget = { cell: cell.id, index, sub };
    if (!this.section) this.cursor = cell.id;
    this.follow = false;
    const hit = widgetHit(w, widgetValue(f.notebook, w), at.col);
    if (!hit) return false;
    if (w.disabled) { this.note = "This widget is disabled."; return false; }
    if ("type" in hit) { if (!dragging) this.openValue(f, cell, w); return false; }
    if ("value" in hit) {
      if (hit.sub !== undefined) this.widget.sub = hit.sub;
      this.actions.setWidget(f, cell, w, hit.value);
      return hit.drag === true;
    }
    if (dragging) return false;
    const next = nextValue(w, widgetValue(f.notebook, w), hit.action, this.widget.sub);
    if (next) {
      this.widget.sub = next.sub;
      if (next.send) this.actions.setWidget(f, cell, w, next.value);
    }
    return false;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.packageConfirmation || this.tui.terminal.rows < CHROME) return { handled: true };
    if (this.messageView) {
      if (event.type === "wheel") { this.messageView.wheel(event.wheelDelta ?? 0); this.tui.requestRender(); }
      return { handled: true };
    }
    if (this.help) {
      if (event.type === "wheel") { this.helpView.wheel(event.wheelDelta ?? 0); this.tui.requestRender(); }
      return { handled: true };
    }
    if (this.editors.active) return { handled: true };
    if (this.mode === "packages" || (this.mode === "variables" && this.varDetail)) {
      if (event.type === "wheel" && !this.help && !this.dock) { this.scrollBy(event.wheelDelta ?? 0); this.tui.requestRender(); }
      return { handled: true };
    }
    if (this.timing) return { handled: true };
    const live = this.live.mouse(event);
    if (live) return live;
    if (this.closed) return undefined;
    // A slider dragged with the mouse follows it until the button goes up.
    if (this.dragging && (event.type === "drag" || event.type === "release")) {
      const at = this.widgetAt({ ...event, y: Math.max(ROWS_TOP, event.y) });
      const f = this.current();
      const cell = f?.notebook.cells.get(this.dragging.cell);
      const w = cell?.output?.widgets?.[this.dragging.index];
      if (f && cell && w) this.clickWidget({ f, cell, w, index: this.dragging.index, col: at?.cell.id === cell.id && at.index === this.dragging.index ? at.col : event.x - this.panes.detailLeft - WIDGET_TEXT }, true);
      if (event.type === "release") this.dragging = undefined;
      this.tui.requestRender();
      return { handled: true };
    }
    if (event.type === "wheel") {
      if (this.help || this.dock) return { handled: true };
      const by = event.wheelDelta ?? 0;
      const pane = this.mode === "cells" ? this.paneAt(event.x, event.y - ROWS_TOP) : undefined;
      const f = this.current();
      // Over the focused widget the wheel changes it (up: more); elsewhere it scrolls.
      const over = this.widgetAt(event);
      if (over && by && this.widget?.cell === over.cell.id && this.widget.index === over.index && this.actions.setWidget && !over.w.disabled) {
        const next = nextValue(over.w, widgetValue(over.f.notebook, over.w), by < 0 ? "inc" : "dec", this.widget.sub);
        if (next?.send) this.actions.setWidget(over.f, over.cell, over.w, next.value);
        this.tui.requestRender();
        return { handled: true };
      }
      if (pane === "detail") this.detailScroll = Math.max(0, this.detailScroll + by);
      // The stacked outline is centred on the cursor: the wheel moves the cursor.
      else if (pane === "outline" && this.panes.shows === "stacked") { if (f && by) this.step(f, by > 0 ? 1 : -1); }
      else this.move(by);
      this.tui.requestRender();
      return { handled: true };
    }
    if (event.button !== "left" || event.y < ROWS_TOP || event.y >= ROWS_TOP + this.lastPage) return undefined;
    if (event.type === "press") {
      // A press on a slider's bar sets it there and drags it from then on.
      const at = this.dock || this.help ? undefined : this.widgetAt(event);
      if (at && at.w.kind.endsWith("slider") && this.clickWidget(at)) {
        this.dragging = { cell: at.cell.id, index: at.index };
        this.tui.requestRender();
        return { handled: true, capture: true };
      }
      // Pi turns a press and release into a click only for the component that took the press.
      return { handled: true, render: false };
    }
    if (event.type !== "click") return undefined;
    const f = this.current();
    if (!f || this.dock) return { handled: true };
    const line = event.y - ROWS_TOP;
    const twice = (event.clickCount ?? 1) >= 2;
    if (this.mode === "variables") {
      const r = this.lastRows[this.scroll + line];
      if (r?.variable) {
        const again = this.varCursor === r.variable;
        this.varCursor = r.variable;
        if (again || twice) this.activate(f);
      }
    } else if (this.paneAt(event.x, line) === "detail") {
      const r = this.lastDetail[this.detailScroll + line - this.panes.detailTop];
      this.focusedBlock = r?.blockId;
      if (this.table && r?.tableRow !== undefined) {
        const cellId = r.part === undefined ? this.table.cell : this.lastParts[r.part]?.cell ?? this.table.cell;
        const t = f.notebook.cells.get(cellId);
        if (r.tableObjectId) this.table = { cell: cellId, objectId: r.tableObjectId };
        this.part = r.part;
        const tf = t ? this.tableFor(f, t, r.output ?? r.tableObjectId) : undefined;
        if (tf) { tf.session.row = r.tableRow; tf.session.card = undefined; }
      } else if (r?.part !== undefined && !r.widget && !r.code) {
        this.part = r.part;
        if (twice) this.activate(f);
      } else if (r?.widget && this.actions.setWidget && f.connection === "connected") {
        this.part = r.part;
        const at = this.widgetAt(event);
        // A slider was set by its press already.
        if (at && !(at.w.kind.endsWith("slider") && widgetHit(at.w, widgetValue(f.notebook, at.w), at.col))) this.clickWidget(at);
        else if (at) this.widget = { cell: at.cell.id, index: at.index, sub: this.widget?.sub ?? 0 };
      } else if (r?.code) {
        const c = this.cursorCell(f);
        if (r.part !== undefined) this.part = r.part;
        const id = this.lastParts[r.part ?? -1]?.cell ?? c?.id;
        const target = id ? f.notebook.cells.get(id) : undefined;
        if (target && (!r.blockId || r.blockId === `${id}:source`)) this.openInlineEditor(f, target, "python");
      }
    } else if (this.paneAt(event.x, line) === "outline") {
      const r = this.lastOutline[this.scroll + line];
      if (r?.cell) {
        const again = this.cursor === r.cell;
        this.cursor = r.cell;
        this.follow = false;
        this.widget = undefined;
        this.table = undefined;
        if (again || twice) this.activate(f);
      }
    }
    this.tui.requestRender();
    return { handled: true };
  }

  dispose(): void {
    if (!this.closed && !this.actions.docked) Painter.for(this.tui)?.setExclusive(false);
    this.closed = true;
    this.unbindEditor?.();
    if (this.ownsEditors) this.editors.dispose();
    this.packagePane.dispose();
    clearInterval(this.timer);
    this.scratch?.abort.abort();
    this.dock?.dispose();
    this.dock = undefined;
    this.live.dispose();
  }
}
