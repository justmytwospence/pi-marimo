// Fuzzy, notebook-local command picker. Selection returns registry entries; the view owns dispatch.
import { compositeTuiLine, CURSOR_MARKER, decodeKittyPrintable, fuzzyFilter, isKeyRelease, matchesKey, renderFakeCursor, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FrameTheme } from "../frame.js";
import { formatHelpKey } from "./help.js";
import { paletteCommands, type Command, type CommandMode } from "./keys.js";

export interface PaletteBounds { left: number; top: number; width: number; height: number }

const dimension = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export function paletteBounds(width: number, height: number): PaletteBounds | undefined {
  width = dimension(width);
  height = dimension(height);
  if (!width || !height) return undefined;
  const horizontalMargin = width >= 24 ? 2 : 0;
  const verticalMargin = height >= 9 ? 1 : 0;
  const cardWidth = Math.min(76, width - 2 * horizontalMargin);
  const cardHeight = Math.min(16, height - 2 * verticalMargin);
  return { left: Math.floor((width - cardWidth) / 2), top: Math.max(verticalMargin, Math.floor((height - cardHeight) / 3)), width: cardWidth, height: cardHeight };
}

export function compositePalette(base: string[], card: string[], bounds: PaletteBounds, width: number): string[] {
  const lines = base.map(line => line.replaceAll(CURSOR_MARKER, ""));
  for (let row = 0; row < bounds.height; row++) {
    const index = bounds.top + row;
    while (lines.length <= index) lines.push("");
    lines[index] = compositeTuiLine(lines[index] ?? "", card[row] ?? "", bounds.left, bounds.width, width);
  }
  return lines;
}

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
  private hit?: { left: number; width: number; top: number; count: number };

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
    if (matchesKey(data, "escape")) return { kind: "cancel" };
    const matches = this.matches();
    // Ctrl+J shares the legacy LF encoding with Enter, so navigation must take precedence.
    if (matchesKey(data, "up") || matchesKey(data, "shift+tab") || matchesKey(data, "ctrl+p") || matchesKey(data, "ctrl+k")) this.state.selected--;
    else if (matchesKey(data, "down") || matchesKey(data, "tab") || matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+j")) this.state.selected++;
    else if (matchesKey(data, "enter")) {
      const command = matches[this.state.selected];
      return command ? { kind: "execute", command } : undefined;
    }
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
    if (!hit || x < hit.left || x >= hit.left + hit.width || y < hit.top || y >= hit.top + hit.count) return undefined;
    const index = this.state.scroll + y - hit.top;
    const command = this.matches()[index];
    if (command) this.state.selected = index;
    return command;
  }

  render(width: number, height: number, theme: FrameTheme, focused = true): string[] {
    width = dimension(width);
    height = dimension(height);
    this.hit = undefined;
    if (!width || !height) { this.page = 0; return []; }
    const normal = width >= 24 && height >= 7;
    const inner = normal ? width - 4 : width;
    const fit = (text: string, size: number) => truncateToWidth(text, Math.max(0, size), "");
    const pad = (text: string, size: number) => text + " ".repeat(Math.max(0, size - visibleWidth(text)));
    const accent = (text: string) => theme.fg("accent", text);
    const dim = (text: string) => theme.fg("dim", text);
    const line = (text: string) => normal ? `${accent("│")} ${pad(text, inner)} ${accent("│")}` : pad(text, inner);
    const matches = this.matches();
    this.page = normal ? height - 6 : Math.max(0, height - 1 - Number(height >= 3));
    this.clamp(matches.length);
    const rows: string[] = [];
    if (normal) {
      const title = " Command palette ";
      const count = ` ${matches.length} command${matches.length === 1 ? "" : "s"} `;
      const gap = width - 2 - visibleWidth(title) - visibleWidth(count);
      rows.push(accent(`╭─${title}${"─".repeat(gap >= 1 ? gap - 1 : width - 3 - visibleWidth(title))}${gap >= 1 ? count : ""}╮`));
    }
    // Even at one column, leave room for the cursor rather than clipping it away.
    const prefix = fit("> ", Math.max(0, inner - 1));
    const queryRoom = Math.max(0, inner - visibleWidth(prefix) - 1);
    const query = this.state.query;
    const tail = sliceByColumn(query, Math.max(0, visibleWidth(query) - queryRoom), queryRoom, true);
    rows.push(line(`${prefix}${tail}${focused ? CURSOR_MARKER + renderFakeCursor(" ") : " "}`));
    if (normal) rows.push(accent(`├${"─".repeat(width - 2)}┤`));
    this.hit = { left: normal ? 2 : 0, width: inner, top: rows.length, count: Math.min(this.page, Math.max(0, matches.length - this.state.scroll)) };
    for (let i = 0; i < this.page; i++) {
      const command = matches[this.state.scroll + i];
      if (!command) {
        rows.push(line(!matches.length && i === 0 ? dim(fit("No matching commands", inner)) : ""));
        continue;
      }
      const selected = this.state.scroll + i === this.state.selected;
      const keys = width >= 34 ? fit(command.keys.map(formatHelpKey).join(" / "), Math.floor(inner / 3)) : "";
      const keyWidth = visibleWidth(keys);
      const leftWidth = inner - (keyWidth ? keyWidth + 1 : 0);
      const label = fit(`${selected ? "› " : "  "}${command.label}`, leftWidth);
      const styledLabel = selected ? theme.bold(accent(label)) : label;
      const group = width >= 48 ? fit(` · ${command.group}`, Math.max(0, leftWidth - visibleWidth(label))) : "";
      const left = styledLabel + dim(group);
      rows.push(line(pad(left, inner - keyWidth) + (keyWidth ? dim(keys) : "")));
    }
    if (normal) rows.push(line(dim(fit(matches[this.state.selected]?.description ?? "", inner))));
    if (normal || height >= 3) {
      const options = ["↑/↓ Ctrl+N/P/J/K choose · Enter run · Esc close", "↑/↓ choose · Enter run · Esc close", "Enter · Esc close", "Esc close"];
      const footer = options.find(option => visibleWidth(option) <= inner) ?? fit("Esc close", inner);
      rows.push(line(dim(footer)));
    }
    if (normal) rows.push(accent(`╰${"─".repeat(width - 2)}╯`));
    return rows;
  }
}
