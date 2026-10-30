import { describe, expect, it, vi } from "vitest";
import { Markdown, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { extractCodeBlocks, markdownRows } from "../src/ui/markdown.js";
import { SyntaxHighlighter, type SyntaxTheme } from "../src/ui/syntax.js";
const plain = (s: string, options = {}) => markdownRows(s, options).map(row => stripTerminalSequences(row.text));
describe("source mapped markdown", () => {
  it.each([46, 80, 120, 180])("uses the full prose width at %i", width => {
    const lines = plain(Array(100).fill("word").join(" "), { width });
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    expect(Math.max(...lines.map(visibleWidth))).toBeGreaterThan(width - 6);
  });
  it("extracts tildes, indented and unclosed fences without losing tabs or spans", () => {
    const source = '~~~py\na\tb\n~~~\n\n    x\ty\n\n```js\nlast\tline';
    const { blocks, text } = extractCodeBlocks(source);
    expect(blocks.map(block => block.content)).toEqual(['a\tb\n', 'x\ty\n', 'last\tline']);
    expect(blocks[0]?.source).toBe('~~~py\na\tb\n~~~');
    expect(text).not.toContain('a\tb');
  });
  it("keeps nested lists/quotes and payload tabs", () => {
    const source = '> - item\n>\n>   ```py\n>   \tx = 1\n>   ```\n>\n>   after';
    const extracted = extractCodeBlocks(source);
    expect(extracted.blocks).toHaveLength(1);
    expect(extracted.blocks[0]?.content).toBe('\tx = 1\n');
    const rows = plain(source, { width: 46 });
    expect(rows.some(line => line.includes('x = 1'))).toBe(true);
    expect(rows.join('\n')).not.toMatch(/[\ue000-\uf8ff]/u);
    expect(rows.some(line => line.includes('after'))).toBe(true);
  });
  it("preserves container tab indentation and selects absent one-column markers", () => {
    const result = extractCodeBlocks('- item\n\n\t```py\n\t\tx\ty\n\t```\n\n\ue000\n\n```\nz\n```');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.content).toContain('\tx\ty');
    expect(result.blocks.every(block => block.marker !== '\ue000')).toBe(true);
  });
  it("keeps adjacent blocks separate and diagram identities independent", () => {
    const ids: string[] = [];
    const rows = markdownRows('```mermaid\na-->b\n```\n```mermaid\nc-->d\n```', { diagramRows: (source, options) => { ids.push(options.blockId); return [{ text: source }]; } });
    expect(rows.map(row => row.text).join('\n')).toContain('a-->b');
    expect(new Set(ids).size).toBe(2);
  });
  it("does not reflow code and respects tabstop, offsets and numbers", () => {
    const source = '```py\n\t' + 'x'.repeat(2100) + 'TAIL\n```';
    const block = extractCodeBlocks(source).blocks[0]!;
    const rows = plain(source, { width: 8, tabstop: 8, codeOffsets: new Map([[block.id, { offset: 2104 }]]) });
    expect(rows.join('\n')).toContain('TAIL');
    expect(plain('```\na\tb\n```', { width: 80, tabstop: 8 }).join('\n')).toContain('a       b');
  });
  it("marks each Pi Markdown instance for full-width rendering", () => {
    const original = Markdown.prototype.render;
    const seen: boolean[] = [];
    const spy = vi.spyOn(Markdown.prototype, "render").mockImplementation(function(this: Markdown, width) {
      seen.push((this as any)[Symbol.for("pi-prose-width.skip")] === true);
      return original.call(this, width);
    });
    try { markdownRows("unique opt-out prose", { width: 46 }); expect(seen.length).toBeGreaterThan(0); expect(seen.every(Boolean)).toBe(true); }
    finally { spy.mockRestore(); }
  });
  it("invalidates cached plain rows after async grammar completion and theme changes", async () => {
    const syntax = new SyntaxHighlighter();
    const theme: SyntaxTheme = { fg: (_, s) => s, bold: s => s, colors: { syntaxKeyword: parseColor("#ff0000") } };
    let notify!: () => void;
    const finished = new Promise<void>(resolve => { notify = resolve; });
    const options = { syntax, theme, width: 80, onReady: notify };
    const text = "```py\npass\n```";
    markdownRows(text, options);
    await finished;
    expect(markdownRows(text, options).map(row => row.text).join("")).toContain("\x1b[");
    syntax.invalidate();
    expect(markdownRows(text, options).map(row => row.text).join("")).not.toContain("\x1b[");
    syntax.dispose();
  });
  it("falls back with complete Mermaid source", () => {
    const rows = plain('```mermaid\n' + 'x'.repeat(3000) + '\n```', { width: 4000 });
    expect(rows.join('\n')).toContain('Mermaid: diagram renderer unavailable');
    expect(rows.join('\n')).toContain('x'.repeat(3000));
  });
});
