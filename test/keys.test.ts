import { describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COMMANDS, GROUPS, commandFor, commandToken, footerTokens, type CommandMode } from "../src/ui/keys.js";
import { helpLines, Help, formatHelpKey } from "../src/ui/help.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const modes: CommandMode[] = ["notebook", "variables", "packages", "table", "widget", "chart", "editor", "help", "message"];
const sequences: Record<string, string> = {
  escape: "\x1b", enter: "\r", tab: "\t", space: " ", home: "\x1b[H", end: "\x1b[F",
  pageUp: "\x1b[5~", pageDown: "\x1b[6~", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  "shift+tab": "\x1b[Z", "shift+left": "\x1b[1;2D", "shift+right": "\x1b[1;2C", "shift+up": "\x1b[1;2A", "shift+down": "\x1b[1;2B",
  f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS", f5: "\x1b[15~", f6: "\x1b[17~", f7: "\x1b[18~", f8: "\x1b[19~",
};
function input(key: string): string {
  if (key.length === 1) return key;
  if (/^ctrl\+[a-z]$/u.test(key)) return String.fromCharCode(key.charCodeAt(5) - 96);
  const data = sequences[key];
  if (!data) throw new Error(`Missing fixture for ${key}`);
  return data;
}

test("registry has unique identities and complete help metadata", () => {
  expect(new Set(COMMANDS.map(command => command.id)).size).toBe(COMMANDS.length);
  for (const command of COMMANDS) {
    expect(command.keys.length, command.id).toBeGreaterThan(0);
    expect(command.label, command.id).not.toBe("");
    expect(command.description, command.id).not.toBe("");
    expect(GROUPS, command.id).toContain(command.group);
  }
  expect(new Set(COMMANDS.map(command => command.group))).toEqual(new Set(GROUPS));
});

for (const mode of modes) test(`${mode}: all bindings dispatch without collisions`, () => {
  const bindings = new Map<string, string>();
  for (const command of COMMANDS.filter(command => command.modes.includes(mode))) {
    for (const key of command.keys) {
      expect(bindings.has(key), `${mode}: ${key} collides with ${bindings.get(key)}`).toBe(false);
      bindings.set(key, command.id);
      expect(commandFor(mode, input(key))?.id, `${mode}: ${key}`).toBe(command.id);
    }
  }
  expect(commandFor(mode, "\x1b[999~")).toBeUndefined();
});

test("CSI-u printable presses and Kitty repeats dispatch, but releases do not", () => {
  for (const data of ["\x1b[106u", "\x1b[106;1u", "\x1b[106;1:1u", "\x1b[106;1:2u"]) {
    expect(commandFor("notebook", data)?.id).toBe("down");
  }
  for (const data of ["\x1b[106;1:3u", "\x1b[106;5:3u", "\x1b[13;1:3u", "\x1b[1;1:3B"]) {
    expect(commandFor("notebook", data)).toBeUndefined();
  }
});

test("encoded printable bindings preserve uppercase and shifted punctuation", () => {
  for (const [data, id] of [
    ["\x1b[103u", "first"], ["\x1b[71u", "last"],
    ["\x1b[103;2u", "last"], ["\x1b[71;2:2u", "last"],
    ["\x1b[103:71;2:2u", "last"],
    ["\x1b[98;1:2u", "edit"], ["\x1b[98:66;2:2u", "fold-code"],
    ["\x1b[63u", "help"], ["\x1b[47:63;2:2u", "help"],
    ["\x1b[35;2u", "numbers"], ["\x1b[51:35;2:2u", "numbers"],
    ["\x1b[106;65:2u", "down"],
  ]) expect(commandFor("notebook", data!)?.id, data).toBe(id);
  expect(commandFor("notebook", "\x1b[106;2:2u")).toBeUndefined();
  expect(commandFor("chart", "\x1b[106;2:2u")?.id).toBe("chart-down-far");
});

test("modified printables never collide with plain or uppercase bindings", () => {
  for (const event of [1, 2]) {
    expect(commandFor("notebook", `\x1b[100;5:${event}u`)?.id).toBe("section-next");
    expect(commandFor("notebook", `\x1b[117;5:${event}u`)?.id).toBe("section-previous");
    expect(commandFor("notebook", `\x1b[106;5:${event}u`)).toBeUndefined();
    expect(commandFor("notebook", `\x1b[99;5:${event}u`)?.id).toBe("leave");
    for (const modifier of [3, 4, 6, 7, 8, 9]) {
      for (const code of ["106", "98:66", "47:63", "35"]) {
        expect(commandFor("notebook", `\x1b[${code};${modifier}:${event}u`)).toBeUndefined();
      }
    }
  }
  expect(commandFor("notebook", "\x1bj")).toBeUndefined();
});

test("every dispatched command and host shortcut is documented from the same entry", () => {
  const lines = helpLines(theme).join("\n");
  for (const command of COMMANDS) {
    expect(lines, command.id).toContain(command.label);
    expect(lines, command.id).toContain(command.description);
    for (const key of command.keys) expect(lines, command.id).toContain(formatHelpKey(key));
  }
});

for (const width of [46, 80, 100, 120, 180]) describe(`width ${width}`, () => {
  test("footer contains only prioritized whole registry tokens", () => {
    for (const command of COMMANDS.filter(command => command.modes.length)) {
      const editor = command.modes.includes("editor");
      const footer = footerTokens(width, command.id, { mode: editor ? "editor" : "notebook", position: "123/456" });
      expect(visibleWidth(footer)).toBeLessThanOrEqual(width);
      expect(footer.startsWith(commandToken(command.id))).toBe(true);
      expect(footer).not.toMatch(/…|\.\.\./u);
      expect(footer.split(" · ").every(token => [editor ? "f1 help" : "? help", commandToken(command.id), ...(editor ? [] : ["123/456"])].includes(token))).toBe(true);
    }
  });
  test("every command is searchable and reaches the viewport", () => {
    for (const command of COMMANDS) {
      const help = new Help({ group: command.group, query: command.description, typing: false, scroll: 0 });
      const seen: string[] = [];
      for (let i = 0; i < 1000; i++) {
        seen.push(...help.render(width, 6, theme));
        const before = help.state.scroll;
        help.handleInput("j", 6);
        if (help.state.scroll === before) break;
      }
      // Wrapped prose need not preserve spaces at line boundaries.
      const compact = seen.join("").replace(/\s|│/gu, "");
      for (const key of command.keys) expect(compact, command.id).toContain(formatHelpKey(key).replace(/\s/gu, ""));
    }
  });
});

test.each([
  ["ctrl+d", "Ctrl+D"], ["ctrl+u", "Ctrl+U"], ["shift+tab", "Shift+Tab"], ["enter", "Enter"],
  ["escape", "Esc"], ["up", "↑"], ["f8", "F8"], [":MarimoRun", ":MarimoRun"],
])("help formats %s as %s without changing registry bindings", (key, expected) => {
  expect(formatHelpKey(key)).toBe(expected);
  const help = new Help({ group: "Navigation", query: expected, typing: false, scroll: 0 });
  const seen: string[] = [];
  for (let i = 0; i < 1000; i++) {
    seen.push(...help.render(60, 12, theme));
    const before = help.state.scroll;
    help.wheel(1);
    if (before === help.state.scroll) break;
  }
  expect(seen.join("\n")).not.toContain("No matching commands");
  expect(seen.join("\n")).toContain(expected);
});

test("footer prioritizes whole action, help, location, and optional display hints", () => {
  const preferences = { diagnostics: "all" as const, showOutput: true, lineNumbers: false };
  const cell = { mode: "notebook" as const, position: "1/2", section: false, preferences };
  expect(footerTokens(100, "edit", cell)).toBe("b edit source · ? help · O cell · 1/2 · ! diagnostics · \\ output · # lines");
  expect(footerTokens(100, "edit", { ...cell, section: true })).toContain("O section · 1/2");
  expect(footerTokens(29, "edit", cell)).toBe("b edit source · ? help · 1/2");
  expect(footerTokens(1, "edit", cell)).toBe("");
  expect(footerTokens(6, "edit", cell)).toBe("? help");
  expect(footerTokens(22, "edit", cell)).toBe("b edit source · ? help");
  expect(footerTokens(30, "edit", cell)).toBe("b edit source · ? help · 1/2");
  expect(footerTokens(100, "edit", { ...cell, preferences: { ...preferences, lineNumbers: true } })).toContain("# lines on");
  expect(() => commandToken("nonexistent")).toThrow("Unknown notebook command");
});

test("nondefault visibility outranks location without duplicating its toggle", () => {
  const preferences = { diagnostics: "errors" as const, showOutput: false, lineNumbers: false };
  const cell = { mode: "notebook" as const, position: "2/12", section: false, preferences };
  expect(footerTokens(120, "run", cell)).toBe("r run cell · ? help · ! errors · \\ output off · O cell · 2/12 · # lines");
  for (const [diagnostics, label] of [["warnings", "! warnings"], ["none", "! hidden"]] as const) {
    expect(footerTokens(80, "run", { ...cell, preferences: { ...preferences, diagnostics } })).toContain(label);
  }
  expect(footerTokens(26, "run", cell)).toBe("r run cell · ? help · 2/12");
});

test("mode permissions and width fitting do not advertise unavailable controls", () => {
  const preferences = { diagnostics: "all" as const, showOutput: true, lineNumbers: false };
  expect(footerTokens(120, "editor-f2", { mode: "editor", preferences })).toBe("f2 save · f1 help");
  expect(footerTokens(120, "table-row", { mode: "table", preferences })).toBe("enter row detail · ? help · ! diagnostics · \\ output");
  expect(footerTokens(120, "table-row", { mode: "table", preferences: { ...preferences, diagnostics: "none", showOutput: false } })).toBe("enter row detail · ? help · ! hidden · \\ output off");
  expect(footerTokens(120, "help", { mode: "help", preferences })).toBe("? help · ? help");
  expect(footerTokens(120, "message-close", { mode: "message", preferences })).toBe("escape back · ? help");
  for (const width of [0, 1, 6, 22, 29, 30, 46, 80, 100, 120, 180]) {
    const value = footerTokens(width, "edit", { mode: "notebook", section: false, position: "123/456", preferences });
    expect(visibleWidth(value)).toBeLessThanOrEqual(width);
    expect(value).not.toMatch(/…|\.\.\./u);
    expect(value.split(" · ").every(token => ["b edit source", "? help", "O cell", "123/456", "! diagnostics", "\\ output", "# lines", ""].includes(token))).toBe(true);
    const exact = "b edit source · ? help";
    if (width === visibleWidth(exact)) expect(value).toContain(exact);
  }
  const exact = visibleWidth("b edit source · ? help");
  expect(footerTokens(exact, "edit", { mode: "notebook" })).toBe("b edit source · ? help");
  expect(footerTokens(exact - 1, "edit", { mode: "notebook" })).toBe("b edit source");
});

test("editor ordinary keys are not host commands", () => {
  for (const key of ["?", "#", "\r", "q", "!", "\\", "H", "L", "\x1b", "b", "P", "r"]) expect(commandFor("editor", key)).toBeUndefined();
  expect(commandFor("notebook", "\r")?.id).toBe("activate");
  expect(commandFor("notebook", "\n")?.id).not.toBe("section-next");
  expect(commandFor("notebook", "\x04")?.id).toBe("section-next");
  expect(commandFor("notebook", "\x15")?.id).toBe("section-previous");
  expect(commandFor("notebook", "B")?.id).toBe("fold-code");
});
