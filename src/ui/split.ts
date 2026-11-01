// The notebook view docked beside the chat. Pi's fullscreen layout root is re-rooted into
// [chat, divider, notebook] (split-layout.ts, copied from pi-sidebar), so the chat reflows into its
// half and keyboard focus moves between the halves. One right-hand slot is shared with pi-sidebar
// through the event `pi-plugins.side-panel.v1`: opening one closes the other.
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult, isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import type { FrameTheme } from "../frame.ts";
import { type LayoutTui, SplitLayout, canSplit, dividerLines, muteEditorBorders } from "./split-layout.ts";
import type { DockedHost, NotebookView, ViewState } from "./view.js";

export const SIDE_PANEL_CHANNEL = "pi-plugins.side-panel.v1";
export const SIDE_PANEL_TOGGLE_CHANNEL = "pi-plugins.side-panel-toggle.v1";
export const SIDE_PANEL_ID = "pi-marimo";
interface ToggleRequest { claim(): void }
export const FOCUS_KEY = "ctrl+]";
/** Sidebar's toggle keys (PI_SIDEBAR_KEYS, default ctrl+'), which toggle the docked notebook while one is active. */
export function toggleKeys(raw: string | undefined = process.env.PI_SIDEBAR_KEYS): string[] {
  const keys = (raw ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  return keys.length ? keys : ["ctrl+'"];
}

export interface SplitOptions {
  /** The notebook ctrl+' docks: the one this session uses now, if any. */
  active?(): string | undefined;
  /** Something else holds the screen (the full-screen notebook view): ctrl+' is left alone. */
  busy?(): boolean;
  toggleKeys?: string[];
}
export const DEFAULT_SPLIT_RATIO = 0.55;
const HERDR_BLOCKED = "herdr:blocked";
const PROBE = "pi-marimo-split-probe";
/** The reserved keys pi-sidebar's Herdr plugin sends for prefix+h/j/k/l (pi-sidebar/src/nav.ts). */
const NAV_KEYS = { left: "ctrl+alt+shift+h", down: "ctrl+alt+shift+j", up: "ctrl+alt+shift+k", right: "ctrl+alt+shift+l" } as const;
type Direction = keyof typeof NAV_KEYS;

export type { DockedHost };
export type SplitTui = TUI & LayoutTui & { getFocusedComponent?(): Component | null };
export type MakeDockedView = (tui: SplitTui, theme: FrameTheme, key: string, host: DockedHost, close: () => void, state?: ViewState) => NotebookView;

/** A normal Herdr pane move from this pane (copied from pi-sidebar/src/nav.ts). */
function herdrFocus(direction: Direction, env: NodeJS.ProcessEnv = process.env): void {
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !pane) return;
  execFile(env.HERDR_BIN_PATH || "herdr", ["pane", "focus", "--direction", direction, "--pane", pane], { timeout: 5000 }, () => {});
}

/** The split's panel entry: swapping notebooks swaps `view` without remounting. */
class PanelHost implements Component {
  constructor(private readonly locked: () => boolean) {}
  view: NotebookView | undefined;
  render(width: number): string[] {
    return this.view?.render(width) ?? [];
  }
  invalidate(): void {
    this.view?.invalidate?.();
  }
  handleInput(data: string): void {
    this.view?.handleInput(data);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.locked() ? { handled: true } : this.view?.handleMouse(event);
  }
}

export class NotebookSplit {
  private tui: SplitTui | undefined;
  private theme: FrameTheme | undefined;
  private layout: SplitLayout | undefined;
  private view: NotebookView | undefined;
  private readonly host = new PanelHost(() => this.prompts > 0 || this.blocked > 0);
  private lastNotebookFocus = false;
  private releaseFocus: (() => void) | undefined;
  private mainFocus: Component | null = null;
  private ratio = DEFAULT_SPLIT_RATIO;
  private blocked = 0;
  private prompts = 0;
  private reservedPrompt = false;
  private promptKind: string | undefined;
  private restoreNotebookFocus = false;
  private otherPanel: string | undefined;
  /** The user closed the split since their last message: auto-docking stays away. */
  private suppressed = false;
  private release: (() => void) | undefined;
  private ctx: ExtensionContext | undefined;
  /** Where each notebook's docked view was when it closed, so docking it again comes back there. */
  private readonly states = new Map<string, ViewState>();

