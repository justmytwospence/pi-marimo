// Searchable notebook controls, sourced exclusively from the command registry.
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { FrameTheme } from "../frame.ts";
import { COMMANDS, GROUPS, commandFor } from "./keys.js";

export interface HelpState {
  group: string;
  query: string;
  typing: boolean;
  scroll: number;
}

const CONTEXT: Readonly<Record<string, string>> = {
  editor: "Editing", variables: "Variables", packages: "Packages",
  table: "Tables", widget: "Widgets", chart: "Charts",
};

/** Presentation only: canonical registry keys remain untouched for dispatch. */
export function formatHelpKey(key: string): string {
  const names: Record<string, string> = {
    escape: "Esc", enter: "Enter", tab: "Tab", space: "Space", home: "Home", end: "End",
    pageUp: "PageUp", pageDown: "PageDown", up: "↑", down: "↓", left: "←", right: "→",
  };
  return key.split("+").map((part, index, parts) => {
    if (part === "ctrl") return "Ctrl";
    if (part === "shift") return "Shift";
    if (part === "alt") return "Alt";
    return names[part] ?? (/^f\d+$/u.test(part) || (parts.length > 1 && index === parts.length - 1) ? part.toUpperCase() : part);
  }).join("+");
}

function displayKeys(command: (typeof COMMANDS)[number]): string {
  return command.keys.map(formatHelpKey).join(" / ");
}

function commandText(command: (typeof COMMANDS)[number]): string {
  return `${command.modes.includes("message") ? "Message view: " : ""}${displayKeys(command)} · ${command.label}${command.description === command.label ? "" : ` — ${command.description}`}`;
}

function commandRows(command: (typeof COMMANDS)[number], width: number, theme: FrameTheme, search: boolean): string[] {
  const wrap = (text: string, room = width) => wrapTextWithAnsi(text, room);
  const keys = displayKeys(command);
  const label = `${command.modes.includes("message") ? "Message view: " : ""}${command.label}`;
  const keyWidth = width >= 60 ? 22 : 16;
  let rows: string[];
  if (width < 40) rows = [
    ...wrap(keys).map(line => theme.fg("accent", line)),
    ...wrap(label),
  ];
  else {
    const left = wrap(keys, keyWidth);
    const right = wrap(label, width - keyWidth - 2);
    rows = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
      const key = left[i] ?? "";
      return `${theme.fg("accent", key)}${" ".repeat(keyWidth - visibleWidth(key) + 2)}${right[i] ?? ""}`;
    });
  }
  if (search && command.description !== command.label) rows.push(...wrap(command.description).map(line => theme.fg("dim", line)));
  return rows;
}

export class Help {
  readonly state: HelpState;
  private maxScroll = Number.MAX_SAFE_INTEGER;
  private page = 1;

  constructor(state?: HelpState) {
    this.state = state ? { ...state } : { group: "Navigation", query: "", typing: false, scroll: 0 };
    if (!GROUPS.some((group) => group === this.state.group)) this.state.group = "Navigation";
  }

  open(mode: string): void {
    Object.assign(this.state, { group: CONTEXT[mode] ?? "Navigation", query: "", typing: false, scroll: 0 });
    this.maxScroll = Number.MAX_SAFE_INTEGER;
  }

  /** Positive deltas move down; render owns the actual viewport's bounds. */
  wheel(delta: number, _page = this.page): void {
    this.state.scroll = Math.max(0, Math.min(this.maxScroll, this.state.scroll + delta));
  }

  /** False asks the host to close help; unrelated keys never dismiss it. */
  handleInput(data: string, page: number): boolean {
    const s = this.state;
    const command = commandFor("help", data);
    if (command?.id === "help-back") {
      if (!s.query && !s.typing) return false;
      s.query = "";
      s.typing = false;
      this.resetScroll();
      return true;
    }
    if (command?.id === "help-next-category" || command?.id === "help-previous-category") {
      const direction = command.id === "help-previous-category" ? -1 : 1;
      s.group = GROUPS[(GROUPS.findIndex((group) => group === s.group) + direction + GROUPS.length) % GROUPS.length]!;
      s.query = "";
      s.typing = false;
      this.resetScroll();
      return true;
    }
    if (s.typing) {
      if (matchesKey(data, "enter")) s.typing = false;
      else if (matchesKey(data, "backspace")) { s.query = Array.from(s.query).slice(0, -1).join(""); this.resetScroll(); }
      else if (data && !/[\x00-\x1f\x7f-\x9f]/u.test(data)) { s.query += data; this.resetScroll(); }
      return true;
    }
    if (command?.id === "help-close") return false;
    if (command?.id === "help-search") { s.typing = true; return true; }
    if (command?.id === "help-top") s.scroll = 0;
    else if (command?.id === "help-bottom") s.scroll = this.maxScroll;
    else if (command?.id === "help-down") this.wheel(1, page);
    else if (command?.id === "help-up") this.wheel(-1, page);
    else if (command?.id === "help-page-down") this.wheel(Math.max(1, this.page), page);
    else if (command?.id === "help-page-up") this.wheel(-Math.max(1, this.page), page);
    return true;
  }

