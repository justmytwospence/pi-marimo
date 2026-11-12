import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { formatHelpKey } from "../src/ui/help.js";
import { COMMANDS, GROUPS } from "../src/ui/keys.js";

const escape = (text: string) => text.replaceAll("|", "\\|");

/** docs/reference/keys.md, from the command registry that also drives dispatch, help and the palette. */
function keysReference(): string {
  const out = ["# Keys", "", "Generated from `src/ui/keys.ts`; do not edit. The `?` cheat sheet in the view shows the same list, and `ctrl+p` searches it.", ""];
  for (const group of GROUPS) {
    const rows = COMMANDS.filter((c) => c.group === group);
    if (!rows.length) continue;
    out.push(`## ${group}`, "", "| Keys | Action | Where |", "|---|---|---|");
    for (const c of rows) {
      const keys = c.keys.map((k) => `\`${escape(formatHelpKey(k))}\``).join(" / ");
      const action = c.description === c.label ? c.label : `${c.label}: ${c.description}`;
      out.push(`| ${keys} | ${escape(action)} | ${c.modes.length ? c.modes.join(", ") : "Pi"} |`);
    }
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

test("docs/reference/keys.md is generated from the command registry (UPDATE_DOCS=1 rewrites it)", () => {
  const file = new URL("../docs/reference/keys.md", import.meta.url);
  if (process.env.UPDATE_DOCS === "1") writeFileSync(file, keysReference());
  expect(readFileSync(file, "utf8")).toBe(keysReference());
});