  constructor(private readonly pi: ExtensionAPI, private readonly make: MakeDockedView, private readonly options: SplitOptions = {}) {
    pi.on("ui_prompt_start" as never, ((event: { kind?: string }) => {
      if (!this.prompts && !this.blocked) this.restoreNotebookFocus = this.lastNotebookFocus;
      if (this.prompts++ === 0) {
        this.promptKind = event?.kind;
        this.reservedPrompt = ["select", "confirm", "input", "editor"].includes(this.promptKind ?? "")
          || (this.promptKind === "custom" && this.blocked > 0);
        // Pi has already cleared the view's focused flag. Keep the last split-half
        // focus independently of dialog focus and editor restoration.
      }
      this.render();
    }) as never);
    pi.on("ui_prompt_end" as never, (() => {
      this.prompts = Math.max(0, this.prompts - 1);
      if (this.prompts === 0) {
        this.reservedPrompt = false;
        this.promptKind = undefined;
        this.restoreFocus();
      }
      this.render();
    }) as never);
    pi.events?.on?.(HERDR_BLOCKED, (data: unknown) => {
      const active = (data as { active?: unknown } | undefined)?.active === true;
      if (active && !this.prompts && !this.blocked) this.restoreNotebookFocus = this.lastNotebookFocus;
      this.blocked = Math.max(0, this.blocked + (active ? 1 : -1));
      // A custom question can publish blocked before OR after the queued start.
      // Latch until prompt_end: blocked clears before that event on completion.
      // Pi's custom event has no tool identity; identical blocked custom UIs
      // cannot be distinguished here from ask-user-question.
      if (active && this.promptKind === "custom") this.reservedPrompt = true;
      if (!this.blocked && !this.prompts) this.restoreFocus();
      this.render();
    });
    pi.events?.on?.(SIDE_PANEL_CHANNEL, (data: unknown) => {
      const d = data as { id?: unknown; open?: unknown } | undefined;
      if (typeof d?.id !== "string" || d.id === SIDE_PANEL_ID) return;
      if (d.open === true) {
        this.otherPanel = d.id;
        if (this.isOpen) this.close();
      } else if (this.otherPanel === d.id) this.otherPanel = undefined;
    });
    pi.events?.on?.(SIDE_PANEL_TOGGLE_CHANNEL, (data: unknown) => {
      const request = data as Partial<ToggleRequest> | undefined;
      if (typeof request?.claim === "function" && this.toggle()?.consume) request.claim();
    });
    pi.on("input", ((e: { source?: string }) => { if (e.source === "interactive") this.suppressed = false; }) as never);
  }

  get isOpen(): boolean {
    return !!this.layout?.mounted;
  }
  get key(): string | undefined {
    return this.view?.notebook;
  }
  get collapsed(): boolean {
    // Native and blocked custom questions retain the notebook. Unknown/custom
    // fullscreen UIs without a blocked signal still own the whole screen.
    return this.prompts > 0 ? !this.reservedPrompt : this.blocked > 0;
  }
  get focused(): boolean {
    return !!this.view && this.tui?.getFocusedComponent?.() === this.view;
  }
  get otherPanelOpen(): boolean {
    return !!this.otherPanel;
  }

  private restoreFocus(): void {
    if (this.prompts || this.blocked) return;
    const restore = this.restoreNotebookFocus;
    this.restoreNotebookFocus = false;
    // Pi restores its editor first. Do not steal another dialog's focus.
    if (restore && this.tui?.getFocusedComponent?.() === this.mainFocus) this.focusView();
  }

  private trackFocus(tui: SplitTui): void {
    if (this.releaseFocus) return;
    const original = tui.setFocus;
    const own = Object.prototype.hasOwnProperty.call(tui, "setFocus");
    const split = this;
    const wrapped: SplitTui["setFocus"] = function (this: SplitTui, component) {
      original.call(this, component);
      if (split.isOpen && !split.prompts && !split.blocked) {
        const focused = tui.getFocusedComponent?.();
        if (focused === split.view) split.lastNotebookFocus = true;
        else if (focused === split.mainFocus) split.lastNotebookFocus = false;
      }
    };
    tui.setFocus = wrapped;
    this.releaseFocus = () => {
      if (tui.setFocus !== wrapped) return;
      if (own) tui.setFocus = original;
      else delete (tui as Partial<SplitTui>).setFocus;
    };
  }

  private render(): void {
    if (this.isOpen) this.tui?.requestRender();
  }

