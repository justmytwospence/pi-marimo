import { expect, test, vi } from "vitest";
import { DEFAULT_VIEW_PREFERENCES, SessionPreferences, normalizeViewPreferences } from "../src/ui/settings.js";

test("preferences defensively normalize malformed fields and drop executable code options", () => {
  expect(normalizeViewPreferences(null)).toEqual(DEFAULT_VIEW_PREFERENCES);
  expect(normalizeViewPreferences({ lineNumbers: "true", diagnostics: "bad", showOutput: 0, editor: { command: " ", options: { tabstop: 0, shiftwidth: 17, scrolloff: 21, expandtab: "yes", init: "evil.lua", shell: "sh" } } })).toEqual(DEFAULT_VIEW_PREFERENCES);
  const value = normalizeViewPreferences({ lineNumbers: true, diagnostics: "warnings", showOutput: false, editor: { command: "/path with spaces/nvim", options: { tabstop: 16, shiftwidth: 1, scrolloff: 0, ignorecase: false } } });
  expect(value.lineNumbers).toBe(true); expect(value.diagnostics).toBe("warnings"); expect(value.showOutput).toBe(false);
  expect(value.editor.command).toBe("/path with spaces/nvim"); expect(value.editor.options.tabstop).toBe(16);
  expect(value.editor.options.ignorecase).toBe(false);
});
test("session snapshots are isolated, updates preserve options, warnings aggregate once without values", () => {
  const warn = vi.fn(); const prefs = new SessionPreferences({ diagnostics: "secret-invalid-value", editor: { options: { tabstop: 99 } } }, warn);
  expect(warn).toHaveBeenCalledOnce(); expect(warn.mock.calls[0]![0]).toContain("view.diagnostics, view.editor.options.tabstop");
  expect(warn.mock.calls[0]![0]).not.toContain("secret-invalid-value");
  prefs.configure({ diagnostics: "invalid" }, warn); expect(warn).toHaveBeenCalledOnce();
  const snapshot = prefs.update({ lineNumbers: true, editor: { options: { tabstop: 8 } } });
  snapshot.editor.options.tabstop = 1;
  expect(prefs.snapshot().editor.options.tabstop).toBe(8); expect(prefs.snapshot().editor.options.shiftwidth).toBe(4);
  expect(prefs.snapshot().lineNumbers).toBe(true);
});
