import { describe, expect, it } from "vitest";
import { parseColor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { SyntaxHighlighter, type SyntaxTheme } from "../src/ui/syntax.js";
const theme: SyntaxTheme = { fg: (_, s) => s, bold: s => s, colors: Object.fromEntries(["text", "syntaxKeyword", "syntaxString", "syntaxNumber", "syntaxComment", "syntaxFunction", "syntaxType", "syntaxOperator", "syntaxPunctuation"].map((key, i) => [key, parseColor(i + 1)])) };
const ready = (syntax: SyntaxHighlighter, code: string, language: string, t = theme) => new Promise<void>(resolve => syntax.request(code, language, t, resolve));
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
  it.each(["sql", "js", "ts", "json", "sh", "yml", "r", "md"])("supports %s and aliases", async lang => {
    const syntax = new SyntaxHighlighter(); const code = 'a = "b"\n\t# comment\n';
    await ready(syntax, code, lang);
    expect(syntax.request(code, lang, theme).map(stripTerminalSequences)).toEqual(code.split("\n")); syntax.dispose();
  });
  it("handles unknown/minimal themes and disposal without work", () => {
    const syntax = new SyntaxHighlighter();
    expect(syntax.request("x\t\n", "unknown", theme)).toEqual(["x\t", ""]);
    expect(syntax.request("pass", "python", { fg: (_, s) => s, bold: s => s })).toEqual(["pass"]);
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
