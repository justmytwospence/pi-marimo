import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";

// Deliberately long entries exercise wrapping independently of registry copy edits.
vi.mock("../src/ui/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/keys.js")>();
  const GROUPS = ["Navigation", "Display", "Execution", "Editing", "Variables", "Packages", "Tables", "Widgets", "Charts", "Dock/Mouse"];
  const COMMANDS = GROUPS.flatMap((group, g) => Array.from({ length: 13 }, (_, i) => ({
    id: `${g}-${i}`, modes: [group.toLowerCase()], keys: [`key${g}_${i}`, `ctrl+${i}`], group,
    label: `${group} action ${i}`,
    description: `Description ${g}_${i}: inspect 完整内容 with combining e\u0301 and preserve every word including ending_${g}_${i}.`,
  })));
  return { ...actual, GROUPS, COMMANDS };
});

import { Help, helpLines } from "../src/ui/help.js";
import { COMMANDS, GROUPS } from "../src/ui/keys.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const textOf = (command: (typeof COMMANDS)[number]) => `${command.keys.join(" / ")} · ${command.label} — ${command.description}`;
const enterSearch = (help: Help, query: string) => {
  expect(help.handleInput("/", 7)).toBe(true);
  expect(help.handleInput(query, 7)).toBe(true);
  expect(help.handleInput("\r", 7)).toBe(true);
};

function collect(help: Help, width: number, height = 12): Set<string> {
  const rows = new Set<string>();
  if (!height) {
    expect(help.render(width, height, theme)).toEqual([]);
    return rows;
  }
  help.handleInput("g", 1);
  for (let i = 0; i < 5000; i++) {
    const rendered = help.render(width, height, theme);
    expect(rendered.length).toBeLessThanOrEqual(height);
    for (const row of rendered) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      expect(row).not.toContain("…");
      expect(row).not.toContain("...");
      rows.add(row);
    }
    const previous = help.state.scroll;
    help.handleInput("j", 1);
    if (help.state.scroll === previous) return rows;
  }
  throw new Error("Help failed to reach its last row");
}

test.each([
  ["editor", "Editing"], ["variables", "Variables"], ["packages", "Packages"],
  ["table", "Tables"], ["widget", "Widgets"], ["chart", "Charts"],
  ["cells", "Navigation"], ["unknown", "Navigation"],
])("opening %s selects %s and resets transient state", (mode, group) => {
  const help = new Help({ group: "Execution", query: "old", typing: true, scroll: 25 });
  help.open(mode);
  expect(help.state).toEqual({ group, query: "", typing: false, scroll: 0 });
  expect(help.render(46, 12, theme)[1]).toBe(group);
});

test("snapshot restoration copies state rather than mutating the saved snapshot", () => {
  const original = new Help();
  original.open("table");
  const snapshot = { ...original.state };
  const restored = new Help(snapshot);
  restored.handleInput("\t", 7);
  expect(original.state).toEqual(snapshot);
  expect(restored.state.group).toBe("Widgets");
  expect(new Help({ ...snapshot, group: "obsolete" }).state.group).toBe("Navigation");
});

test("Tab and shift+Tab cycle all categories and reset scroll", () => {
  const help = new Help();
  help.render(46, 12, theme);
  help.handleInput("j", 7);
  for (const group of GROUPS.slice(1)) {
    help.handleInput("\t", 7);
    expect(help.state.group).toBe(group);
    expect(help.state.scroll).toBe(0);
  }
  help.handleInput("\t", 7);
  expect(help.state.group).toBe("Navigation");
  help.handleInput("\x1b[Z", 7);
  expect(help.state.group).toBe("Dock/Mouse");
});

test.each(["KEY8_12", "Charts action 12", "ending_8_12"])("search matches keys, labels or descriptions across categories: %s", (query) => {
  const help = new Help();
  enterSearch(help, query);
  const rows = collect(help, 46);
  expect([...rows].join("\n")).toContain("All categories");
  for (const line of wrapTextWithAnsi(textOf(COMMANDS.find((command) => command.id === "8-12")!), 46)) expect(rows.has(line)).toBe(true);
  expect([...rows].join("\n")).not.toContain("ending_0_0");
});

test("search editing treats navigation and ? as text; Enter enables scrolling; Escape clears before closing", () => {
  const help = new Help();
  help.handleInput("/", 7);
  for (const key of ["j", "k", "g", "G", "?"]) expect(help.handleInput(key, 7)).toBe(true);
  expect(help.state.query).toBe("jkgG?");
  help.handleInput("\x7f", 7);
  expect(help.state.query).toBe("jkgG");
  expect(help.handleInput("\x1b", 7)).toBe(true);
  expect(help.state).toMatchObject({ query: "", typing: false, scroll: 0 });
  expect(help.handleInput("\x1b", 7)).toBe(false);
  enterSearch(help, "Description");
  expect(help.state.typing).toBe(false);
  help.render(46, 12, theme);
  help.handleInput("j", 7);
  expect(help.state.scroll).toBe(1);
  expect(help.handleInput("\x1b", 7)).toBe(true);
  expect(help.state.query).toBe("");
  expect(help.handleInput("?", 7)).toBe(false);
});

