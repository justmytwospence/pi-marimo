import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, MessageRenderer, Theme, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";

const { hint } = vi.hoisted(() => ({ hint: vi.fn((_action: string, description: string) => `alt+shift+z ${description}`) }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ keyHint: hint }));
// Importing or querying either backend while displaying history is a regression.
vi.mock("../src/core/execution.js", () => { throw new Error("Renderer imported the live execution host"); });
vi.mock("../src/executions.js", () => { throw new Error("Renderer imported the live execution session"); });
import { executionToolRenderers, registerExecutionMessageRenderers } from "../src/ui/execution-render.js";

const id = "12345678-1234-1234-1234-123456789abc";
const path = "/Users/someone/Projects/hidden/coffee.py";
const label = "Chat while coffee runs — 60-second demo";
const record = (extra: Record<string, unknown> = {}) => ({
  id, label, target: { canonicalPath: path }, state: "succeeded", startedAt: 1000, endedAt: 61_000,
  errors: [], summary: "Request succeeded.", ...extra,
});
const body = `${id}: ${label} · succeeded\n${path}\nstdout:\n${Array.from({ length: 80 }, (_, i) => `output ${i}`).join("\n")}\nstderr:\nretained warning\n[4096 bytes omitted]\nA native CLI success confirms only its Python request, not every downstream notebook cell.\nDo not retry an unknown outcome automatically.`;
let palette: string;
const foreground = vi.fn((_token: string, text: string) => `\x1b[${palette}m${text}\x1b[39m`);
const theme = { fg: foreground } as unknown as Theme;
const plain = (component: Component, width = 200) => component.render(width).map(stripTerminalSequences).map(line => line.trimEnd());

function messages() {
  const registered = new Map<string, MessageRenderer>();
  const registerMessageRenderer = vi.fn((type: string, renderer: MessageRenderer) => { registered.set(type, renderer); });
  const pi = new Proxy({ registerMessageRenderer }, {
    get(target, property) {
      if (property !== "registerMessageRenderer") throw new Error(`Unexpected Pi access: ${String(property)}`);
      return target.registerMessageRenderer;
    },
  }) as unknown as Pick<ExtensionAPI, "registerMessageRenderer">;
  registerExecutionMessageRenderers(pi, "completion", "status");
  const render = (details: unknown, content: unknown = body, expanded = false, outputPad = 0, type = "completion") => {
    const component = registered.get(type)!({ role: "custom", customType: type, content, details, display: true, timestamp: 0 } as never, { expanded, outputPad }, theme);
    expect(component).toBeDefined();
    return component!;
  };
  return { registered, registerMessageRenderer, render };
}

function context(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
  const values = { args: {}, expanded: false, isError: false, ...overrides };
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) throw new Error(`Unexpected tool context access: ${String(property)}`);
      return Reflect.get(target, property);
    },
  }) as ToolRenderContext;
}

function toolResult(kind: "execute" | "watch" | "execution", options: {
  details?: unknown; content?: unknown; expanded?: boolean; partial?: boolean; error?: boolean;
  args?: Record<string, unknown>; resultError?: boolean;
} = {}) {
  const result = { content: options.content ?? [{ type: "text", text: body }], details: options.details, ...(options.resultError ? { isError: true } : {}) };
  const ctx = context({ args: options.args ?? {}, isError: options.error ?? false });
  return executionToolRenderers(kind).renderResult!(result as never, { expanded: options.expanded ?? false, isPartial: options.partial ?? false }, theme, ctx);
}

beforeEach(() => { palette = "36"; vi.clearAllMocks(); });

