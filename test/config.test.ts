import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/index.js";
import { normalizeViewPreferences } from "../src/ui/settings.js";

const saved = { agent: process.env.PI_CODING_AGENT_DIR, xdg: process.env.XDG_CONFIG_HOME };
let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-marimo-config-"));
  project = mkdtempSync(join(tmpdir(), "pi-marimo-project-"));
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  process.env.XDG_CONFIG_HOME = join(home, "xdg");
});
afterEach(() => {
  if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved.agent;
  if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.xdg;
});

test("marimo.json: defaults without files, the project's file on top, wrong types ignored", () => {
  expect(loadConfig("marimo", DEFAULT_CONFIG, project)).toEqual(DEFAULT_CONFIG);
  mkdirSync(join(home, "agent"), { recursive: true });
  writeFileSync(join(home, "agent", "marimo.json"), JSON.stringify({ maxNotebooks: 5, liveCharts: false }));
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi", "marimo.json"), JSON.stringify({ maxNotebooks: 3, context: "no", view: { outputs: true } }));
  const config = loadConfig("marimo", DEFAULT_CONFIG, project);
  expect(config.maxNotebooks).toBe(3);
  expect(config.liveCharts).toBe(false);
  expect(config.context).toBe(true);
  expect(config.view.outputs).toBe(true);
  expect(config.server.command).toEqual([]);
});

test("view settings retain loader precedence and wrong-type fallback before semantic normalization", () => {
  mkdirSync(join(home, "agent"), { recursive: true });
  writeFileSync(join(home, "agent", "marimo.json"), JSON.stringify({ view: { lineNumbers: true, showOutput: false, editor: { options: { tabstop: 8 } } } }));
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi", "marimo.json"), JSON.stringify({ view: { lineNumbers: "no", outputs: true, diagnostics: "invalid", editor: { options: { tabstop: 50 } } } }));
  const merged = loadConfig("marimo", DEFAULT_CONFIG, project);
  expect(merged.view.lineNumbers).toBe(true);
  expect(merged.view.outputs).toBe(true);
  expect(merged.view.diagnostics).toBe("invalid");
  const preferences = normalizeViewPreferences(merged.view);
  expect(preferences.diagnostics).toBe("all");
  expect(preferences.editor.options.tabstop).toBe(4);
  expect(preferences.showOutput).toBe(false);
});
