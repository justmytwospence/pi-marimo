import { describe, it, expect } from "vitest";
import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { NeovimGrid, renderNeovimGrid } from "../src/ui/neovim-grid.ts";
describe("Neovim linegrid", () => {
  it("reduces batched partial lines/repeats/attribute inheritance only at flush", () => {
    const g = new NeovimGrid();
    expect(g.reduce([["grid_resize", [1, 12, 4]], ["grid_line", [1, 0, 0, [["a", 2, 3], ["b"]]]]])).toBeUndefined();
    expect(g.snapshot().width).toBe(0);
    const first = g.reduce([["flush", []]])!;
    expect(first.cells[0]?.slice(0, 4)).toEqual([{ text: "a", highlight: 2 }, { text: "a", highlight: 2 }, { text: "a", highlight: 2 }, { text: "b", highlight: 2 }]);
    g.reduce([["grid_line", [1, 0, 2, [["Z", 0]]]], ["flush", []]]);
    expect(first.cells[0]?.[2]?.text).toBe("a"); expect(g.snapshot().cells[0]?.[2]?.text).toBe("Z");
  });
  it("scrolls rectangles in both dimensions and clears/resizes/destroys", () => {
    const g = new NeovimGrid();
    g.reduce([["grid_resize", [1, 12, 4]], ["grid_line", [1, 0, 0, [["a", 0, 12]]], [1, 1, 0, [["b", 0, 12]]]], ["grid_scroll", [1, 0, 2, 1, 4, 1, 1]], ["flush", []]]);
    expect(g.snapshot().cells[0]?.slice(0, 5).map(c => c.text).join("")).toBe("abb a");
    expect(g.snapshot().cells[1]?.[1]?.text).toBe(" ");
    g.reduce([["grid_clear", [1]], ["grid_resize", [1, 14, 5]], ["flush", []]]);
    expect(g.snapshot().cells[4]).toHaveLength(14);
    g.reduce([["grid_destroy", [1]], ["flush", []]]); expect(g.snapshot().cells).toEqual([]);
  });
  it("renders wide/combining cells, cursor, styles, default colors and exact geometry", () => {
    const g = new NeovimGrid();
    g.reduce([["grid_resize", [1, 12, 4]], ["default_colors_set", [0x123456, 0x654321, 0]], ["hl_attr_define", [2, { bold: true, italic: true, underline: true, reverse: true }, {}, []]], ["grid_line", [1, 0, 0, [["界", 2], [""], ["é", 0]]]], ["grid_cursor_goto", [1, 0, 1]], ["mode_info_set", [true, [{ cursor_shape: "block" }]]], ["mode_change", ["insert", 0]], ["flush", []]]);
    const rows = renderNeovimGrid(g.snapshot()); expect(rows).toHaveLength(4);
    expect(rows.every(r => visibleWidth(r.replace(CURSOR_MARKER, "")) === 12)).toBe(true);
    expect(rows[0]).toContain(CURSOR_MARKER); expect(rows[0]).toContain("1;3;4m"); expect(rows[0]).toContain("界"); expect(rows[0]).toContain("é");
    expect(g.snapshot().mode).toBe("insert");
    g.reduce([["busy_start", []], ["flush", []]]); expect(renderNeovimGrid(g.snapshot())[0]).not.toContain(CURSOR_MARKER);
    g.reduce([["busy_stop", []], ["default_colors_set", [0, 1, 2]], ["flush", []]]); expect(g.snapshot().foreground).toBe(0);
  });
  it("ignores optional notifications, errors on unsupported grids, and handles narrow rectangles", () => {
    const g = new NeovimGrid(); g.reduce([["optional_future", [42]], ["flush", []]]); expect(g.snapshot().error).toBeUndefined();
    expect(renderNeovimGrid(g.snapshot(), 24, 3)[0]?.trim()).toBe("Enlarge the pane to edit");
    g.reduce([["grid_resize", [2, 12, 4]], ["flush", []]]); expect(g.snapshot().error).toContain("Unsupported");
  });
});