describe("execution custom messages", () => {
  it("registers just the requested renderers with no session/UI/host access", () => {
    const { registered, registerMessageRenderer } = messages();
    expect([...registered.keys()]).toEqual(["completion", "status"]);
    expect(registerMessageRenderer).toHaveBeenCalledTimes(2);
    expect(hint).not.toHaveBeenCalled();
  });

  it("renders new v2 success in two rows with basename, label, duration and configured native hint", () => {
    const rows = plain(messages().render({ version: 2, executions: [record()] }));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(`coffee.py · ${label} · succeeded · 1m00s`);
    expect(rows[1]).toBe("  alt+shift+z expand output and details");
    expect(hint).toHaveBeenCalledExactlyOnceWith("app.tools.expand", "expand output and details");
    expect(rows.join("\n")).not.toMatch(/ctrl\+[oe]/iu);
    for (const hidden of [id, path, "stdout", "output 79", "bytes omitted"]) expect(rows.join("\n")).not.toContain(hidden);
  });

  it("recovers the exact v1 demo body-line label without timing or headline confusion", () => {
    const legacy = { version: 1, ids: [`pi-marimo-completion:${id}`], executions: [{ id, target: { canonicalPath: path }, state: "succeeded", summary: "ran for 60 seconds", errors: [], blocked: [] }] };
    const text = `${id}: succeeded\n\nnot-${id}: false label · succeeded\n${id}: wrong suffix · failed\n${body}`;
    const rows = plain(messages().render(legacy, text));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(label);
    expect(rows[0]).not.toContain("1m00s");
    expect(rows[0]).not.toContain("false label");
    expect(rows[0]).not.toContain("wrong suffix");
  });

  it("matches labels containing separators and regex punctuation literally", () => {
    const legacy = { version: 1, executions: [{ id: "[id].*", state: "succeeded" }] };
    const rows = plain(messages().render(legacy, "other: wrong · succeeded\n[id].*: Check · punctuation [a-z] · succeeded"));
    expect(rows[0]).toContain("Check · punctuation [a-z]");
    const noMatch = plain(messages().render(legacy, "[id].*: do not recover · succeeded trailing"));
    expect(noMatch[0]).toContain("Python execution");
  });

  it("preserves all original text, IDs, full paths, retained tails and cautions when expanded", () => {
    const rows = plain(messages().render({ version: 2, executions: [record()] }, body, true));
    for (const line of body.split("\n")) expect(rows).toContain(line);
    expect(rows).toHaveLength(body.split("\n").length + 1);
    expect(hint).not.toHaveBeenCalled();
  });

  it("soft-wraps long expanded output rather than preview-truncating it", () => {
    const text = "abcdefghij".repeat(300) + " RETAINED-END";
    const component = messages().render(undefined, text, true);
    const rows = plain(component, 46);
    expect(rows.length).toBeGreaterThan(60);
    expect(rows.slice(1).join("").replace(/ /gu, "")).toBe(text.replace(/ /gu, ""));
    expect(rows.every(row => visibleWidth(row) <= 46)).toBe(true);
  });

  it.each(["failed", "interrupted", "unknown", "reconnecting", "future-state"])("bounds %s previews and uses semantic error/warning colors", state => {
    const rows = plain(messages().render({ executions: [record({ state, errors: ["ValueError: fix missing column\ntraceback", "later error"] })] }));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("ValueError: fix missing column");
    expect(rows.join("\n")).not.toContain("traceback");
    expect(rows[0]).toContain(state === "future-state" ? "unknown" : state);
    expect(foreground.mock.calls.some(([token]) => token === (state === "failed" ? "error" : "warning"))).toBe(true);
    expect(foreground.mock.calls.some(([token]) => token === "success")).toBe(false);
  });

  it("uses the first summary line, otherwise explicit unknown-outcome guidance", () => {
    const { render } = messages();
    expect(plain(render({ executions: [record({ state: "failed", summary: "Install dependency\nmore", errors: [] })] }))[1]).toContain("Install dependency");
    const rows = plain(render({ executions: [record({ state: "unknown", summary: undefined })] }));
    expect(rows[1]).toContain("Do not retry automatically");
  });

  it.each([3, 4, 20, 100])("bounds a %i-record batch to four rows, with counts and an overflow/hint row", count => {
    const records = Array.from({ length: count }, (_, i) => record({ label: `task ${i}`, state: i === 0 ? "running" : "succeeded" }));
    const { render } = messages();
    const rows = plain(render({ version: 2, executions: records }));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain(`${count} marimo executions`);
    expect(rows[0]).toContain("1 running");
    expect(rows[0]).toContain(`${count - 1} succeeded`);
    expect(rows.join("\n")).not.toContain("finished");
    expect(rows[1]).toContain("task 0");
    expect(rows[2]).toContain("task 1");
    expect(rows[3]).toContain(`${count - 2} more · alt+shift+z`);
    const expanded = plain(render({ executions: records }, body, true));
    for (const line of body.split("\n")) expect(expanded).toContain(line);
  });

  it("renders single/status records and lists, including active work and empty lists", () => {
    const { render } = messages();
    expect(plain(render(record({ state: "running", endedAt: undefined }), body, false, 0, "status"))).toHaveLength(2);
    const rows = plain(render({ records: [record(), record({ state: "starting" })] }, body, false, 0, "status"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("1 starting");
    expect(rows[3]).not.toContain("more");
    expect(plain(render({ records: [] }, "No marimo executions in this session/branch.", false, 0, "status"))[0]).toContain("No marimo executions");
  });

  it("identifies new and legacy custom-message unsubscribe replies without stopping Python", () => {
    const { render } = messages();
    const text = `Stopped watching ${id}; Python execution was not interrupted.`;
    for (const details of [
      record({ action: "unsubscribe", subscribed: false, state: "running", endedAt: undefined }),
      record({ subscribed: false, state: "running", endedAt: undefined }),
    ]) {
      const rows = plain(render(details, text, false, 0, "status"));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain("Stopped watching");
      expect(rows[0]).toContain("running");
      expect(rows[0]).not.toContain("interrupted");
      expect(plain(render(details, text, true, 0, "status")).slice(1)).toEqual([text]);
    }
    expect(plain(render(record({ action: "unsubscribe", state: "running" }), "Subscription removed", false, 0, "status"))[0]).toContain("Stopped watching");
    for (const action of ["watch", "status"]) {
      expect(plain(render(record({ action, subscribed: false }), body, false, 0, "status"))[0]).not.toContain("Stopped watching");
    }
    expect(plain(render(record({ subscribed: true }), text, false, 0, "status"))[0]).not.toContain("Stopped watching");
    expect(plain(render(record({ subscribed: false }), `output\n${text}`, false, 0, "status"))[0]).not.toContain("Stopped watching");
    expect(plain(render(record({ action: "unsubscribe", subscribed: false }), text, false, 0, "completion"))[0]).not.toContain("Stopped watching");
  });

  it.each([undefined, null, false, 12, "metadata", [], {}, { version: 999, executions: [record()] }, { executions: "bad" }, { executions: [null, {}, 1] }, { state: {} }])("uses an inert compact fallback for invalid metadata %j", details => {
    const { render } = messages();
    const rows = plain(render(details, "\n\x1b[31mfirst line\x1b[0m\n" + "huge output\n".repeat(200)));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Marimo execution · first line");
    expect(rows.join("\n")).not.toContain("huge output");
  });

  it("handles nontext, empty and malformed content without stringifying objects", () => {
    const { render, registered } = messages();
    for (const content of [undefined, null, {}, [], [{ type: "image", data: "private" }], [{ type: "text", text: 7 }]]) {
      const component = registered.get("completion")!({ content, details: undefined } as never, { expanded: false, outputPad: 0 }, theme)!;
      expect(plain(component)[0]).toContain("Marimo execution · no details available");
    }
    const content = [{ type: "image" }, { type: "text", text: "first block" }, { type: "text", text: "second block" }];
    expect(plain(render(undefined, content, true)).slice(1)).toEqual(["first block", "second block"]);
  });

  it("validates optional fields, timestamps and each list item independently", () => {
    const malformed = record({ label: {}, startedAt: "yesterday", endedAt: Infinity, target: { canonicalPath: {}, path }, summary: 12, errors: [null, false, "fix this"], subscribed: "yes" });
    const rows = plain(messages().render({ executions: [null, malformed, {}] }, "not a matching legacy body"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("coffee.py · Python execution · succeeded");
    expect(rows[0]).not.toContain("NaN");
    for (const times of [{ startedAt: -1 }, { endedAt: 0 }, { startedAt: NaN }]) {
      expect(plain(messages().render({ executions: [record(times)] }))[0]).not.toMatch(/\d+[smh]/u);
    }
  });
});

describe("native execution tool rendering", () => {
  it.each(["execute", "watch", "execution"] as const)("renders %s results from retained single/details.records metadata", kind => {
    expect(plain(toolResult(kind, { details: record() }))).toHaveLength(2);
    expect(plain(toolResult(kind, { details: { records: [record(), record()] } }))).toHaveLength(4);
    const expanded = plain(toolResult(kind, { details: record(), expanded: true }));
    for (const line of body.split("\n")) expect(expanded).toContain(line);
  });

  it("hides Python and JSON in compact execute calls, revealing the entire inert source only on expansion", () => {
    const renderers = executionToolRenderers("execute");
    const code = `# not a command\nimport os\nprint('hello')\n${"x = 1\n".repeat(40)}raise ValueError('END')`;
    const args = Object.freeze({ code, notebook: path, label: "Check source", url: "http://localhost:2718", yield_ms: 1000 });
    const compact = plain(renderers.renderCall!(args, theme, context()));
    expect(compact).toEqual(["Execute Python · Check source · coffee.py"]);
    expect(compact.join("\n")).not.toContain("import os");
    expect(compact.join("\n")).not.toContain(path);
    const expanded = plain(renderers.renderCall!(args, theme, context({ expanded: true })));
    expect(expanded.slice(1)).toEqual(code.split("\n"));
    expect(executionToolRenderers("execute")).not.toHaveProperty("execute");
    expect(executionToolRenderers("execute")).not.toHaveProperty("renderShell");
  });

  it("uses meaningful watch/status/unsubscribe call titles with short IDs and no raw arguments", () => {
    expect(plain(executionToolRenderers("watch").renderCall!({ notebook: path }, theme, context()))).toEqual(["Watch execution · coffee.py"]);
    expect(plain(executionToolRenderers("execution").renderCall!({ id }, theme, context()))).toEqual(["Execution status · 12345678"]);
    expect(plain(executionToolRenderers("execution").renderCall!({ id, action: "unsubscribe" }, theme, context()))).toEqual(["Stop watching execution · 12345678"]);
    for (const input of [undefined, null, 12, [], { label: {}, notebook: 7 }]) {
      expect(plain(executionToolRenderers("execute").renderCall!(input, theme, context()))).toEqual(["Execute Python · Python execution · selected notebook"]);
      expect(plain(executionToolRenderers("watch").renderCall!(input, theme, context()))).toEqual(["Watch execution · selected notebook"]);
    }
  });

  it("stops watching without claiming Python was stopped or interrupted", () => {
    const details = record({ state: "running", endedAt: undefined, subscribed: false });
    const text = `Stopped watching ${id}; Python execution was not interrupted.`;
    const rows = plain(toolResult("execution", { details, args: { action: "unsubscribe", id }, content: [{ type: "text", text }] }));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Stopped watching");
    expect(rows[0]).toContain("running");
    expect(rows[0]).not.toContain("interrupted");
    expect(rows[0]).not.toContain("stopped Python");
    expect(plain(toolResult("execution", { details, args: { action: "status" } }))[0]).not.toContain("Stopped watching");
    expect(plain(toolResult("execution", { args: { action: "unsubscribe" }, content: [] }))[0]).toContain("Stopped watching");
  });

  it.each(["execute", "watch", "execution"] as const)("shows compact %s in-progress replies without complete metadata", kind => {
    const component = toolResult(kind, { partial: true, content: [] });
    expect(plain(component)).toHaveLength(2);
    expect(plain(component)[0]).toContain("in progress");
  });

  it.each(["execute", "watch", "execution"] as const)("preserves %s tool-error semantics and full error text", kind => {
    const text = "Permission denied: select a connected notebook\ntraceback detail\nretained error end";
    for (const flags of [{ error: true }, { resultError: true }]) {
      const rows = plain(toolResult(kind, { ...flags, content: [{ type: "text", text }] }));
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain("failed");
      expect(rows[1]).toContain("Permission denied");
      expect(rows.join("\n")).not.toContain("traceback detail");
      expect(plain(toolResult(kind, { ...flags, expanded: true, content: [{ type: "text", text }] })).slice(1)).toEqual(text.split("\n"));
    }
    const rows = plain(toolResult(kind, { error: true, details: record() }));
    expect(rows[0]).toContain("failed");
    expect(rows[0]).not.toContain("succeeded");
  });
});

describe("inert safe terminal components", () => {
  const hostile = "\x1b[31m界é\x1b[0m\x1b]52;c;clipboard\x07\x1bPsecret\x1b\\\x00\x08\r\nnext\tline";

  it.each([false, true])("fits all widths and clamps output padding (expanded=%s)", expanded => {
    const { render } = messages();
    for (const width of [-1, 0, 1, 2, 3, 7, 20, 46, 100, 240]) {
      for (const pad of [-10, 0, 3, 1000, NaN]) {
        const component = render({ executions: [record({ label: hostile, target: { canonicalPath: `/tmp/${hostile}.py` } })] }, hostile, expanded, pad);
        const rows = component.render(width);
        if (width <= 0) expect(rows).toEqual([]);
        else expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
        expect(stripTerminalSequences(rows.join("\n"))).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/u);
        expect(rows.join("\n")).not.toContain("clipboard");
        expect(rows.join("\n")).not.toContain("secret");
      }
    }
  });

  it("applies message outputPad but leaves outer tool-shell padding to Pi", () => {
    const rows = plain(messages().render({ executions: [record()] }, body, false, 3), 100);
    expect(rows.every(row => row.startsWith("   "))).toBe(true);
    const result = executionToolRenderers("execute").renderResult!({ details: record(), content: [] }, { expanded: false, isPartial: false }, theme, context({ outputPad: 20 }));
    expect(plain(result)[0]).toMatch(/^▸/u);
  });

  it.each(["execute", "watch", "execution"] as const)("sanitizes %s calls/results, including source, at narrow widths", kind => {
    const call = executionToolRenderers(kind).renderCall!({ label: hostile, notebook: hostile, id: hostile, code: hostile }, theme, context({ expanded: true }));
    const result = toolResult(kind, { details: record({ label: hostile, errors: [hostile], state: "failed" }), content: [{ type: "text", text: hostile }], expanded: true });
    for (const component of [call, result]) for (const width of [0, 1, 2, 3, 10, 46, 100]) {
      const rows = component.render(width);
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
      expect(stripTerminalSequences(rows.join("\n"))).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/u);
      expect(rows.join("\n")).not.toMatch(/clipboard|secret/u);
    }
  });

  it("recomputes semantic styling and the native hint on invalidation/theme changes", () => {
    const { render } = messages();
    const components = [render({ executions: [record()] }), toolResult("execute", { details: record() }), executionToolRenderers("execute").renderCall!({ label: "Check source" }, theme, context())];
    for (const component of components) {
      palette = "36";
      expect(component.render(100).join("\n")).toContain("\x1b[36m");
      palette = "35";
      component.invalidate();
      const changed = component.render(100).join("\n");
      expect(changed).toContain("\x1b[35m");
      expect(changed).not.toContain("\x1b[36m");
    }
    expect(hint).toHaveBeenCalledTimes(4);
    expect(foreground.mock.calls.every(([token]) => ["accent", "success", "error", "warning", "dim"].includes(token))).toBe(true);
  });

  it("does not mutate evidence, capture input, retain resources or inspect live context", () => {
    const details = Object.freeze(record());
    const snapshot = JSON.stringify(details);
    const components = [messages().render(details), toolResult("watch", { details }), executionToolRenderers("execute").renderCall!({ code: "print('inert')" }, theme, context({ expanded: true }))];
    for (const component of components) {
      expect(Object.keys(component).sort()).toEqual(["invalidate", "render"]);
      component.render(80);
      component.invalidate();
      component.render(46);
    }
    expect(JSON.stringify(details)).toBe(snapshot);
  });
});
