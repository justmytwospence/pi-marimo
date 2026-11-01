// Fuzzy, notebook-local command picker. Selection returns registry entries; the view owns dispatch.
import { CURSOR_MARKER, decodeKittyPrintable, fuzzyFilter, isKeyRelease, isKeyRepeat, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FrameTheme } from "../frame.js";
import { formatHelpKey } from "./help.js";
import { paletteCommands, type Command, type CommandMode } from "./keys.js";

export interface PaletteState {
  mode: CommandMode;
  query: string;
  selected: number;
  scroll: number;
}

export type PaletteResult = { kind: "cancel" } | { kind: "execute"; command: Command };

export class Palette {
  readonly state: PaletteState;
  private page = 1;
  private hit?: { width: number; top: number; count: number };

  constructor(mode: CommandMode, state?: PaletteState) {
    this.state = state && state.mode === mode ? { ...state } : { mode, query: "", selected: 0, scroll: 0 };
  }

  matches(): Command[] {
    const commands = paletteCommands(this.state.mode);
    return fuzzyFilter(commands, this.state.query, (command) =>
      `${command.label} ${command.group} ${command.description} ${command.keys.map(formatHelpKey).join(" ")}`);
  }

  private clamp(count: number): void {
    this.state.selected = Math.max(0, Math.min(count - 1, this.state.selected));
    const max = Math.max(0, count - this.page);
    this.state.scroll = Math.max(0, Math.min(max, this.state.scroll));
    if (!this.page) { this.state.scroll = 0; return; }
    if (this.state.selected < this.state.scroll) this.state.scroll = this.state.selected;
    if (this.state.selected >= this.state.scroll + this.page) this.state.scroll = this.state.selected - this.page + 1;
  }

  wheel(delta: number): void {
    this.state.selected += delta;
    this.clamp(this.matches().length);
  }

  input(data: string): PaletteResult | undefined {
    if (isKeyRelease(data)) return undefined;
    if (matchesKey(data, "ctrl+p")) return isKeyRepeat(data) ? undefined : { kind: "cancel" };
    if (matchesKey(data, "escape")) return { kind: "cancel" };
    const matches = this.matches();
    if (matchesKey(data, "enter")) {
      const command = matches[this.state.selected];
      return command ? { kind: "execute", command } : undefined;
    }
    if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) this.state.selected--;
    else if (matchesKey(data, "down") || matchesKey(data, "tab")) this.state.selected++;
    else if (matchesKey(data, "pageUp")) this.state.selected -= Math.max(1, this.page);
    else if (matchesKey(data, "pageDown")) this.state.selected += Math.max(1, this.page);
    else if (matchesKey(data, "backspace")) {
      this.state.query = Array.from(this.state.query).slice(0, -1).join("");
      this.state.selected = this.state.scroll = 0;
    } else {
      const printable = decodeKittyPrintable(data) ?? data;
      if (!printable || /[\x00-\x1f\x7f-\x9f]/u.test(printable) || printable.startsWith("\x1b")) return undefined;
      this.state.query = Array.from(this.state.query + printable).slice(0, 256).join("");
      this.state.selected = this.state.scroll = 0;
    }
    this.clamp(this.matches().length);
    return undefined;
  }

  /** Coordinates relative to the palette's own rendered rows. A result click chooses and executes it. */
  selectAt(x: number, y: number): Command | undefined {
    const hit = this.hit;
    if (!hit || x < 0 || x >= hit.width || y < hit.top || y >= hit.top + hit.count) return undefined;
    const index = this.state.scroll + y - hit.top;
    const command = this.matches()[index];
    if (command) this.state.selected = index;
    return command;
  }

  render(width: number, height: number, theme: FrameTheme, focused = true): string[] {
    width = Math.max(0, Math.floor(width));
    height = Math.max(0, Math.floor(height));
    this.hit = undefined;
    if (!width || !height) return [];
    const fit = (text: string) => truncateToWidth(text, width);
    const rows: string[] = [fit(theme.bold(theme.fg("accent", "Command palette")))];
    if (height > 1) {
      const prefix = "> ";
      const room = Math.max(0, width - visibleWidth(prefix));
      const query = this.state.query;
      const tail = sliceByColumn(query, Math.max(0, visibleWidth(query) - Math.max(0, room - 1)), room - 1, true);
      rows.push(fit(`${prefix}${tail}${focused ? CURSOR_MARKER : ""}_`));
    }
    const footer = height > 2;
    const description = height > 4;
    this.page = Math.max(0, height - rows.length - Number(footer) - Number(description));
    const matches = this.matches();
    this.clamp(matches.length);
    if (this.page) {
      this.hit = { width, top: rows.length, count: Math.min(this.page, matches.length - this.state.scroll) };
      for (let i = 0; i < this.page; i++) {
        const command = matches[this.state.scroll + i];
        if (!command) { rows.push(!matches.length && i === 0 ? fit(theme.fg("dim", "No matching commands")) : ""); continue; }
        const selected = this.state.scroll + i === this.state.selected;
        const label = `${selected ? "› " : "  "}${command.label} · ${command.group} · ${command.keys.map(formatHelpKey).join(" / ")}`;
        rows.push(fit(selected ? theme.bold(theme.fg("accent", label)) : label));
      }
    }
    if (description) rows.push(fit(matches[this.state.selected]?.description ?? ""));
    if (footer) rows.push(fit(theme.fg("dim", "↑/↓ choose · Enter run · Esc back")));
    return rows;
  }
}
