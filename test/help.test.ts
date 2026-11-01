import { visibleWidth } from "@earendil-works/pi-tui";
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

import { Help, helpLines, formatHelpKey } from "../src/ui/help.js";
import { COMMANDS, GROUPS } from "../src/ui/keys.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const textOf = (command: (typeof COMMANDS)[number]) => `${command.keys.map(formatHelpKey).join(" / ")} · ${command.label} — ${command.description}`;
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
  const help = new Help();
  Object.assign(help.state, { group: "Execution", query: "old", typing: true, scroll: 25 });
  help.open(mode);
  expect(help.state).toEqual({ group, query: "", typing: false, scroll: 0 });
  expect(help.render(46, 12, theme)[1]).toContain(group);
});

test("reopening help remembers its category and scroll, but not transient search", () => {
  const help = new Help();
  expect(help.lastPage()).toBeUndefined();
  help.open("cells");
  help.render(46, 12, theme);
  help.handleInput("\t", 1);
  help.render(46, 12, theme);
  help.handleInput("j", 1);
  expect(help.state).toMatchObject({ group: "Display", scroll: 1 });
  expect(help.lastPage()).toEqual({ group: "Display", query: "", typing: false, scroll: 1 });
  help.open("packages");
  expect(help.state).toMatchObject({ group: "Display", scroll: 1 });
  help.render(46, 12, theme);
  enterSearch(help, "Description");
  help.render(46, 12, theme);
  help.handleInput("j", 1);
  help.open("editor");
  expect(help.state).toEqual({ group: "Display", query: "", typing: false, scroll: 1 });
  expect(help.render(46, 12, theme).at(-1)).toContain("2–");
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
  const text = [...rows].join("\n");
  expect(text).toContain("Charts");
  expect(text).toContain("1 match");
  expect(text).toContain("key8_12");
  expect(text).toContain("Ctrl+12");
  expect(text).toContain("Charts action 12");
  expect(text).toContain("ending_8_12.");
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
  expect(help.render(46, 12, theme)[1]).toContain("Widgets");
});

test("F1 closes help outside search but is not inserted into search", () => {
  const help = new Help();
  expect(help.handleInput("\x1bOP", 6)).toBe(false);
  help.handleInput("/", 6);
  expect(help.handleInput("\x1bOP", 6)).toBe(true);
  expect(help.state.query).toBe("");
});

test("rail uses actual content width and body height, never host width", () => {
  const help = new Help();
  expect(help.render(89, 30, theme, 180).join("\n")).not.toContain("› Navigation");
  expect(help.render(90, 12, theme).join("\n")).not.toContain("› Navigation");
  expect(help.render(90, 13, theme).join("\n")).toContain("› Navigation");
  help.open("chart");
  expect(help.render(90, 13, theme).join("\n")).toContain("› Charts");
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
  // A nine-row page is clamped to the seven remaining rows.
  expect(help.state.scroll).toBe(7);
  help.handleInput("\x1b[5~", 7);
  expect(help.state.scroll).toBe(0);
  help.handleInput("\x1b[B", 7);
  expect(help.state.scroll).toBe(1);
  help.handleInput("\x1b[A", 7);
  expect(help.state.scroll).toBe(0);
  help.handleInput("G", 7);
  const last = help.state.scroll;
  expect(last).toBe(7);
  help.wheel(10000);
  help.handleInput("j", 7);
  expect(help.state.scroll).toBe(last);
  expect(help.render(46, 12, theme).join("\n")).toContain("Navigation action 12");
  help.wheel(-10000);
  help.handleInput("k", 7);
  expect(help.state.scroll).toBe(0);
  help.wheel(2, 7);
  expect(help.state.scroll).toBe(2);
  help.handleInput("g", 7);
  expect(help.state.scroll).toBe(0);
});

