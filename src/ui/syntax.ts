import { createHash } from "node:crypto";
import { colorToHex, foregroundAnsi, getTerminalColorMode, parseColor, styleText, type Color } from "@earendil-works/pi-tui";
import { bundledLanguages, bundledLanguagesInfo, createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import type { FrameTheme } from "../frame.js";

export type SyntaxTheme = FrameTheme & { colors?: Readonly<Record<string, Color>>; appearance?: "dark" | "light" };
/** Specific punctuation only: a blanket rule overrides strings, comments and markup. */
function syntaxRules(colors: Readonly<Record<string, Color>>) {
  const rule = (scope: string[], keys: string[], fontStyle?: string) => {
    const color = keys.map(key => colors[key]).find(color => color !== undefined);
    return { scope, settings: { ...(color !== undefined ? { foreground: colorToHex(color) } : {}), ...(fontStyle !== undefined ? { fontStyle } : {}) } };
  };
  return [
    rule(["keyword", "storage"], ["syntaxKeyword"]),
    rule(["string"], ["syntaxString"]),
    rule(["constant.numeric", "constant.language", "constant.character"], ["syntaxNumber"]),
    rule(["comment"], ["syntaxComment"]),
    rule(["entity.name.function", "support.function", "meta.function-call.generic.python", "punctuation.definition.decorator.python"], ["syntaxFunction"]),
    rule(["entity.name.type", "support.type", "variable", "variable.parameter", "meta.attribute.python"], ["syntaxType"]),
    rule(["keyword.operator"], ["syntaxOperator"]),
    rule(["punctuation.separator", "punctuation.section", "punctuation.definition.arguments", "punctuation.definition.parameters", "punctuation.definition.list", "punctuation.definition.dict"], ["syntaxPunctuation"]),
    rule(["punctuation.definition.string", "storage.type.string.python"], ["syntaxString"]),
    rule(["punctuation.section.interpolation", "punctuation.definition.interpolation", "constant.character.format.placeholder"], ["syntaxOperator", "syntaxNumber", "accent", "text"]),
    rule(["markup.heading", "entity.name.section"], ["mdHeading", "syntaxFunction", "accent", "text"], "bold"),
    rule(["markup.bold"], [], "bold"),
    rule(["markup.italic"], [], "italic"),
    rule(["markup.inline.raw"], ["syntaxString", "accent", "text"]),
    rule(["markup.underline.link"], ["mdLink", "syntaxString", "accent", "text"], "underline"),
  ];
}

/** One runtime owns this lazy service; render never waits on a grammar or WASM. */
export class SyntaxHighlighter {
  private highlighter?: Promise<Highlighter>;
  private loads = new Map<string, Promise<void>>();
  private cache = new Map<string, { lines: readonly string[]; bytes: number }>();
  private bytes = 0;
  private generation = 0;
  private disposed = false;
  get revision(): number { return this.generation; }
  private diagnosed = new Set<string>();
  constructor(private diagnostic: (message: string) => void = () => {}) {}

  request(code: string, language: string, theme: SyntaxTheme, onReady: () => void = () => {}): readonly string[] {
    const plain = code.split("\n");
    if (this.disposed || !theme.colors || Buffer.byteLength(code) > 4 * 1024 * 1024) return plain;
    const name = language.toLowerCase().trim();
    const lang = (bundledLanguagesInfo.find(info => info.id === name || info.aliases?.includes(name))?.id ?? name) as BundledLanguage;
    if (!(lang in bundledLanguages) || this.diagnosed.has(lang)) return plain;
    const colors = theme.colors;
    const palette = syntaxRules(colors);
    if (!palette.some(rule => rule.settings.foreground !== undefined)) return plain;
    const themeName = `pi-${this.generation}-${createHash("sha256").update(JSON.stringify([palette, colors.text, colors.toolPendingBg, theme.appearance])).digest("hex")}`;
    const mode = getTerminalColorMode();
    const key = JSON.stringify([createHash("sha256").update(code).digest("hex"), lang, themeName, mode]);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached.lines; }
    let load = this.loads.get(key);
    if (!load) {
      const generation = this.generation;
      this.highlighter ??= createHighlighter({ themes: [], langs: [] });
      load = this.highlighter.then(async (highlighter) => {
        const grammarKey = `grammar:${lang}`;
        let grammar = this.loads.get(grammarKey);
        if (!grammar) { grammar = highlighter.loadLanguage(lang); this.loads.set(grammarKey, grammar); }
        await grammar;
        if (this.disposed || generation !== this.generation) return;
        if (!highlighter.getLoadedThemes().includes(themeName)) await highlighter.loadTheme({ name: themeName, type: theme.appearance ?? "dark", colors: { "editor.foreground": colors.text ? colorToHex(colors.text) : "#cccccc", "editor.background": colors.toolPendingBg ? colorToHex(colors.toolPendingBg) : "#000000" }, tokenColors: palette });
        const result = highlighter.codeToTokens(code, { lang, theme: themeName });
        let lines = result.tokens.map(line => line.map(token => {
          const text = styleText(token.content, { bold: !!((token.fontStyle ?? 0) & 2), italic: !!((token.fontStyle ?? 0) & 1), underline: !!((token.fontStyle ?? 0) & 4) }, mode);
          return token.color ? foregroundAnsi(parseColor(token.color), mode) + text + "\x1b[39m" : text;
        }).join(""));
        let bytes = Buffer.byteLength(code) + lines.reduce((n, line) => n + Buffer.byteLength(line), 0);
        if (bytes > 8 * 1024 * 1024) { lines = plain; bytes = Buffer.byteLength(code) * 2; }
        if (bytes <= 8 * 1024 * 1024) {
          this.cache.set(key, { lines, bytes }); this.bytes += bytes;
          while (this.cache.size > 128 || this.bytes > 8 * 1024 * 1024) {
            const oldest = this.cache.keys().next().value!;
            this.bytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
          }
        }
      }).catch((error: unknown) => {
        if (!this.diagnosed.has(lang)) { this.diagnosed.add(lang); this.diagnostic(`Syntax highlighting unavailable: ${lang} (${error instanceof Error ? error.message : "grammar failure"})`); }
      });
      this.loads.set(key, load);
      void load.finally(() => { if (this.loads.get(key) === load) this.loads.delete(key); });
    }
    void load.then(() => { if (!this.disposed) onReady(); });
    return plain;
  }
  invalidate(): void { this.generation++; this.cache.clear(); this.bytes = 0; }
  dispose(): void { this.disposed = true; this.invalidate(); void this.highlighter?.then(h => h.dispose(), () => {}); this.loads.clear(); }
}
