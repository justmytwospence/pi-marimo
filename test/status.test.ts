import { describe, expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { NotebookState } from "../src/core/notebook.js";
import { notebookLines } from "../src/ui/outline.js";
import { setIcons } from "../src/ui/glyphs.js";
import { STATUS_STYLE, cellBadges, fitBadges, renderBadge, spinner, statusIcon, statusLabel } from "../src/ui/status.js";

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
  test("chips are bare colored icons: no background, no brackets", () => {
    const badge = { kind: "error", text: "x" } as const;
    const bg = vi.fn((_token: string, text: string) => `<bg>${text}</bg>`);
    expect(renderBadge(badge, { ...theme, bg } as typeof theme)).toBe("x");
    expect(bg).not.toHaveBeenCalled();
    expect(renderBadge(badge, theme)).toBe("x");
  });
  test("fitting keeps whole chips in attention order", () => {
    const queued = statusIcon("queued"), changed = statusIcon("changed");
    const badges = [{ kind: "queued", text: queued }, { kind: "changed", text: changed }] as const;
    expect(fitBadges(badges, 3, theme)).toBe(`${queued} ${changed}`);
    expect(fitBadges(badges, 2, theme)).toBe(queued);
    expect(fitBadges(badges, 0, theme)).toBe("");
    expect(fitBadges(badges, -1, theme)).toBe("");
  });
  test("view.icons false shows plain symbols and bare labels", () => {
    setIcons(false);
    try {
      expect(statusIcon("stale")).toBe("↻");
      expect(statusLabel("error")).toBe("error");
      for (const kind of Object.keys(STATUS_STYLE) as Array<keyof typeof STATUS_STYLE>) {
        expect(statusIcon(kind)).not.toMatch(/[\uE000-\uF8FF]/u);
        expect(statusLabel(kind)).not.toMatch(/[\uE000-\uF8FF]/u);
      }
    } finally { setIcons(true); }
  });
  test("each chip has a distinct Nerd Font icon and plain symbol, one column wide", () => {
    const styles = Object.values(STATUS_STYLE);
    expect(new Set(styles.map(({ icon }) => icon)).size).toBe(8);
    expect(new Set(styles.map(({ plain }) => plain)).size).toBe(8);
    expect(Object.values(STATUS_STYLE).map(({ plain }) => plain).join("")).toBe("◌✗⊘↻✎✦+–");
    for (const kind of Object.keys(STATUS_STYLE) as Array<keyof typeof STATUS_STYLE>) expect(visibleWidth(statusIcon(kind))).toBe(1);
    const { nb, cell } = setup();
    cell.error = "SomeExceptionName: long exception";
    expect(cellBadges(nb, cell, 0).map(b => b.text)).toEqual([statusIcon("error")]);
  });
  test("stale and edited cells show their chip and no gutter dot", () => {
    const { nb, cell } = setup();
    cell.stale = true;
    const plain = notebookLines(nb, theme, 0, { width: 46 }).lines[0]!.replace(/\x1b\[[0-9;]*m/gu, "");
    expect(plain).toContain(statusIcon("stale"));
    expect(plain).not.toContain("•");
  });
  test("outline omits whole chips at narrow widths, keeps human titles and shape fallback", () => {
    const { nb, cell } = setup();
    cell.status = "queued";
    for (const width of [8, 12, 18, 24, 46]) {
      const line = notebookLines(nb, theme, 0, { width }).lines[0]!;
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).not.toContain("secret-id");
      const plain = line.replace(/\x1b\[[0-9;]*m/gu, "");
      expect(plain.includes("["), plain).toBe(plain.includes("[ wait]"));
    }
    expect(notebookLines(nb, theme, 0, { width: 46 }).lines[0]).toContain("Human title");
    cell.status = "idle";
    cell.output = { kind: "image", text: "", image: { data: "abc", mime: "image/png" } };
    expect(notebookLines(nb, theme, 0, { width: 46 }).lines[0]).toContain("image");
  });
});
