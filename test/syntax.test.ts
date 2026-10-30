import { describe, expect, it } from "vitest";
import { foregroundAnsi, getCapabilities, getTerminalColorMode, parseColor, setCapabilities, stripTerminalSequences } from "@earendil-works/pi-tui";
import { CellConsole } from "../src/core/console.js";
import { SyntaxHighlighter, type SyntaxTheme } from "../src/ui/syntax.js";
const theme: SyntaxTheme = { fg: (_, s) => s, bold: s => s, colors: Object.fromEntries(["text", "syntaxKeyword", "syntaxString", "syntaxNumber", "syntaxComment", "syntaxFunction", "syntaxType", "syntaxOperator", "syntaxPunctuation"].map((key, i) => [key, parseColor(i + 1)])) };
const ready = (syntax: SyntaxHighlighter, code: string, language: string, t = theme) => new Promise<void>(resolve => syntax.request(code, language, t, resolve));
// Inspect actual terminal cells, including indexed-color conversion and font attributes.
async function cells(line: string) {
  const terminal = new CellConsole();
  try {
    await terminal.append({ data: line, channel: "stdout", mimetype: "text/plain" });
    return terminal.snapshot()[0]!.styles!;
  } finally { terminal.dispose(); }
}
async function semantic(line: string, word: string, color: string | number, attributes: Record<string, boolean> = {}, from = 0) {
  line = line.replaceAll("\t", "        ");
  const column = stripTerminalSequences(line).indexOf(word, from);
  expect(column).toBeGreaterThanOrEqual(0);
  const spans = await cells(line);
  const expected = (await cells(foregroundAnsi(parseColor(color), getTerminalColorMode()) + "x"))[0]!;
  for (let i = column; i < column + word.length; i++) {
    const span = spans.find(span => span.column <= i && span.column + span.width > i)!;
    expect(span).toMatchObject({ fg: expected.fg, fgMode: expected.fgMode, fgDefault: false, ...attributes });
  }
}
describe("semantic syntax", () => {
  const colors = { text: "#dddddd", syntaxKeyword: "#ff3333", syntaxString: "#33cc33", syntaxNumber: "#3333ff", syntaxComment: "#999999", syntaxFunction: "#cc33cc", syntaxType: "#33cccc", syntaxOperator: "#cccc33", syntaxPunctuation: "#775533", mdHeading: "#ff9933", mdLink: "#9966ff" };
  const themed = (appearance: "light" | "dark"): SyntaxTheme => ({ ...theme, appearance, colors: Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, parseColor(value)])) });
  it.each(["light", "dark"] as const)("colors Python scopes without recoloring literals in %s themes", async appearance => {
    const syntax = new SyntaxHighlighter();
    const code = '@decorator\ndef f(x: str):\n\tmo.md(f"hello {x}")\n\tplt.subplots(nrows=2)\n\tobj.attribute\n\tprint("mo.md nrows") # plt.subplots';
    const t = themed(appearance);
    try {
      await ready(syntax, code, "py", t);
      const lines = syntax.request(code, "python", t);
      expect(lines.map(stripTerminalSequences)).toEqual(code.split("\n"));
      await semantic(lines[0]!, "@decorator", colors.syntaxFunction);
      await semantic(lines[1]!, "def", colors.syntaxKeyword);
      await semantic(lines[1]!, "f", colors.syntaxFunction, {}, 4);
      await semantic(lines[1]!, "x", colors.syntaxType);
      await semantic(lines[1]!, "str", colors.syntaxType);
      await semantic(lines[2]!, "md", colors.syntaxFunction);
      await semantic(lines[2]!, 'f"hello ', colors.syntaxString);
      await semantic(lines[2]!, "{", colors.syntaxOperator);
      await semantic(lines[2]!, "}", colors.syntaxOperator);
      await semantic(lines[3]!, "subplots", colors.syntaxFunction);
      await semantic(lines[3]!, "nrows", colors.syntaxType);
      await semantic(lines[3]!, "2", colors.syntaxNumber);
      await semantic(lines[3]!, "(", colors.syntaxPunctuation);
      await semantic(lines[4]!, "attribute", colors.syntaxType);
      await semantic(lines[5]!, "print", colors.syntaxFunction);
      await semantic(lines[5]!, '"mo.md nrows"', colors.syntaxString);
      await semantic(lines[5]!, "# plt.subplots", colors.syntaxComment);
    } finally { syntax.dispose(); }
  });
  it("distinguishes Mermaid keywords/arrows, direction and nodes", async () => {
    const syntax = new SyntaxHighlighter(); const code = "graph TD\n A-->B"; const t = themed("dark");
    try {
      await ready(syntax, code, "mermaid", t);
      const lines = syntax.request(code, "mermaid", t);
      expect(lines.map(stripTerminalSequences)).toEqual(code.split("\n"));
      await semantic(lines[0]!, "graph", colors.syntaxKeyword);
      await semantic(lines[0]!, "TD", colors.syntaxFunction);
      await semantic(lines[1]!, "A", colors.syntaxType);
      await semantic(lines[1]!, "-->", colors.syntaxKeyword);
      await semantic(lines[1]!, "B", colors.syntaxType);
    } finally { syntax.dispose(); }
  });
  it.each([true, false])("renders Markdown semantic colors and styles (trueColor=%s)", async trueColor => {
    const original = getCapabilities(); setCapabilities({ ...original, trueColor });
    const syntax = new SyntaxHighlighter(); const t = themed("light");
    const code = "# Heading\n**bold** *italic* `raw` [link](https://example.com)";
    try {
      await ready(syntax, code, "md", t);
      const lines = syntax.request(code, "markdown", t);
      expect(lines.map(stripTerminalSequences)).toEqual(code.split("\n"));
      await semantic(lines[0]!, "# Heading", colors.mdHeading, { bold: true });
      await semantic(lines[1]!, "**bold**", colors.text, { bold: true });
      await semantic(lines[1]!, "*italic*", colors.text, { italic: true });
      await semantic(lines[1]!, "`raw`", colors.syntaxString);
      await semantic(lines[1]!, "https://example.com", colors.mdLink, { underline: true });
    } finally { syntax.dispose(); setCapabilities(original); }
  });
  it("fingerprints optional colors and uses semantic, accent and text fallbacks", async () => {
    const syntax = new SyntaxHighlighter(); const code = "# Heading\n<https://example.com>";
    try {
      for (const [extra, heading, link] of [
        [{}, colors.syntaxFunction, colors.syntaxString],
        [{ mdHeading: parseColor(colors.mdHeading), mdLink: parseColor(colors.mdLink) }, colors.mdHeading, colors.mdLink],
      ] as const) {
        const t = { ...themed("dark"), colors: { ...themed("dark").colors, ...extra } };
        if (!("mdHeading" in extra)) { delete t.colors.mdHeading; delete t.colors.mdLink; }
        await ready(syntax, code, "md", t);
        const lines = syntax.request(code, "md", t);
        await semantic(lines[0]!, "Heading", heading, { bold: true });
        await semantic(lines[1]!, "https://example.com", link, { underline: true });
      }
      for (const key of ["accent", "text"]) {
        const t = { ...theme, colors: { [key]: parseColor("#abcdef") } };
        await ready(syntax, code, "md", t);
        const lines = syntax.request(code, "md", t);
        await semantic(lines[0]!, "Heading", "#abcdef", { bold: true });
        await semantic(lines[1]!, "https://example.com", "#abcdef", { underline: true });
      }
    } finally { syntax.dispose(); }
  });
});
describe("lazy Shiki", () => {
  it("returns plain immediately, preserves multiline Python and deduplicates concurrent loads", async () => {
    const syntax = new SyntaxHighlighter();
    const code = '@decorator\ndef f(x: str) -> str:\n\treturn f"""hello {x}\n世界\n"""\n\n';
    expect(syntax.request(code, "python", theme)).toEqual(code.split("\n"));
    await Promise.all([ready(syntax, code, "python"), ready(syntax, code, "py")]);
    const highlighted = syntax.request(code, "py", theme);
    expect(highlighted.map(stripTerminalSequences)).toEqual(code.split("\n"));
    expect(highlighted.join("")).toContain("\x1b[");
    syntax.dispose();
  });
  it.each(["js", "ts", "json", "sh", "yml", "r", "sql"])("assigns semantic string colors for %s", async lang => {
    const syntax = new SyntaxHighlighter();
    const code = lang === "sql" ? "SELECT 'hello'" : lang === "json" ? '{"key": "hello"}' : 'value = "hello"';
    try {
      await ready(syntax, code, lang);
      await semantic(syntax.request(code, lang, theme)[0]!, "hello", "#808000");
    } finally { syntax.dispose(); }
  });
  it("rejects oversized UTF-8 input before lazy initialization", () => {
    const syntax = new SyntaxHighlighter();
    const code = "é".repeat(2 * 1024 * 1024 + 1);
    expect(syntax.request(code, "py", theme)).toEqual([code]);
    expect((syntax as any).highlighter).toBeUndefined();
    syntax.dispose();
  });
  it.each(["sql", "js", "ts", "json", "sh", "yml", "r", "md"])("supports %s and aliases", async lang => {
    const syntax = new SyntaxHighlighter(); const code = 'a = "b"\n\t# comment\n';
    await ready(syntax, code, lang);
    expect(syntax.request(code, lang, theme).map(stripTerminalSequences)).toEqual(code.split("\n")); syntax.dispose();
  });
  it("handles unknown/minimal themes and disposal without work", () => {
    const syntax = new SyntaxHighlighter();
    expect(syntax.request("x\t\n", "unknown", theme)).toEqual(["x\t", ""]);
    expect(syntax.request("pass", "python", { fg: (_, s) => s, bold: s => s })).toEqual(["pass"]);
    expect(syntax.request("**plain**", "md", { ...theme, colors: {} })).toEqual(["**plain**"]);
    syntax.dispose(); expect(syntax.request("pass", "py", theme)).toEqual(["pass"]);
  });
  it("falls back after one failed grammar diagnostic", async () => {
    const diagnostics: string[] = [];
    const syntax = new SyntaxHighlighter(message => diagnostics.push(message));
    (syntax as any).highlighter = Promise.resolve({ loadLanguage: () => Promise.reject(new Error("fixture failure")), dispose: () => {} });
    await ready(syntax, "pass\n", "py");
    expect(syntax.request("pass\n", "py", theme)).toEqual(["pass", ""]);
    expect(diagnostics).toHaveLength(1);
    syntax.dispose();
  });
  it("rethemes on invalidation and bounds the LRU", async () => {
    const syntax = new SyntaxHighlighter();
    for (let i = 0; i < 130; i++) await ready(syntax, `pass # ${i}`, "py");
    expect((syntax as any).cache.size).toBe(128);
    const first = syntax.request("pass # 129", "py", theme).join("");
    syntax.invalidate();
    const changed = { ...theme, colors: { ...theme.colors, syntaxKeyword: parseColor("#abcdef") } };
    await ready(syntax, "pass # 129", "py", changed);
    expect(syntax.request("pass # 129", "py", changed).join("")).not.toBe(first);
    syntax.dispose();
  });
});
