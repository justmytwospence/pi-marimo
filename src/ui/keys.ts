// Single source of truth for notebook dispatch, help and compact footer tokens.
import { decodeKittyPrintable, isKeyRelease, matchesKey, parseKey, visibleWidth } from "@earendil-works/pi-tui";

export type CommandMode = "notebook" | "variables" | "packages" | "table" | "widget" | "chart" | "editor" | "help" | "message";
export interface Command {
  id: string;
  modes: readonly CommandMode[];
  keys: readonly string[];
  group: string;
  label: string;
  description: string;
}
export const GROUPS = ["Navigation", "Display", "Execution", "Editing", "Variables", "Packages", "Tables", "Widgets", "Charts", "Dock/Mouse"] as const;
const N: CommandMode[] = ["notebook"];
const V: CommandMode[] = ["variables"];
const P: CommandMode[] = ["packages"];
const T: CommandMode[] = ["table"];
const W: CommandMode[] = ["widget"];
const C: CommandMode[] = ["chart"];
const E: CommandMode[] = ["editor"];
const reading: CommandMode[] = [...N, ...V, ...P, ...T, ...W, ...C];
const command = (id: string, modes: readonly CommandMode[], keys: string[], group: string, label: string, description = label): Command => ({ id, modes, keys, group, label, description });
export const COMMANDS: readonly Command[] = [
  command("message", [...reading, ...E, "help"], ["f8"], "Navigation", "message", "Read the full captured message; prompt and editor drafts are kept"),
  command("message-close", ["message"], ["escape", "f8"], "Navigation", "back", "Restore prior focus and scroll without rearming actions"),
  command("message-down", ["message"], ["j", "down"], "Navigation", "scroll down", "Mouse wheel also scrolls the message"),
  command("message-up", ["message"], ["k", "up"], "Navigation", "scroll up"),
  command("message-page-down", ["message"], ["pageDown"], "Navigation", "page down"),
  command("message-page-up", ["message"], ["pageUp"], "Navigation", "page up"),
  command("message-top", ["message"], ["g", "home"], "Navigation", "message top"),
  command("message-bottom", ["message"], ["G", "end"], "Navigation", "message bottom"),
  command("help", reading, ["?"], "Navigation", "help", "Open searchable context help"),
  command("editor-help", E, ["f1"], "Editing", "help", "Open help; other Vim keys remain native"),
  command("help-close", ["help"], ["?", "f1"], "Navigation", "close help", "Close when not typing a search"),
  command("help-back", ["help"], ["escape"], "Navigation", "clear / close", "Clear search first, then close help"),
  command("help-search", ["help"], ["/"], "Navigation", "search help", "Search key names and descriptions across all categories"),
  command("help-next-category", ["help"], ["tab"], "Navigation", "next category", "Switch category and leave search"),
  command("help-previous-category", ["help"], ["shift+tab"], "Navigation", "previous category", "Switch category and leave search"),
  command("help-down", ["help"], ["j", "down"], "Navigation", "scroll help down", "Mouse wheel also scrolls help"),
  command("help-up", ["help"], ["k", "up"], "Navigation", "scroll help up"),
  command("help-page-down", ["help"], ["pageDown", "ctrl+d", "space"], "Navigation", "help page down"),
  command("help-page-up", ["help"], ["pageUp", "ctrl+u"], "Navigation", "help page up"),
  command("help-top", ["help"], ["g", "home"], "Navigation", "help top"),
  command("help-bottom", ["help"], ["G", "end"], "Navigation", "help bottom"),
  command("down", N, ["j", "down"], "Navigation", "next cell"),
  command("up", N, ["k", "up"], "Navigation", "previous cell"),
  command("section-next", N, ["ctrl+d", "]"], "Navigation", "next section", "Next section, or next filtered cell during search"),
  command("section-previous", N, ["ctrl+u", "["], "Navigation", "previous section", "Previous section, or previous filtered cell during search"),
  command("part-next", N, ["n"], "Navigation", "next part"),
  command("part-previous", N, ["p"], "Navigation", "previous part"),
  command("first", N, ["g", "home"], "Navigation", "first cell"),
  command("last", N, ["G", "end"], "Navigation", "last cell"),
  command("page-up", N, ["pageUp"], "Navigation", "page up"),
  command("page-down", N, ["pageDown", "space"], "Navigation", "page down"),
  command("follow", N, ["f"], "Navigation", "follow running cell"),
  command("find", N, ["/"], "Navigation", "find cell", "Filter cells; Enter goes to the match and clears search; Escape restores selection"),
  command("parent", N, ["<"], "Navigation", "upstream cell"),
  command("child", N, [">"], "Navigation", "downstream cell"),
  command("error-next", N, ["e"], "Navigation", "next error"),
  command("error-previous", N, ["E"], "Navigation", "previous error"),
  command("change-next", N, ["c"], "Navigation", "next agent change"),
  command("change-previous", N, ["C"], "Navigation", "previous agent change"),
  command("activate", N, ["enter", "l"], "Editing", "edit / activate", "Edit source or Markdown; activate a focused table, widget or chart"),
  command("edit", N, ["b"], "Editing", "edit source", "Edit selected Python or literal Markdown inline with Neovim"),
  command("fold-code", N, ["B"], "Display", "fold code", "Fold or unfold selected cell source; retained across cell and section views"),
  command("numbers", N, ["#", "f7"], "Display", "line numbers"),
  command("code-left", N, ["H"], "Display", "code left", "Scroll focused code left eight columns"),
  command("code-right", N, ["L"], "Display", "code right", "Scroll focused code right eight columns"),
  command("code-reset", N, ["0"], "Display", "reset code offset"),
  command("diagram", N, ["s"], "Display", "diagram source", "Toggle focused Mermaid diagram and complete source"),
  command("diagnostics", reading, ["!"], "Display", "diagnostics", "Cycle All / Errors / Warnings / None independently of output"),
  command("output", reading, ["\\"], "Display", "output visibility", "Toggle stdout and results; source, progress and run state stay visible"),
  command("timing", N, ["T"], "Display", "exact timing", "Inspect local start/end timezone and duration"),
  command("section", N, ["O"], "Display", "section / cell view"),
  command("fold-section", N, ["z", "tab"], "Display", "fold section"),
  command("fold-all", N, ["Z", "shift+tab"], "Display", "fold all sections"),
  command("diff", N, ["d"], "Display", "agent diff"),
  command("run", N, ["r"], "Execution", "run cell"),
  command("run-stale", N, ["R"], "Execution", "run stale", "Press twice to run stale cells"),
  command("run-all", N, ["A"], "Execution", "run all", "Press twice to run all cells"),
  command("interrupt", N, ["x"], "Execution", "interrupt", "Press twice to interrupt the kernel"),
  command("scratch", N, [":"], "Execution", "kernel Python", "Open a docked Python prompt"),
  command("ask", N, ["a"], "Execution", "ask agent"),
  command("mark", N, ["m"], "Execution", "Lens mark"),
  command("unmark", N, ["M"], "Execution", "remove Lens mark", "Press twice to remove the latest selection"),
  command("variables", N, ["v"], "Variables", "variables"),
  command("packages", [...N, ...V], ["P"], "Packages", "packages"),
  command("table", N, ["t"], "Tables", "table"),
  command("widget", N, ["w"], "Widgets", "controls", "Drive the cell's controls across notebook cells with Tab or j/k"),
  command("chart", N, ["i"], "Charts", "inspect chart"),
  command("dock", [...N, ...V, ...P, ...C], ["|"], "Dock/Mouse", "dock / fullscreen"),
  command("notebook-previous", [...N, ...V], ["{"], "Dock/Mouse", "previous notebook"),
  command("notebook-next", [...N, ...V], ["}"], "Dock/Mouse", "next notebook"),
  command("leave", N, ["escape", "ctrl+c", "q", "h", "left"], "Dock/Mouse", "back to Pi", "Escape focuses docked chat; q closes a docked notebook"),
  command("browser", N, ["o"], "Dock/Mouse", "open browser"),
  command("stop", N, ["S"], "Dock/Mouse", "stop server", "Press twice to stop the notebook server"),
  command("host-focus", [], ["ctrl+]"], "Dock/Mouse", "chat / notebook focus", "Host shortcut; click a pane to focus it"),
  command("host-dock", [], ["ctrl+'"], "Dock/Mouse", "dock / close notebook", "Host shortcut; drag divider to resize; wheel scrolls; double-click edits source"),
  ...([ ["f2", "save", "Save only; native :w and :wq also save without running"], ["f3", "save + run", "Save then run the canonical saved cell"], ["f4", "leave editor", "Dirty drafts offer Save / Discard / Keep editing"], ["f5", "dock / fullscreen", "Retain live editor and draft"], ["f6", "revert", "Confirm dirty revert to last saved base as an undoable edit"], ["f7", "line numbers", "Toggle source and editor line numbers"] ] as const).map(([key, label, description]) => command(`editor-${key}`, E, [key], "Editing", label, description)),
  command("native-write", [], [":w", ":wq"], "Editing", "native save", "Save only; conflicts and failures retain your draft"),
  command("native-discard", [], [":q!"], "Editing", "discard draft", "A deliberate native quit discards; crashes retain recovery drafts"),
  command("native-run", [], [":MarimoRun"], "Editing", "save then run", "Save before requesting execution; no automatic mutation retries"),
  command("native-revert", [], [":MarimoRevert"], "Editing", "revert saved base", "Restore the last saved base as one undoable edit"),
  command("native-close", [], [":MarimoClose"], "Editing", "close editor", "Unsaved drafts require Save / Discard / Keep editing"),
  command("native-input", [], ["Vim input"], "Editing", "native editing", "Neovim owns ordinary punctuation, Enter, Escape, motions, operators, registers and undo"),
  command("var-down", V, ["j", "down"], "Variables", "next / scroll down"),
  command("var-up", V, ["k", "up"], "Variables", "previous / scroll up"),
  command("var-first", V, ["g", "home"], "Variables", "first / top"),
  command("var-last", V, ["G", "end"], "Variables", "last / bottom"),
  command("var-page-up", V, ["pageUp"], "Variables", "scroll up"),
  command("var-page-down", V, ["pageDown", "space"], "Variables", "scroll down"),
  command("var-half-up", V, ["ctrl+u"], "Variables", "half page up", "Half page in list; full page in value detail"),
  command("var-half-down", V, ["ctrl+d"], "Variables", "half page down", "Half page in list; full page in value detail"),
  command("var-back", V, ["escape"], "Variables", "back", "Close detail first, then return to cells"),
  command("var-close", V, ["v", "q", "h", "left"], "Variables", "close variables"),
  command("var-leave", V, ["ctrl+c"], "Variables", "back to Pi"),
  command("var-detail", V, ["enter", "l", "right"], "Variables", "detail", "Open scrollable marimo value preview, not arbitrary object evaluation"),
  command("var-sort", V, ["s"], "Variables", "sort", "Cycle name / type / definition"),
  command("var-find", V, ["/"], "Variables", "filter", "Search name, type and supplied value"),
  command("var-definition", V, ["d"], "Variables", "definition"),
  command("var-uses", V, [">"], "Variables", "use sites", "Choose among all use sites"),
  command("var-copy", V, ["y"], "Variables", "copy name"),
  command("var-copy-value", V, ["Y"], "Variables", "copy value"),
  command("var-table", V, ["t"], "Variables", "defining table"),
  command("var-ask", V, ["a"], "Variables", "ask about variable"),
  command("pkg-back", P, ["escape"], "Packages", "back", "Close dependency detail first, then return to cells"),
  command("pkg-close", P, ["P", "q"], "Packages", "close packages"),
  command("pkg-find", P, ["/"], "Packages", "filter packages"),
  command("pkg-tab", P, ["tab"], "Packages", "category", "Cycle Installed / Missing / Operations"),
  command("pkg-down", P, ["j", "down"], "Packages", "next package"),
  command("pkg-up", P, ["k", "up"], "Packages", "previous package"),
  command("pkg-page-down", P, ["pageDown"], "Packages", "page down"),
  command("pkg-page-up", P, ["pageUp"], "Packages", "page up"),
  command("pkg-top", P, ["g"], "Packages", "top"),
  command("pkg-bottom", P, ["G"], "Packages", "bottom"),
  command("pkg-detail", P, ["enter"], "Packages", "dependency tree", "Open detail or expand/collapse; never mutate on Enter"),
  command("pkg-refresh", P, ["r"], "Packages", "refresh"),
  command("pkg-add", P, ["a"], "Packages", "install requirement", "Review kernel environment and confirm before installation"),
  command("pkg-upgrade", P, ["u"], "Packages", "upgrade", "Confirm selected installed package upgrade"),
  command("pkg-remove", P, ["x"], "Packages", "remove", "Confirm selected installed package removal"),
  command("table-close", T, ["escape", "q", "ctrl+c"], "Tables", "back", "Close card first, then leave table"),
  command("table-down", T, ["j", "down"], "Tables", "row down"),
  command("table-up", T, ["k", "up"], "Tables", "row up"),
  command("table-left", T, ["h", "left"], "Tables", "column left"),
  command("table-right", T, ["l", "right"], "Tables", "column right"),
  command("table-next", T, ["]", "pageDown"], "Tables", "next page"),
  command("table-previous", T, ["[", "pageUp"], "Tables", "previous page"),
  command("table-first", T, ["g"], "Tables", "first page"),
  command("table-last", T, ["G"], "Tables", "last page"),
  command("table-larger", T, ["+"], "Tables", "larger page"),
  command("table-smaller", T, ["-"], "Tables", "smaller page"),
  command("table-sort", T, ["s"], "Tables", "sort column"),
  command("table-sort-add", T, ["S"], "Tables", "add sort column"),
  command("table-search", T, ["/"], "Tables", "search"),
  command("table-filter", T, ["f"], "Tables", "filter column"),
  command("table-clear", T, ["F"], "Tables", "clear filters"),
  command("table-select", T, ["space", "x"], "Tables", "select row"),
  command("table-row", T, ["enter"], "Tables", "row detail"),
  command("table-column", T, ["i"], "Tables", "column detail"),
  command("table-summary", T, ["c"], "Tables", "summaries"),
  command("table-shrink", T, ["H"], "Tables", "shrink column", "Shrink current column two terminal columns"),
  command("table-grow", T, ["L"], "Tables", "grow column", "Grow current column two terminal columns"),
  command("table-fit", T, ["="], "Tables", "fit column", "Fit the current column to loaded values"),
  command("table-pick", T, ["ctrl+g"], "Tables", "choose column", "Pick a column from the current table"),
  command("table-value", T, ["v"], "Tables", "full value", "Inspect the complete current cell value"),
  command("table-copy", T, ["y"], "Tables", "copy cell"),
  command("table-copy-row", T, ["Y"], "Tables", "copy row"),
  command("table-csv", T, ["D"], "Tables", "save CSV"),
  command("table-refresh", T, ["r"], "Tables", "refresh"),
  command("widget-close", W, ["escape", "w", "q"], "Widgets", "done"),
  command("widget-next", W, ["j", "down", "tab"], "Widgets", "next widget"),
  command("widget-previous", W, ["k", "up", "shift+tab"], "Widgets", "previous widget"),
  command("widget-dec", W, ["h", "left"], "Widgets", "decrease"),
  command("widget-inc", W, ["l", "right"], "Widgets", "increase"),
  command("widget-dec10", W, ["H", "shift+left"], "Widgets", "decrease ×10"),
  command("widget-inc10", W, ["L", "shift+right"], "Widgets", "increase ×10"),
  command("widget-toggle", W, ["space"], "Widgets", "toggle / press / handle", "Space toggles a switch, presses a button or changes a range handle"),
  command("widget-type", W, ["enter"], "Widgets", "enter value", "Enter types a slider, range, text or date value; toggles buttons and switches"),
  command("widget-browser", W, ["o"], "Widgets", "open browser", "Open unsupported controls in marimo's browser"),
  command("chart-close", C, ["escape", "q", "i"], "Charts", "done"),
  command("chart-left", C, ["h", "left"], "Charts", "pointer left"),
  command("chart-right", C, ["l", "right"], "Charts", "pointer right"),
  command("chart-up", C, ["k", "up"], "Charts", "pointer up"),
  command("chart-down", C, ["j", "down"], "Charts", "pointer down"),
  command("chart-left-far", C, ["H", "shift+left"], "Charts", "pointer far left"),
  command("chart-right-far", C, ["L", "shift+right"], "Charts", "pointer far right"),
  command("chart-up-far", C, ["K", "shift+up"], "Charts", "pointer far up"),
  command("chart-down-far", C, ["J", "shift+down"], "Charts", "pointer far down"),
  command("chart-drag", C, ["space", "enter"], "Charts", "start / end drag"),
  command("chart-zoom-in", C, ["+", "="], "Charts", "zoom in"),
  command("chart-zoom-out", C, ["-", "_"], "Charts", "zoom out"),
  command("chart-reset", C, ["0"], "Charts", "reset chart"),
];