  private probe(ctx: ExtensionContext): SplitTui | undefined {
    let tui: SplitTui | undefined;
    try {
      ctx.ui.setWidget(PROBE, ((t: unknown, theme: FrameTheme) => {
        tui = t as SplitTui;
        this.theme = theme;
        return { render: () => [], invalidate() {} };
      }) as never);
      ctx.ui.setWidget(PROBE, undefined);
    } catch {
      return undefined;
    }
    return tui;
  }

  /** Docks `key` beside the chat (or swaps the notebook when already docked); false when it cannot. */
  open(ctx: ExtensionContext, key: string, o: { focus: boolean; state?: ViewState; quiet?: boolean }): boolean {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      if (!o.quiet) ctx.ui.notify("marimo: docking needs Pi's interactive terminal UI.", "warning");
      return false;
    }
    if (this.view?.editing && this.key !== key) {
      const previous = this.view;
      void previous.requestClose().then(ok => { if (ok && this.view === previous) this.open(ctx, key, o); });
      return true;
    }
    const tui = this.probe(ctx);
    const theme = this.theme;
    if (!tui || !theme || !canSplit(tui)) {
      if (!o.quiet) ctx.ui.notify('marimo: docking beside the chat needs Pi\'s fullscreen mode (set "tuiMode": "fullscreen" in settings).', "warning");
      return false;
    }
    if (tui !== this.tui) {
      this.close();
      this.tui = tui;
      this.layout = new SplitLayout(tui, this.host, {
        ratio: () => this.ratio,
        prompt: () => this.reservedPrompt,
        locked: () => this.prompts > 0 || this.blocked > 0,
        setRatio: (_orientation, ratio) => { this.ratio = ratio ?? DEFAULT_SPLIT_RATIO; },
        minColumns: 0,
        collapsed: () => this.collapsed,
        focused: () => this.focused,
        focusHalf: (half) => (half === "sidebar" ? this.focusView() : this.focusMain()),
        divider: (orientation, focused, width, length) => dividerLines(orientation, width, (text) => theme.fg("borderAccent", text), {
          sidebar: focused, length, pointer: (text) => theme.bold(theme.fg("accent", text)),
        }),
      });
    }
    const wasOpen = this.isOpen;
    const hadFocus = this.focused;
    const old = this.view;
    if (!wasOpen) {
      this.mainFocus = tui.getFocusedComponent?.() ?? null;
      // Before mounting, so Sidebar unmounts first.
      this.pi.events?.emit?.(SIDE_PANEL_CHANNEL, { id: SIDE_PANEL_ID, open: true });
    }
    const host: DockedHost = { focused: () => this.focused, focusMain: () => this.focusMain() };
    this.view = this.make(tui, theme, key, host, () => this.closeByUser(), o.state ?? this.states.get(key));
    this.host.view = this.view;
    this.view.focused = false;
    this.trackFocus(tui);
    old?.dispose();
    if (!this.layout!.mount()) {
      this.view.dispose();
      this.host.view = undefined;
      this.view = undefined;
      if (!wasOpen) this.pi.events?.emit?.(SIDE_PANEL_CHANNEL, { id: SIDE_PANEL_ID, open: false });
      return false;
    }
    if (o.focus || hadFocus) this.focusView();
    else tui.requestRender();
    return true;
  }

  /** Docks without taking focus, when nothing else holds the slot and the user has not just closed it. */
  autoOpen(ctx: ExtensionContext, key: string): void {
    if (this.isOpen || this.suppressed || this.otherPanel) return;
    this.open(ctx, key, { focus: false, quiet: true });
  }

  focusView(): void {
    const tui = this.tui;
    const view = this.view;
    if (!tui || !view || !this.isOpen || this.prompts > 0 || this.blocked > 0) return;
    const current = tui.getFocusedComponent?.() ?? null;
    if (current && current !== view) this.mainFocus = current;
    tui.setFocus(view as never);
    view.focused = true;
    // The chat's editor borders turn muted while the notebook has focus.
    muteEditorBorders(this.mainFocus, () => {
      const theme = this.theme;
      return theme && this.isOpen && this.focused && !this.collapsed ? (text) => theme.fg("borderMuted", text) : undefined;
    });
    tui.requestRender();
  }

  focusMain(): void {
    const tui = this.tui;
    if (!tui) return;
    if (this.focused && this.mainFocus) {
      if (this.view) this.view.focused = false;
      tui.setFocus(this.mainFocus as never);
    }
    tui.requestRender();
  }

  close(transfer = false): void {
    if (!transfer && this.view?.editing) {
      const previous = this.view;
      void previous.requestClose().then(ok => { if (ok && this.view === previous) this.close(true); });
      return;
    }
    this.releaseFocus?.();
    this.releaseFocus = undefined;
    this.lastNotebookFocus = false;
    this.restoreNotebookFocus = false;
    if (!this.layout || !this.layout.mounted) {
      this.view?.dispose();
      this.host.view = undefined;
      this.view = undefined;
      return;
    }
    const had = this.focused;
    if (this.view) this.states.set(this.view.notebook, this.view.snapshot());
    this.layout.unmount();
    this.view?.dispose();
    this.host.view = undefined;
    this.view = undefined;
    if (had && this.mainFocus) this.tui?.setFocus(this.mainFocus as never);
    this.tui?.requestRender();
    this.pi.events?.emit?.(SIDE_PANEL_CHANNEL, { id: SIDE_PANEL_ID, open: false });
  }

  closeByUser(): void {
    this.suppressed = true;
    this.close();
  }

  /**
   * ctrl+' (Sidebar's key): closes the docked notebook, or docks the active one when neither it nor
   * Sidebar is open. With no active notebook, or Sidebar open, the key is Sidebar's.
   */
  private toggle(): { consume: true } | undefined {
    if (this.collapsed || this.prompts > 0 || !this.ctx) return undefined;
    if (this.isOpen) {
      this.closeByUser();
      return { consume: true };
    }
    if (this.otherPanel || this.options.busy?.()) return undefined;
    const key = this.options.active?.();
    if (!key) return undefined;
    return this.open(this.ctx, key, { focus: true }) ? { consume: true } : undefined;
  }

  /** The terminal-input listener: ctrl+' toggles, ctrl+] and Herdr's reserved prefix+h/j/k/l keys move focus. */
  handleKey(data: string): { consume: true } | undefined {
    // With the kitty keyboard protocol a key also arrives as its release (and repeats while held), and
    // listeners see those before Pi filters them: acting on them would undo every toggle at once.
    if (isKeyRelease(data) || this.prompts > 0 || this.blocked > 0) return undefined;
    const repeat = isKeyRepeat(data);
    if ((this.options.toggleKeys ?? toggleKeys()).some((k) => matchesKey(data, k as never))) return repeat ? (this.isOpen ? { consume: true } : undefined) : this.toggle();
    if (repeat && (matchesKey(data, FOCUS_KEY as never) || (!(this.focused && this.view?.editing) && Object.values(NAV_KEYS).some((k) => matchesKey(data, k as never))))) return this.isOpen ? { consume: true } : undefined;
    if (!this.isOpen || this.collapsed || !this.tui) return undefined;
    if (matchesKey(data, FOCUS_KEY as never)) {
      if (this.focused) {
        this.focusMain();
        return { consume: true };
      }
      if (this.tui.getFocusedComponent?.() === this.mainFocus) {
        this.focusView();
        return { consume: true };
      }
      return undefined;
    }
    // Vim owns every ordinary/reserved navigation key while editing. Only the two
    // documented split focus/toggle shortcuts may bypass it.
    if (this.focused && this.view?.editing) return undefined;
    const direction = (Object.keys(NAV_KEYS) as Direction[]).find((d) => matchesKey(data, NAV_KEYS[d] as never));
    if (!direction) return undefined;
    if (this.focused) {
      if (direction === "left") this.focusMain();
      else herdrFocus(direction);
    } else if (direction === "right") this.focusView();
    else herdrFocus(direction);
    return { consume: true };
  }

  listen(ctx: ExtensionContext): void {
    this.release?.();
    this.release = undefined;
    this.ctx = ctx;
    if (ctx.mode === "tui" && typeof ctx.ui.onTerminalInput === "function") {
      this.release = ctx.ui.onTerminalInput((data) => this.handleKey(data));
    }
  }

  shutdown(): void {
    this.close(true);
    this.release?.();
    this.release = undefined;
    this.blocked = 0;
    this.prompts = 0;
    this.reservedPrompt = false;
    this.promptKind = undefined;
    this.restoreNotebookFocus = false;
    this.otherPanel = undefined;
    this.suppressed = false;
    this.ctx = undefined;
    this.states.clear();
    this.tui = undefined;
    this.layout = undefined;
  }
}
