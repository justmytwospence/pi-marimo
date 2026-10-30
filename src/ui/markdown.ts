import MarkdownIt from "markdown-it";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, getCellDimensions, sliceByColumn, stripTerminalSequences, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { codePanelRows } from "./code.js";
import type { Row, RowOptions } from "./rows.js";

export interface ExtractedCodeBlock {
  id: string;
  marker: string;
  content: string;
  language: string;
  map: [number, number];
  source: string;
  prefix: string;
}
export interface ExtractedCodeBlocks { text: string; blocks: ExtractedCodeBlock[] }
/** markdown-it owns all block recognition and container indentation handling. */
export function extractCodeBlocks(text: string): ExtractedCodeBlocks {
  const parser = new MarkdownIt({ html: false });
  const prefixes = new Map<number, string>();
  for (const name of ["fence", "code"]) {
    const rule = parser.block.ruler.getRules("").find(rule => rule.name === name);
    if (!rule) throw new Error(`markdown-it ${name} rule unavailable`);
    parser.block.ruler.at(name, (state, start, end, silent) => {
      const begin = state.bMarks[start]!;
      const position = begin + state.tShift[start]!;
      const lineStart = state.src.lastIndexOf("\n", begin - 1) + 1;
      const prefix = state.src.slice(lineStart, Math.max(begin, position));
      const accepted = rule(state, start, end, silent);
      if (accepted && !silent) prefixes.set(start, prefix);
      return accepted;
    });
  }
  const tokens = parser.parse(text, {});
  const lines = text.split("\n");
  const blocks: ExtractedCodeBlock[] = [];
  let candidate = 0xe000;
  for (const token of tokens) {
    if ((token.type !== "fence" && token.type !== "code_block") || !token.map) continue;
    while (text.includes(String.fromCodePoint(candidate))) candidate++;
    const marker = String.fromCodePoint(candidate++);
    const map: [number, number] = [token.map[0], token.map[1]];
    blocks.push({ id: `markdown:${map[0]}`, marker, content: token.content, language: parser.utils.unescapeAll(token.info).trim().split(/\s+/)[0] ?? "", map, source: lines.slice(...map).join("\n"), prefix: prefixes.get(map[0]) ?? "" });
  }
  for (const block of [...blocks].reverse()) {
    // Blank separators prevent a marker from merging into a neighboring paragraph.
    lines.splice(block.map[0], block.map[1] - block.map[0], `${block.prefix}${block.marker}`, "");
  }
  return { text: lines.join("\n"), blocks };
}
const plain = (text: string) => text;
const fallbackTheme: MarkdownTheme = { heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain, codeBlockBorder: plain, quote: plain, quoteBorder: plain, hr: plain, listBullet: plain, bold: plain, italic: plain, strikethrough: plain, underline: plain };
const extractionCache = new Map<string, ExtractedCodeBlocks>();
const renderCache = new Map<string, { rows: Row[]; bytes: number }>();
let renderBytes = 0;
const identities = new WeakMap<object, number>();
let identity = 0;
const identify = (object: object | undefined) => {
  if (!object) return 0;
  if (!identities.has(object)) identities.set(object, ++identity);
  return identities.get(object)!;
};
const clearRenderCache = () => { renderCache.clear(); renderBytes = 0; };
/** Render prose with Pi, then splice untouched payloads into the rendered containers. */
export function markdownRows(text: string, options: RowOptions = {}): Row[] {
  const cell = getCellDimensions();
  // Diagram/image rows depend on the vertical budget and pixel geometry, not just columns.
  const cacheKey = JSON.stringify([text, options.width, options.imageRows, cell.widthPx, cell.heightPx, options.pad, options.bar, options.theme?.appearance, options.lineNumbers, options.tabstop, options.blockPrefix, [...options.codeOffsets ?? []], identify(options.theme), identify(options.syntax), options.syntax?.revision, identify(options.diagramRows), identify(options.onReady)]);
  const known = options.theme ? renderCache.get(cacheKey) : undefined;
  if (known) { renderCache.delete(cacheKey); renderCache.set(cacheKey, known); return known.rows.map(row => ({ ...row })); }
  const onReady = options.onReady;
  options = { ...options, onReady: () => { clearRenderCache(); onReady?.(); } };
  let extracted = extractionCache.get(text);
  if (!extracted) {
    extracted = extractCodeBlocks(text);
    if (Buffer.byteLength(text) <= 1024 * 1024) {
      extractionCache.set(text, extracted);
      if (extractionCache.size > 32) extractionCache.delete(extractionCache.keys().next().value!);
    }
  }
  let theme: MarkdownTheme;
  try { theme = getMarkdownTheme(); } catch { theme = fallbackTheme; }
  const markers = new Set(extracted.blocks.map(block => block.marker));
  const width = Math.max(1, options.width ?? 80);
  const render = (theme: MarkdownTheme) => {
    const markdown = new Markdown(extracted!.text, 0, 0, { ...theme, codeBlockIndent: "", codeBlockBorder: () => "", highlightCode: code => code.split("\n").filter(line => markers.has(line.trim())).map(line => line.trim()) });
    (markdown as unknown as Record<symbol, unknown>)[Symbol.for("pi-prose-width.skip")] = true;
    return markdown.render(width);
  };
  let rendered: string[];
  try { rendered = render(theme); } catch { rendered = render(fallbackTheme); }
  const rows: Row[] = [];
  for (const line of rendered) {
    const block = extracted.blocks.find(block => line.includes(block.marker));
    if (!block) { rows.push({ text: line }); continue; }
    const before = line.slice(0, line.indexOf(block.marker));
    const prefixWidth = visibleWidth(before);
    // List bullets appear only on the first line; quote borders persist on every line.
    const continuation = stripTerminalSequences(before).replace(/[^\s│┃>]/gu, " ");
    const inner = { ...options, width: Math.max(1, width - prefixWidth), blockId: options.blockPrefix ? `${options.blockPrefix}:${block.id}` : block.id };
    const payload = block.content.endsWith("\n") ? block.content.slice(0, -1) : block.content;
    const body = block.language.toLowerCase() === "mermaid"
      ? options.diagramRows?.(payload, inner) ?? [{ text: "Mermaid: diagram renderer unavailable", blockId: block.id }, ...codePanelRows(payload, { ...inner, language: "mermaid" })]
      : codePanelRows(payload, { ...inner, language: block.language || "text" });
    for (let i = 0; i < body.length; i++) rows.push({ ...body[i]!, text: (i ? continuation : before) + sliceByColumn(body[i]!.text, 0, inner.width, true) });
  }
  const bytes = Buffer.byteLength(cacheKey) + rows.reduce((n, row) => n + Buffer.byteLength(row.text), 0);
  if (options.theme && bytes <= 4 * 1024 * 1024) {
    renderCache.set(cacheKey, { rows, bytes }); renderBytes += bytes;
    while (renderCache.size > 128 || renderBytes > 4 * 1024 * 1024) {
      const oldest = renderCache.keys().next().value!;
      renderBytes -= renderCache.get(oldest)!.bytes; renderCache.delete(oldest);
    }
  }
  return rows.map(row => ({ ...row }));
}