test("Tab leaves search and visibly switches category even while typing", () => {
  const help = new Help();
  help.open("table");
  help.handleInput("/", 6);
  help.handleInput("copy", 6);
  help.handleInput("\t", 6);
  expect(help.state).toMatchObject({ group: "Widgets", query: "", typing: false, scroll: 0 });
  expect(help.render(46, 12, theme)[1]).toBe("Widgets");
});

test("F1 closes help outside search but is not inserted into search", () => {
  const help = new Help();
  expect(help.handleInput("\x1bOP", 6)).toBe(false);
  help.handleInput("/", 6);
  expect(help.handleInput("\x1bOP", 6)).toBe(true);
  expect(help.state.query).toBe("");
});

test("the view can choose two columns at total width100 with98 content columns", () => {
  const help = new Help();
  expect(help.render(98, 12, theme, 100).some(line => line.includes(" │ "))).toBe(true);
  expect(help.render(98, 12, theme, 99).some(line => line.includes(" │ "))).toBe(false);
});

test("empty searches and no matches remain navigable without closing on unrelated keys", () => {
  const help = new Help();
  for (const key of ["q", "x", "r", "a", "\r"]) expect(help.handleInput(key, 7)).toBe(true);
  help.handleInput("/", 7);
  expect(help.handleInput("\x1b", 7)).toBe(true);
  enterSearch(help, "no such command");
  help.state.scroll = 999;
  expect(help.render(46, 12, theme).join("\n")).toContain("No matching commands");
  expect(help.state.scroll).toBe(0);
});

test("j/k, arrows, page keys, first/last and wheel clamp at the viewport ends", () => {
  const help = new Help();
  help.render(46, 12, theme);
  help.handleInput("\x1b[6~", 7);
  // Page navigation uses the rendered content rectangle, excluding help chrome.
  expect(help.state.scroll).toBe(6);
  help.handleInput("\x1b[5~", 7);
  expect(help.state.scroll).toBe(0);
  help.handleInput("\x1b[B", 7);
  expect(help.state.scroll).toBe(1);
  help.handleInput("\x1b[A", 7);
  expect(help.state.scroll).toBe(0);
  help.handleInput("G", 7);
  const last = help.state.scroll;
  expect(last).toBeGreaterThan(7);
  help.wheel(10000);
  help.handleInput("j", 7);
  expect(help.state.scroll).toBe(last);
  expect(help.render(46, 12, theme).join("\n")).toContain("ending_0_12");
  help.wheel(-10000);
  help.handleInput("k", 7);
  expect(help.state.scroll).toBe(0);
  help.wheel(2, 7);
  expect(help.state.scroll).toBe(2);
  help.handleInput("g", 7);
  expect(help.state.scroll).toBe(0);
});

describe.each([46, 80, 100, 120, 180])("complete help at width %i", (width) => {
  test("every wrapped command row and its final words are reachable", () => {
    const help = new Help();
    const rows = collect(help, width);
    const commands = COMMANDS.filter((command) => command.group === "Navigation");
    const column = width < 100 ? width : Math.floor((width - 3) / 2);
    for (const command of commands) {
      for (const line of wrapTextWithAnsi(textOf(command), column)) {
        expect([...rows].some((row) => width < 100 ? row === line : row.includes(line))).toBe(true);
      }
    }
    expect([...rows].some((row) => row.includes(" │ "))).toBe(width >= 100);
  });
});

test.each([0, 1, 2, 3, 4, 5, 12])("short height %i preserves the height bound and reachable final content", (height) => {
  const help = new Help();
  const rows = collect(help, 46, height);
  if (height) expect([...rows].join("\n")).toContain("ending_0_12");
  else expect(rows.size).toBe(0);
});

test("resize, new query and category changes clamp stale scroll offsets", () => {
  const help = new Help();
  help.render(46, 12, theme);
  help.handleInput("G", 7);
  help.render(180, 100, theme);
  expect(help.state.scroll).toBe(0);
  help.state.scroll = 999;
  enterSearch(help, "key8_12");
  expect(help.state.scroll).toBe(0);
  help.render(46, 12, theme);
  expect(help.state.scroll).toBe(0);
});

test("ANSI styling obeys visible widths and compatibility help is registry-generated", () => {
  const colored = { fg: (_: string, text: string) => `\x1b[36m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[0m` };
  const help = new Help();
  for (const row of help.render(46, 12, colored)) expect(visibleWidth(row)).toBeLessThanOrEqual(46);
  expect(help.render(0, 12, theme)).toEqual([]);
  const compatibility = helpLines(theme, "context");
  expect(compatibility[0]).toBe("context");
  for (const command of COMMANDS) expect(compatibility).toContain(textOf(command));
});