describe.each([24, 39, 40, 59, 60, 89, 90, 120, 180])("complete help at width %i", (width) => {
  test("every key and action is reachable without repeating long descriptions", () => {
    const help = new Help();
    const rows = [...collect(help, width)];
    for (const command of COMMANDS.filter((entry) => entry.group === "Navigation")) {
      for (const key of command.keys) expect(rows.some(row => row.includes(formatHelpKey(key)))).toBe(true);
      expect(rows.some((row) => row.includes(command.label))).toBe(true);
    }
    expect(rows.join("\n")).not.toContain("Description 0_12:");
    expect(rows.some((row) => row.includes(" │ "))).toBe(false);
  });
});

test.each([0, 1, 6, 12, 30])("short height %i preserves the height bound and reachable final content", (height) => {
  const help = new Help();
  const rows = collect(help, 46, height);
  if (height) expect([...rows].join("\n")).toContain("Navigation action 12");
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

test.each([24, 39, 40, 59, 60, 89, 90, 120, 180])("responsive chrome and body fit width %i at every height", width => {
  for (const height of [0, 1, 6, 12, 30]) {
    const help = new Help();
    enterSearch(help, "Description");
    const rows = help.render(width, height, theme, 180, "hidden/notebook.py");
    expect(rows).toHaveLength(height);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    expect(rows.join("\n")).not.toContain("hidden/notebook.py");
    if (height > 1) expect(rows.at(-1)).toContain(width >= 35 ? "Tab categories" : "/ search · Esc back");
    expect(rows.filter(row => row.includes("Tab categories"))).toHaveLength(height > 1 && width >= 35 ? 1 : 0);
  }
});

test("clicking rendered rail categories selects them and ignores heading, padding, footer and empty rows", () => {
  const help = new Help();
  help.render(90, 100, theme);
  expect(help.selectCategoryAt(0, 0)).toBe(false); // heading
  expect(help.selectCategoryAt(-1, 3)).toBe(false);
  expect(help.selectCategoryAt(16, 3)).toBe(false); // gap before commands
  expect(help.selectCategoryAt(1, 99)).toBe(false); // footer
  expect(help.selectCategoryAt(1, 14)).toBe(false); // no category after the tenth row
  expect(help.selectCategoryAt(15, 11)).toBe(true);
  expect(help.state).toMatchObject({ group: "Dock/Mouse", scroll: 0 });
  expect(help.render(90, 100, theme).join("\n")).toContain("› Dock/Mouse");
  expect(help.selectCategoryAt(1, 2)).toBe(true);
  expect(help.state.group).toBe("Navigation");
});

test("rail click leaves search, and re-rendering after resize changes hit coordinates", () => {
  const help = new Help();
  help.render(90, 13, theme);
  enterSearch(help, "key0_12");
  help.render(90, 13, theme);
  expect(help.selectCategoryAt(1, 3)).toBe(true);
  expect(help.state).toMatchObject({ group: "Display", query: "", typing: false, scroll: 0 });
  help.render(46, 13, theme);
  expect(help.selectCategoryAt(1, 2)).toBe(false);
  help.render(90, 100, theme);
  expect(help.selectCategoryAt(1, 2)).toBe(true);
  expect(help.state.group).toBe("Navigation");
});

test("fitted j/k and arrows select adjacent categories, clamp, and leave Tab wrapping", () => {
  const help = new Help();
  help.render(90, 100, theme);
  expect(help.render(90, 100, theme).at(-1)).toContain("j/k categories");
  help.handleInput("k", 1);
  help.handleInput("\x1b[A", 1);
  expect(help.state.group).toBe("Navigation");
  for (const key of ["j", "\x1b[B"]) {
    help.handleInput(key, 1);
    help.render(90, 100, theme);
  }
  expect(help.state.group).toBe("Execution");
  expect(help.render(90, 100, theme).join("\n")).toContain("› Execution");
  help.handleInput("\x1b[A", 1);
  expect(help.state.group).toBe("Display");
  help.handleInput("\x1b[Z", 1);
  expect(help.state.group).toBe("Navigation");
  help.handleInput("\x1b[Z", 1);
  expect(help.state.group).toBe("Dock/Mouse");
  help.render(90, 100, theme);
  help.handleInput("j", 1);
  expect(help.state.group).toBe("Dock/Mouse");
  help.handleInput("\t", 1);
  expect(help.state.group).toBe("Navigation");
});

test("successive fitted keys move through categories before an asynchronous repaint", () => {
  const help = new Help();
  help.render(120, 100, theme);
  help.handleInput("j", 1);
  help.handleInput("j", 1);
  help.handleInput("\x1b[B", 1);
  expect(help.state.group).toBe("Editing");
  help.handleInput("k", 1);
  expect(help.state.group).toBe("Execution");
});

test("resizing switches between row scrolling and category selection", () => {
  const help = new Help();
  expect(help.render(90, 13, theme).at(-1)).toContain("j/k scroll");
  help.handleInput("j", 1);
  expect(help.state).toMatchObject({ group: "Navigation", scroll: 1 });
  help.render(90, 100, theme);
  expect(help.state.scroll).toBe(0);
  help.handleInput("j", 1);
  expect(help.state).toMatchObject({ group: "Display", scroll: 0 });
  help.render(46, 12, theme);
  help.handleInput("j", 1);
  expect(help.state).toMatchObject({ group: "Display", scroll: 1 });
  help.handleInput("\t", 1);
  expect(help.state).toMatchObject({ group: "Execution", scroll: 0 });
});

test.each([24, 46, 90, 180])("Display legend is reachable and fits at width %i", width => {
  const help = new Help({ group: "Display", query: "", typing: false, scroll: 0 });
  const text = [...collect(help, width)].filter(row => !row.includes("Tab categories") && !row.includes("/ search")).join(" ").replace(/\s+/gu, " ");
  for (const phrase of [" wait queued", " edit edited, not rerun", " agent changed by agent", " new created by agent", " old stale", " block ancestor failed", " off disabled", " err error"]) {
    expect(text).toContain(phrase);
  }
});

test("fitted real registry navigation uses the rendered viewport", async () => {
  vi.resetModules();
  vi.doUnmock("../src/ui/keys.js");
  const { Help: RealHelp } = await import("../src/ui/help.js");
  const help = new RealHelp();
  help.render(120, 100, theme);
  help.handleInput("j", 1);
  expect(help.state.group).toBe("Display");
  help.render(120, 100, theme);
  help.handleInput("\x1b[A", 1);
  expect(help.state.group).toBe("Navigation");
});

test("search groups multiple categories and keeps distinct descriptions discoverable", () => {
  const help = new Help();
  enterSearch(help, "Description");
  const rows = [...collect(help, 120, 30)].join("\n");
  for (const group of GROUPS) expect(rows).toContain(group);
  expect(rows).toContain("ending_9_12.");
});

test("key column switches at 40 and 60 and never pairs unrelated actions", () => {
  expect(new Help().render(39, 12, theme)[2]).toBe("key0_0 / Ctrl+0");
  expect(new Help().render(40, 12, theme)[2]!.indexOf("Navigation action 0")).toBe(18);
  expect(new Help().render(60, 12, theme)[2]!.indexOf("Navigation action 0")).toBe(24);
});

test("styles are recomputed after a theme change", () => {
  const help = new Help();
  help.render(90, 30, theme);
  const changed = { fg: (color: string, value: string) => `\x1b[${color === "accent" ? 31 : 32}m${value}\x1b[0m`, bold: theme.bold };
  const rows = help.render(90, 30, changed);
  expect(rows.join("\n")).toContain("\x1b[31mkey0_0");
  expect(rows.join("\n")).toContain("\x1b[31m› Navigation");
  for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(90);
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
