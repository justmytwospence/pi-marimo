// A current terminal display, not a lossless log. Streams have independent cursors.
import xterm from "@xterm/headless";
import { htmlToText, type ConsoleLine } from "./output.js";
import { progressFromText } from "./progress.js";

type Stream = "stdout" | "stderr";
type Screen = { terminal: InstanceType<typeof xterm.Terminal>; tail: Promise<void>; lines: ConsoleLine[]; order: number; level?: string };
const BATCH = 16_384;

export function consoleSeverity(stream: Stream, text: string, level?: string): ConsoleLine["severity"] {
  if (/^(error|critical|fatal)$/iu.test(level ?? "") || /Traceback \(most recent call last\)/u.test(text)) return "error";
  if (progressFromText([text]).length) return "progress";
  if (/\b(?:\w*Warning:|WARNING\b)/u.test(text) || level?.toLowerCase() === "warning") return "warning";
  return stream === "stderr" ? "stderr" : "output";
}

export class CellConsole {
  private streams = new Map<Stream, Screen>();
  private blocks: Array<{ order: number; lines: ConsoleLine[] }> = [];
  private sequence = 0;
  private generation = 0;
  private disposed = false;
  private pending = new Set<() => void>();
  constructor(private readonly onChange: () => void = () => {}) {}

  /** Resolves after accepted input has been consumed; callers can await it for backpressure. */
  append(raw: unknown): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (Array.isArray(raw)) {
      if (!raw.length) { this.clear(); return Promise.resolve(); }
      return Promise.all(raw.map(item => this.append(item))).then(() => {});
    }
    if (!raw || typeof raw !== "object") return Promise.resolve();
    const item = raw as Record<string, unknown>;
    if (typeof item.data !== "string" || !item.data) return Promise.resolve();
    const mime = String(item.mimetype ?? "text/plain");
    const traceback = mime.includes("traceback") || item.channel === "marimo-error";
    const stream: Stream = item.channel === "stderr" || traceback ? "stderr" : "stdout";
    const level = typeof item.level === "string" ? item.level : item.channel === "error" ? "error" : undefined;
    const order = ++this.sequence;
    if (mime.includes("html") || traceback) {
      const content = htmlToText(item.data).replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
      const text = content.length > 8000 ? `${content.slice(0, 8000)}\n[console MIME summary truncated]` : content;
      this.blocks.push({ order, lines: text.split("\n").map(text => ({ stream, text, severity: traceback ? "error" : consoleSeverity(stream, text, level) })) });
      // MIME blocks are bounded separately from terminal scrollback.
      while (this.blocks.length > 1000) this.blocks.shift();
      this.onChange();
      return Promise.resolve();
    }
    let screen = this.streams.get(stream);
    if (!screen) {
      screen = { terminal: new xterm.Terminal({ cols: 512, rows: 64, scrollback: 1000, allowProposedApi: true, convertEol: true }), tail: Promise.resolve(), lines: [], order };
      this.streams.set(stream, screen);
    }
    const target = screen;
    const generation = this.generation;
    const data = item.data;
    // At most one bounded write is in xterm's input queue per stream. No chunks dropped.
    target.tail = target.tail.then(async () => {
      for (let offset = 0; offset < data.length; offset += BATCH) {
        if (this.disposed || generation !== this.generation) return;
        await new Promise<void>(resolve => {
          this.pending.add(resolve);
          target.terminal.write(data.slice(offset, offset + BATCH), () => {
            this.pending.delete(resolve);
            if (!this.disposed && generation === this.generation) {
              target.order = order;
              target.level = level;
              target.lines = this.readScreen(target, stream);
              this.onChange();
            }
            resolve();
          });
        });
      }
    });
    return target.tail;
  }

  private readScreen(screen: Screen, stream: Stream): ConsoleLine[] {
    const buffer = screen.terminal.buffer.active;
    const lines: ConsoleLine[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      // Buffer text only: no OSC/DCS, hyperlinks, titles or clipboard bytes escape.
      const text = line.translateToString(true).replace(/[\x00-\x1f\x7f]/gu, "");
      const styles: NonNullable<ConsoleLine["styles"]> = [];
      const cells: NonNullable<ConsoleLine["cells"]> = [];
      for (let column = 0; column < line.length; column++) {
        const cell = line.getCell(column);
        // Coordinates stay in terminal columns, not UTF-16 offsets: a wide
        // glyph owns its continuation column, and combining marks share a cell.
        if (!cell || !cell.getChars() || cell.getWidth() === 0) continue;
        cells.push({ column, width: cell.getWidth(), text: cell.getChars() });
        const inverse = !!cell.isInverse();
        const fgDefault = cell.isFgDefault();
        const bgDefault = cell.isBgDefault();
        if (cell.isBold() || cell.isItalic() || cell.isUnderline() || inverse || !fgDefault || !bgDefault) {
          styles.push({ column, width: cell.getWidth(), bold: !!cell.isBold(), italic: !!cell.isItalic(), underline: !!cell.isUnderline(), inverse, fgDefault, bgDefault, fg: cell.getFgColor(), bg: cell.getBgColor(), fgMode: cell.getFgColorMode(), bgMode: cell.getBgColorMode() });
        }
      }
      const previous = screen.lines[i]?.text === text ? screen.lines[i] : screen.lines.find(line => line.text === text);
      const severity = previous?.severity ?? consoleSeverity(stream, text, screen.level);
      lines.push({ stream, text, severity, cells, ...(styles.length ? { styles } : {}) });
    }
    while (lines.at(-1)?.text === "") lines.pop();
    return lines;
  }

  snapshot(): ConsoleLine[] {
    return [...this.blocks, ...[...this.streams.values()].map(screen => ({ order: screen.order, lines: screen.lines }))]
      .sort((a, b) => a.order - b.order).flatMap(block => block.lines);
  }
  async settled(): Promise<void> { await Promise.all([...this.streams.values()].map(screen => screen.tail)); }
  clear(): void {
    this.generation++;
    for (const resolve of this.pending) resolve();
    this.pending.clear();
    for (const screen of this.streams.values()) screen.terminal.dispose();
    this.streams.clear(); this.blocks = [];
    if (!this.disposed) this.onChange();
  }
  dispose(): void { this.disposed = true; this.clear(); }
}
