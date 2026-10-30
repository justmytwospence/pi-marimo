import { isRecord } from "../config.ts";

export type Diagnostics = "all" | "errors" | "warnings" | "none";
export interface EditorOptions {
  tabstop: number;
  shiftwidth: number;
  expandtab: boolean;
  ignorecase: boolean;
  smartcase: boolean;
  scrolloff: number;
}
export interface ViewPreferences {
  lineNumbers: boolean;
  diagnostics: Diagnostics;
  showOutput: boolean;
  editor: { command: string; options: EditorOptions };
}
export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = {
  lineNumbers: false, diagnostics: "all", showOutput: true,
  editor: { command: "nvim", options: { tabstop: 4, shiftwidth: 4, expandtab: true, ignorecase: true, smartcase: true, scrolloff: 3 } },
};

/** Only native options in this allowlist reach the isolated editor. */
function validated(input: unknown): { value: ViewPreferences; invalid: string[] } {
  const value = structuredClone(DEFAULT_VIEW_PREFERENCES);
  const invalid: string[] = [];
  const record = isRecord(input) ? input : {};
  const check = (source: Record<string, unknown>, key: string, accept: (v: unknown) => boolean, apply: (v: any) => void, prefix = "view") => {
    if (!(key in source)) return;
    if (accept(source[key])) apply(source[key]);
    else invalid.push(`${prefix}.${key}`);
  };
  for (const key of ["lineNumbers", "showOutput"] as const) check(record, key, v => typeof v === "boolean", v => { value[key] = v; });
  check(record, "diagnostics", v => ["all", "errors", "warnings", "none"].includes(v as string), v => { value.diagnostics = v; });
  if (record.editor !== undefined && !isRecord(record.editor)) invalid.push("view.editor");
  const editor = isRecord(record.editor) ? record.editor : {};
  check(editor, "command", v => typeof v === "string" && v.trim().length > 0 && !v.includes("\0"), v => { value.editor.command = v; }, "view.editor");
  if (editor.options !== undefined && !isRecord(editor.options)) invalid.push("view.editor.options");
  const options = isRecord(editor.options) ? editor.options : {};
  for (const key of ["tabstop", "shiftwidth", "scrolloff"] as const) {
    const [min, max] = key === "scrolloff" ? [0, 20] : [1, 16];
    check(options, key, v => typeof v === "number" && Number.isInteger(v) && v >= min! && v <= max!, v => { value.editor.options[key] = v; }, "view.editor.options");
  }
  for (const key of ["expandtab", "ignorecase", "smartcase"] as const) check(options, key, v => typeof v === "boolean", v => { value.editor.options[key] = v; }, "view.editor.options");
  return { value, invalid };
}
export function normalizeViewPreferences(input: unknown): ViewPreferences { return validated(input).value; }

export type PreferencePatch = Partial<Omit<ViewPreferences, "editor">> & { editor?: { command?: string; options?: Partial<EditorOptions> } };
/** Runtime-owned preferences: live overrides survive view transfers, never write configuration. */
export class SessionPreferences {
  private value: ViewPreferences;
  private warned = false;
  constructor(input?: unknown, warn?: (message: string) => void) {
    this.value = normalizeViewPreferences(input);
    this.configure(input, warn);
  }
  configure(input: unknown, warn?: (message: string) => void): void {
    const result = validated(input);
    this.value = result.value;
    if (result.invalid.length && !this.warned && warn) {
      this.warned = true;
      warn(`marimo: invalid configuration; using defaults for ${result.invalid.join(", ")}`);
    }
  }
  snapshot(): ViewPreferences { return structuredClone(this.value); }
  update(patch: PreferencePatch): ViewPreferences {
    this.value = normalizeViewPreferences({ ...this.value, ...patch, editor: { ...this.value.editor, ...patch.editor, options: { ...this.value.editor.options, ...patch.editor?.options } } });
    return this.snapshot();
  }
}
