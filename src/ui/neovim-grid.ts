import { backgroundAnsi, CURSOR_MARKER, foregroundAnsi, getTerminalColorMode, renderFakeCursor, rgbColor, visibleWidth } from "@earendil-works/pi-tui";

export interface GridCell { text: string; highlight: number }
export interface GridHighlight { foreground?: number; background?: number; special?: number; reverse?: boolean; bold?: boolean; italic?: boolean; underline?: boolean; undercurl?: boolean; strikethrough?: boolean }
export interface GridState {
  width: number; height: number; cells: GridCell[][]; highlights: Record<number, GridHighlight>;
  foreground: number; background: number; special: number;
  cursor: { row: number; col: number }; mode: string; modeIndex: number; modes: unknown[]; busy: boolean; error?: string;
}
export function emptyGrid(): GridState {
  return { width: 0, height: 0, cells: [], highlights: {}, foreground: 0xffffff, background: 0, special: 0xffffff, cursor: { row: 0, col: 0 }, mode: "normal", modeIndex: 0, modes: [], busy: false };
}
const blank = (): GridCell => ({ text: " ", highlight: 0 });
/** State is private until flush; returned snapshots never alias subsequent updates. */
export class NeovimGrid {
  private pending = emptyGrid();
  private committed = emptyGrid();
  snapshot(): GridState { return structuredClone(this.committed); }
  reduce(events: readonly unknown[][]): GridState | undefined {
    let published: GridState | undefined;
    for (const event of events) {
      const name = event[0];
      for (const raw of event.slice(1)) {
        const a = raw as any[];
        const s = this.pending;
        if (typeof name === "string" && name.startsWith("grid_") && a[0] !== 1) { s.error = "Unsupported Neovim grid"; continue; }
        switch (name) {
          case "grid_resize": {
            const [, w, h] = a;
            s.cells = Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => s.cells[r]?.[c] ?? blank())); s.width = w; s.height = h; break;
          }
          case "grid_clear": s.cells = Array.from({ length: s.height }, () => Array.from({ length: s.width }, blank)); break;
          case "grid_destroy": s.cells = []; s.width = s.height = 0; break;
          case "grid_line": {
            const [, row, start, cells] = a; let col = start, highlight = 0;
            if (!s.cells[row]) { s.error = "Invalid Neovim grid row"; break; }
            for (const cell of cells) {
              highlight = cell[1] ?? highlight;
              for (let n = 0; n < (cell[2] ?? 1); n++) {
                if (col >= s.width) { s.error = "Invalid Neovim grid column"; break; }
                s.cells[row]![col++] = { text: cell[0], highlight };
              }
            }
            break;
          }
          case "grid_cursor_goto": s.cursor = { row: a[1], col: a[2] }; break;
          case "grid_scroll": {
            const [, top, bottom, left, right, rows, cols] = a;
            const old = structuredClone(s.cells);
            for (let r = top; r < bottom; r++) for (let c = left; c < right; c++) {
              const sr = r + rows, sc = c + cols;
              s.cells[r]![c] = sr >= top && sr < bottom && sc >= left && sc < right ? old[sr]![sc]! : blank();
            }
            break;
          }
          case "hl_attr_define": s.highlights[a[0]] = a[1]; break;
          case "default_colors_set": [s.foreground, s.background, s.special] = a; break;
          case "mode_info_set": s.modes = a[1]; break;
          case "mode_change": s.mode = a[0]; s.modeIndex = a[1]; break;
          case "busy_start": s.busy = true; break;
          case "busy_stop": s.busy = false; break;
          case "flush": this.committed = structuredClone(s); published = this.snapshot(); break;
          default: if (typeof name === "string" && name.startsWith("grid_")) s.error = `Unsupported Neovim event: ${name}`;
        }
      }
    }
    return published;
  }
}
function rgb(value: number, background: boolean): string {
  if (value < 0) return `\x1b[${background ? 49 : 39}m`;
  const color = rgbColor(value >> 16 & 255, value >> 8 & 255, value & 255);
  return (background ? backgroundAnsi : foregroundAnsi)(color, getTerminalColorMode());
}
export function renderNeovimGrid(state: GridState, width = state.width, height = state.height, focused = true): string[] {
  if (width < 12 || height < 4 || state.error) {
    const message = state.error ?? "Enlarge the pane to edit";
    return Array.from({ length: height }, (_, i) => (i === 0 ? [...message].slice(0, width).join("") : "").padEnd(width));
  }
  return Array.from({ length: height }, (_, r) => {
    let line = "", columns = 0;
    for (let c = 0; c < Math.min(width, state.width); c++) {
      const cell = state.cells[r]?.[c] ?? blank();
      if (cell.text === "") continue; // native wide-cell continuation
      const span = visibleWidth(cell.text);
      if (c + span > width) break;
      const hl = state.highlights[cell.highlight] ?? {};
      let fg = hl.foreground ?? state.foreground, bg = hl.background ?? state.background;
      if (hl.reverse) [fg, bg] = [bg, fg];
      const styles = [hl.bold && "1", hl.italic && "3", (hl.underline || hl.undercurl) && "4", hl.strikethrough && "9"].filter(Boolean);
      let text = cell.text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
      // A wide continuation cursor belongs to the preceding wide cell.
      if (r === state.cursor.row && state.cursor.col >= c && state.cursor.col < c + Math.max(1, span) && !state.busy) text = (focused ? CURSOR_MARKER : "") + renderFakeCursor(text);
      line += rgb(fg, false) + rgb(bg, true) + (styles.length ? `\x1b[${styles.join(";")}m` : "") + text + "\x1b[0m"; columns += span;
    }
    return line + " ".repeat(Math.max(0, width - columns));
  });
}
