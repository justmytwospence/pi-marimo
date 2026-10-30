// Searchable notebook controls, sourced exclusively from the command registry.
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { FrameTheme } from "../frame.ts";
import { COMMANDS, GROUPS, commandFor, commandToken } from "./keys.js";

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

function commandText(command: (typeof COMMANDS)[number]): string {
  return `${command.modes.includes("message") ? "Message view: " : ""}${command.keys.join(" / ")} · ${command.label}${command.description === command.label ? "" : ` — ${command.description}`}`;
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

  render(width: number, height: number, theme: FrameTheme, layoutWidth = width, where?: string): string[] {
    width = Math.max(0, Math.floor(width));
    height = Math.max(0, Math.floor(height));
    if (!width || !height) return [];
    const wrap = (text: string, room = width) => wrapTextWithAnsi(text, room);
    const query = this.state.query.toLocaleLowerCase();
    const commands = COMMANDS.filter((command) => query
      ? [command.keys.join(" "), command.label, command.description].some((text) => text.toLocaleLowerCase().includes(query))
      : command.group === this.state.group);
    const entries = commands.map((command) => commandText(command));
    const body: string[] = [];
    if (layoutWidth < 100) for (const entry of entries) body.push(...wrap(entry));
    else {
      const column = Math.floor((width - 3) / 2);
      for (let i = 0; i < entries.length; i += 2) {
        const left = wrap(entries[i]!, column);
        const right = entries[i + 1] ? wrap(entries[i + 1]!, column) : [];
        for (let row = 0; row < Math.max(left.length, right.length); row++) {
          const a = left[row] ?? "";
          body.push(right[row] === undefined ? a : `${a}${" ".repeat(column - visibleWidth(a))} │ ${right[row]}`);
        }
      }
    }
    if (!body.length) body.push("No matching commands");

    // Always leave at least one content row, even on a one-line terminal.
    const heading = [
      ...wrap(theme.bold(theme.fg("accent", "Notebook controls"))),
      ...wrap(theme.bold(query ? "All categories" : this.state.group)),
      ...wrap(this.state.typing || query ? `Search: ${this.state.query}${this.state.typing ? "_" : ""}` : "/ search all categories"),
      ...(where ? wrap(theme.fg("dim", where)) : []),
    ];
    const hints = wrap(theme.fg("dim", ["help-down", "help-next-category", "help-search", "help-back", "help-close"].map(commandToken).join(" · ")));
    const chrome = Math.min(height - 1, heading.length + hints.length);
    const top = heading.slice(0, Math.min(heading.length, chrome));
    const bottom = hints.slice(0, chrome - top.length);
    this.page = height - top.length - bottom.length;
    this.maxScroll = Math.max(0, body.length - this.page);
    this.state.scroll = Math.max(0, Math.min(this.maxScroll, this.state.scroll));
    return [...top, ...body.slice(this.state.scroll, this.state.scroll + this.page), ...bottom];
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
