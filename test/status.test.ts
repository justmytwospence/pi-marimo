import { describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { NotebookState } from "../src/core/notebook.js";
import { notebookLines } from "../src/ui/outline.js";
import { cellBadges, fitBadges, renderBadge, spinner } from "../src/ui/status.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function setup() {
  const nb = new NotebookState();
  nb.apply("kernel-ready", { cell_ids: ["secret-id"], codes: ["x = 1"], names: ["Human title"] });
  return { nb, cell: nb.cells.get("secret-id")! };
}

describe("state chips", () => {
  test("execution and agent change coexist, with explicit zero start and animated glyph", () => {
    const { nb, cell } = setup();
    cell.status = "running";
    cell.runningSince = 0;
    nb.agentChanges.set(cell.id, { kind: "edited", before: "x = 0", at: 1 });
    const badges = cellBadges(nb, cell, 2000);
    expect(badges.map((b) => b.kind)).toEqual(["running", "changed"]);
    expect(badges[0]!.text).toBe(`${spinner(2000)} 2.0s`);
    expect(spinner(100)).not.toBe(spinner(0));
  });
  test("independent errors, stale, edits and disabled states remain visible", () => {
    const { nb, cell } = setup();
    cell.lastRunCode = "x = 0";
    cell.error = "KeyError: missing";
    cell.stale = true;
    cell.disabled = true;
    expect(cellBadges(nb, cell, 0).map((b) => b.kind)).toEqual(["error", "stale", "edited", "disabled"]);
    delete cell.error;
    cell.blocked = "ancestor";
    cell.disabled = false;
    cell.status = "disabled-transitively";
    expect(cellBadges(nb, cell, 0).map((b) => b.kind)).toEqual(["blocked", "stale", "edited", "disabled"]);
  });
  test("semantic backgrounds when available, brackets for absent/inert/unsupported backgrounds", () => {
    const badge = { kind: "error", text: "error" } as const;
    expect(renderBadge(badge, { ...theme, bg: (token, text) => `<${token}>${text}</${token}>` })).toBe("<toolErrorBg> error </toolErrorBg>");
    expect(renderBadge(badge, theme)).toBe("[error]");
    expect(renderBadge(badge, { ...theme, bg: (_, text) => text })).toBe("[error]");
    expect(renderBadge(badge, { ...theme, bg: () => { throw new Error("unsupported"); } })).toBe("[error]");
  });
  test("fitting keeps whole chips in attention order", () => {
    const badges = [{ kind: "queued", text: "queued" }, { kind: "changed", text: "changed" }] as const;
    expect(fitBadges(badges, 18, theme)).toBe("[queued] [changed]");
    expect(fitBadges(badges, 8, theme)).toBe("[queued]");
    expect(fitBadges(badges, 7, theme)).toBe("");
    expect(fitBadges(badges, -1, theme)).toBe("");
  });
  test("outline omits whole chips at narrow widths, keeps human titles and shape fallback", () => {
    const { nb, cell } = setup();
    cell.status = "queued";
    for (const width of [8, 12, 18, 24, 46]) {
      const line = notebookLines(nb, theme, 0, { width }).lines[0]!;
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).not.toContain("secret-id");
      const plain = line.replace(/\x1b\[[0-9;]*m/gu, "");
      expect(plain.includes("["), plain).toBe(plain.includes("[queued]"));
    }
    expect(notebookLines(nb, theme, 0, { width: 46 }).lines[0]).toContain("Human title");
    cell.status = "idle";
    cell.output = { kind: "image", text: "", image: { data: "abc", mime: "image/png" } };
    expect(notebookLines(nb, theme, 0, { width: 46 }).lines[0]).toContain("image");
  });
});