  render(width: number, height: number, theme: FrameTheme, _layoutWidth = width, _where?: string): string[] {
    width = Math.max(0, Math.floor(width));
    height = Math.max(0, Math.floor(height));
    if (!width || !height) return [];
    const wrap = (text: string) => wrapTextWithAnsi(text, width);
    const query = this.state.query.toLocaleLowerCase();
    const searching = this.state.typing || !!query;
    const commands = COMMANDS.filter((command) => searching
      ? [command.keys.join(" "), displayKeys(command), command.label, command.description].some((text) => text.toLocaleLowerCase().includes(query))
      : command.group === this.state.group);
    const groupIndex = GROUPS.findIndex(group => group === this.state.group);
    const heading = [
      ...wrap(theme.bold(theme.fg("accent", "Keyboard shortcuts"))),
      ...wrap(searching
        ? `Search: ${this.state.query}${this.state.typing ? "_" : ""} · ${commands.length} ${commands.length === 1 ? "match" : "matches"}`
        : `${this.state.group} · ${groupIndex + 1}/${GROUPS.length}`),
    ];
    // Reserve one body row first, then a single pinned footer; chrome yields on tiny screens.
    const footerHeight = height > 1 ? 1 : 0;
    const top = heading.slice(0, Math.max(0, height - footerHeight - 1));
    this.page = height - top.length - footerHeight;
    const rail = width >= 90 && this.page >= 10;
    const listWidth = width - (rail ? 18 : 0);
    const body: string[] = [];
    for (const group of searching ? GROUPS : [this.state.group]) {
      const entries = commands.filter(command => command.group === group);
      if (!entries.length) continue;
      if (searching) body.push(...wrapTextWithAnsi(group, listWidth).map(line => theme.bold(line)));
      for (const command of entries) body.push(...commandRows(command, listWidth, theme, searching));
    }
    if (!body.length) body.push(...wrapTextWithAnsi("No matching commands", listWidth));
    this.maxScroll = Math.max(0, body.length - this.page);
    this.state.scroll = Math.max(0, Math.min(this.maxScroll, this.state.scroll));
    const visible = body.slice(this.state.scroll, this.state.scroll + this.page);
    const railStart = Math.max(0, Math.min(groupIndex, GROUPS.length - this.page));
    const rows = rail ? Array.from({ length: this.page }, (_, i) => {
      const group = GROUPS[railStart + i];
      const name = group ? `${group === this.state.group ? "› " : "  "}${group}` : "";
      const styled = group === this.state.group ? theme.bold(theme.fg("accent", name)) : theme.fg("dim", name);
      return `${styled}${" ".repeat(16 - visibleWidth(name))}  ${visible[i] ?? ""}`;
    }) : Array.from({ length: this.page }, (_, i) => visible[i] ?? "");
    const fullHint = "Tab categories · / search · Esc back";
    const hint = visibleWidth(fullHint) <= width ? fullHint : ["/ search", "Esc back"].reduce((text, token) => {
      const candidate = text ? `${text} · ${token}` : token;
      return visibleWidth(candidate) <= width ? candidate : text;
    }, "");
    const range = ` · ${this.state.scroll + 1}–${Math.min(body.length, this.state.scroll + this.page)}/${body.length}`;
    const footer = visibleWidth(hint + range) <= width ? hint + range : hint;
    return [...top, ...rows, ...(footerHeight ? [theme.fg("dim", footer)] : [])];
  }

  private resetScroll(): void {
    this.state.scroll = 0;
    this.maxScroll = Number.MAX_SAFE_INTEGER;
  }
}

/** Legacy callers still receive registry content, never a second list of bindings. */
export function helpLines(theme: FrameTheme, where?: string): string[] {
  return [
    ...(where ? [theme.fg("dim", where)] : []),
    theme.bold(theme.fg("accent", "Notebook controls")),
    ...GROUPS.flatMap((group) => [theme.bold(group), ...COMMANDS.filter((command) => command.group === group).map(commandText)]),
  ];
}