export function commandFor(mode: CommandMode, data: string): Command | undefined {
  if (isKeyRelease(data)) return undefined;
  let printable = decodeKittyPrintable(data);
  // Kitty may report Shift+letter without an alternate shifted codepoint.
  // Keep literal character bindings case-sensitive, unlike key identifiers.
  if (printable && /^[a-z]$/u.test(printable) && /^shift\+[a-z]$/u.test(parseKey(data) ?? "")) printable = printable.toUpperCase();
  printable ??= data;
  return COMMANDS.find(command => command.modes.includes(mode) && command.keys.some(key => key.length === 1 ? printable === key : matchesKey(data, key as Parameters<typeof matchesKey>[1])));
}
function entryFor(id: string): Command {
  const entry = COMMANDS.find(command => command.id === id);
  if (!entry) throw new Error(`Unknown notebook command: ${id}`);
  return entry;
}
export function commandKey(id: string): string { return entryFor(id).keys[0]!; }
export function commandToken(id: string): string {
  const entry = entryFor(id);
  return `${entry.keys[0]} ${entry.label}`;
}
/** Whole tokens in descending priority; no ellipses or partially visible shortcuts. */
export function footerTokens(width: number, primary: string, position?: string, editor = false): string {
  const tokens = [commandToken(editor ? "editor-help" : "help"), commandToken(primary), ...(position ? [position] : [])];
  const kept: string[] = [];
  for (const token of tokens) {
    if (visibleWidth([...kept, token].join(" · ")) <= width) kept.push(token);
    else break;
  }
  return kept.join(" · ");
}
