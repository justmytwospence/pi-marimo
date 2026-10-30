import { describe, expect, test, vi } from "vitest";
import * as outputHtml from "../src/core/html.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { tableGrid } from "../src/ui/table.js";
import { codeRows } from "../src/ui/code.js";
import { markdownRows } from "../src/ui/markdown.js";
import { NotebookState } from "../src/core/notebook.js";
import { CellConsole } from "../src/core/console.js";
import { htmlToText, summarizeOutput } from "../src/core/output.js";
import { snapshot } from "../src/core/render.js";
import { runCells } from "../src/ui/interrupt.js";
import { mermaidRows, outputRows } from "../src/ui/outputs.js";
import { detailRows } from "../src/ui/detail.js";

describe("cell output for the notebook view", () => {
  test("parses mixed progress once, consuming every PyMC row without duplicating nested controls or siblings", () => {
    const source = "source<&>\n".repeat(1_000);
    const html = `<p>before</p><table class='pymc-progress-table'><tr><th>Chain</th><th>Draw</th><th>Stat</th><th>Stat</th></tr><tr><td>0</td><td>2/4</td><td><progress value='1'></progress>first</td><td>second</td></tr><tr><td>1</td><td>4/4</td><td>third</td><td>fourth</td></tr></table><p>between</p><marimo-progress data-title='&quot;native&quot;' data-progress='true' data-total='10' data-subtitle='&quot;waiting&quot;'></marimo-progress><progress value='1' aria-label='HTML'>fallback</progress><pre><code>${source.replace(/&/gu, "&amp;").replace(/</gu, "&lt;")}</code></pre><p>after</p>`;
    const parse = vi.spyOn(outputHtml, "parseOutputFragment");
    try {
      const out = summarizeOutput({ mimetype: "text/html", data: html })!;
      expect(parse).toHaveBeenCalledTimes(1);
      expect(out.progress).toHaveLength(4);
      expect(new Set(out.progress?.map(task => task.id)).size).toBe(4);
      expect(out.progress?.[0]).toMatchObject({ label: "Chain 0", completed: 2, total: 4, stats: { Stat: "first", "Stat (2)": "second" } });
      expect(out.progress?.[1]).toMatchObject({ label: "Chain 1", completed: 4, total: 4, state: "complete", stats: { Stat: "third", "Stat (2)": "fourth" } });
      expect(out.progress?.[2]).toMatchObject({ label: "native", stats: { subtitle: "waiting" } });
      expect(out.progress?.[2]?.completed).toBeUndefined();
      expect(out.progress?.[2]?.total).toBeUndefined();
      expect(out.progress?.[3]).toMatchObject({ label: "HTML", completed: 1, total: 1, state: "complete" });
      expect(out.blocks?.map(block => block.output.progress ? "progress" : block.output.codeBlocks ? "code" : block.output.text)).toEqual(["before", "progress", "between", "progress", "progress", "code", "after"]);
      expect(out.codeBlocks).toEqual([{ source }]);
    } finally {
      parse.mockRestore();
    }
  });

  test("html becomes text; tables, images and charts are named, not dumped", () => {
    expect(htmlToText("<div><b>a</b> &amp; b</div><p>second</p><script>x()</script>")).toBe("a & b\nsecond");
    expect(summarizeOutput({ channel: "output", mimetype: "text/plain", data: "42" })).toEqual({ kind: "text", text: "42" });
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: '<marimo-table data-total-rows="12" data-data="[]"></marimo-table>' })).toMatchObject({ kind: "table", text: "[table, 12 rows]", blocks: [{ output: { kind: "table", text: "[table, 12 rows]" } }] });
    expect(summarizeOutput({ channel: "output", mimetype: "image/png", data: "iVBOR" })).toMatchObject({ kind: "image", text: "[image png]" });
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v5+json", data: "{}" })?.kind).toBe("chart");
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: "<marimo-plotly data-figure='x'></marimo-plotly>" })?.kind).toBe("chart");
    expect(summarizeOutput({ channel: "output", mimetype: "text/plain", data: "" })).toBeUndefined();
    expect(summarizeOutput({ channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [] })).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "text/plain", data: "x".repeat(20_000) })!.text.length).toBeLessThanOrEqual(8_000);
  });

  test("mo.md output (text/markdown carrying HTML) becomes text, not raw HTML", () => {
    const data = '<span class="markdown prose dark:prose-invert contents"><h2 id="a">Slow fit</h2><span class="paragraph">Some text.</span></span>';
    const out = summarizeOutput({ channel: "output", mimetype: "text/markdown", data });
    expect(out?.kind).toBe("text");
    expect(out?.text).toContain("Slow fit");
    expect(out?.text).not.toContain("<span");
  });

  test("console lines use asynchronous terminal snapshots and explicit clear", async () => {
    const console = new CellConsole();
    await console.append([{ channel: "stdout", data: "one\ntwo\n" }]);
    await console.append({ channel: "stderr", data: "warn\n" });
    expect(console.snapshot().map(l => `${l.stream}:${l.text}`)).toEqual(["stdout:one", "stdout:two", "stderr:warn"]);
    await console.append([]);
    expect(console.snapshot()).toEqual([]);
    console.dispose();
  });

  test("a cell keeps its output and console, a rerun clears the console, and none of it reaches the agent's snapshot or marks a change", async () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["print('secret-token'); 1"], names: ["_"] });
    expect(nb.apply("cell-op", { cell_id: "a", console: [{ channel: "stdout", data: "secret-console\n" }], output: { channel: "output", mimetype: "text/plain", data: "secret-output" } })).toBe(false);
    await nb.settled();
    const cell = nb.cells.get("a")!;
    expect(cell.output?.text).toBe("secret-output");
    expect(cell.console?.[0]?.text).toBe("secret-console");
    const text = snapshot([{ notebook: nb, attachment: { path: "/w/nb.py", url: "http://x", sessionId: "s" } }]);
    expect(text).not.toContain("secret-output");
    expect(text).not.toContain("secret-console");
    nb.apply("cell-op", { cell_id: "a", status: "queued" });
    expect(cell.console).toBeUndefined();
    expect(cell.output?.text).toBe("secret-output");
  });
});

describe("output prefixes", () => {
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  const limits = { textLines: 1, tableRows: 1 };
  const cell = () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["pass"], names: ["_"] });
    return nb.cells.get("a")!;
  };
  test.each([46, 80, 120, 180])("empty bars leave all %i columns for text, code, prose and tables", width => {
    const c = cell();
    const text = "x".repeat(width);
    c.output = { kind: "text", text: `${text}\nmore` };
    const opts = { width, pad: "", bar: "" };
    expect(outputRows(c, theme, opts, limits).map(row => row.text)).toEqual([text, "… 1 more lines"]);
    expect(visibleWidth(outputRows(c, theme, opts, limits)[0]!.text)).toBe(width);
    expect(codeRows(text, opts).find(row => row.sourceLine !== undefined)?.text).toBe(text);
    expect(markdownRows(text, opts).some(row => row.text === text)).toBe(true);
    const table = { columns: ["first", "second", "third"], numeric: [false, false, false], rows: [["a".repeat(25), "b".repeat(25), "c".repeat(25)]], totalRows: 1, totalColumns: 3 };
    c.output = { kind: "table", text: "table", table };
    expect(outputRows(c, theme, opts, limits).map(row => row.text)).toEqual(tableGrid(table, width, theme, 1).lines);
    expect(outputRows(c, theme, opts, limits).some(row => row.tableRow === 0)).toBe(true);
  });
  test("default padding and bars stay intact; custom prefixes use visible columns", () => {
    const c = cell(); c.output = { kind: "text", text: "value" };
    expect(outputRows(c, theme, {}, limits)[0]!.text).toBe("      ▍ value");
    expect(outputRows(c, theme, { bar: "" }, limits)[0]!.text).toBe("      value");
    const table = { columns: ["first", "second"], numeric: [false, false], rows: [["a".repeat(25), "b".repeat(25)]], totalRows: 1, totalColumns: 2 };
    c.output = { kind: "table", text: "table", table };
    const prefix = "\x1b[31m界\x1b[0m";
    const rows = outputRows(c, theme, { width: 46, pad: prefix, bar: prefix }, limits);
    expect(rows.map(row => row.text)).toEqual(tableGrid(table, 41, theme, 1).lines.map(line => `${prefix}${prefix} ${line}`));
    c.output.table = { ...table, rows: [], lazy: true };
    expect(outputRows(c, theme, { pad: "", bar: "" }, limits)[0]!.text).toBe("loading table…");
  });
});

describe("structured source output", () => {
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  const html = (data: string) => summarizeOutput({ mimetype: "text/html", data });
  const attr = (value: string) => JSON.stringify(value).replace(/&/gu, "&amp;").replace(/'/gu, "&#39;");
  test("Mermaid props take precedence over generic HTML, including multiple independent diagrams", () => {
    const sources = ['flowchart TD; A["quoted & <tag>"]-->B', "sequenceDiagram\n A->>B: hello"];
    const output = html(sources.map(source => `<marimo-mermaid data-diagram='${attr(source)}'></marimo-mermaid>`).join(""));
    expect(output?.mermaid).toEqual(sources);
    const nb = new NotebookState(); nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["pass"], names: ["_"] });
    const cell = nb.cells.get("a")!; cell.output = output;
    const rows = outputRows(cell, theme, { width: 100, imageRows: 0, pad: "" }, { textLines: 1, tableRows: 1 });
    const ids = output!.blocks!.map(block => `a:${block.id}:mermaid:0`);
    expect(new Set(ids).size).toBe(2);
    expect(new Set(rows.map(row => row.blockId))).toEqual(new Set(ids));
    expect(html(sources.map(source => `<marimo-mermaid data-diagram='${attr(source)}'></marimo-mermaid>`).join(""))?.blocks?.map(block => block.id)).toEqual(output!.blocks!.map(block => block.id));
    expect(rows.map(row => row.text).join("\n")).toContain("A->>B: hello");
  });
  test("pre/code source preserves all tabs, blank lines, entities and the tail before MAX_TEXT", () => {
    const source = `\t<head>\n\n${"line\n".repeat(10_001)}tail\n`;
    const output = html(`<pre><code class='language-python'>${source.replace(/</gu, "&lt;").replace(/>/gu, "&gt;")}</code></pre>`);
    expect(output?.codeBlocks).toEqual([{ source, language: "python" }]);
    expect(output!.text.length).toBeLessThanOrEqual(8_000);
    const nb = new NotebookState(); nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["pass"], names: ["_"] });
    const cell = nb.cells.get("a")!; cell.output = output;
    const rows = outputRows(cell, theme, { width: 100, pad: "" }, { textLines: 1, tableRows: 1 });
    expect(rows.filter(row => row.sourceLine !== undefined)).toHaveLength(source.split("\n").length);
    expect(rows.map(row => row.text)).toContain("tail");
  });
  test("mixed HTML renders authoritative leaves in order exactly once, with table and chart ownership", () => {
    const table = (id: string, value: string) => `<marimo-ui-element object-id='${id}'><marimo-table data-data='[{&quot;value&quot;:&quot;${value}&quot;}]' data-total-rows='1'></marimo-table></marimo-ui-element>`;
    const widget = `<marimo-ui-element object-id='control'><marimo-text data-label='&quot;CONTROL_LABEL&quot;' data-initial-value='&quot;CONTROL_VALUE&quot;'></marimo-text></marimo-ui-element>`;
    const data = `<p>PROSE_START</p><pre><code>CODE_BODY</code></pre><marimo-mermaid data-diagram='${attr("flowchart TD; DIAGRAM_A-->DIAGRAM_B")}'></marimo-mermaid>${table("table-one", "TABLE_ONE")}${widget}<p>PROSE_END</p>${table("table-two", "TABLE_TWO")}<marimo-vega data-spec='{&quot;mark&quot;:&quot;bar&quot;}'></marimo-vega>`;
    const output = html(data)!;
    expect(output.blocks?.map(block => block.output.kind)).toEqual(["text", "text", "chart", "table", "widgets", "text", "table", "chart"]);
    expect(output.table).toBe(output.blocks![3]!.output.table);
    expect(output.vega).toBe(output.blocks![7]!.output.vega);
    expect(output.widgets).toEqual(output.blocks![4]!.output.widgets);
    expect(output.codeBlocks).toEqual(output.blocks![1]!.output.codeBlocks);
    expect(output.mermaid).toEqual(output.blocks![2]!.output.mermaid);
    const nb = new NotebookState(); nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["pass"] });
    const cell = nb.cells.get("a")!; cell.output = output;
    const result = detailRows(nb, theme, 0, { cell, width: 120, codeOpen: false, diff: false, section: false, imageRows: 0 });
    const text = result.rows.map(row => stripTerminalSequences(row.text)).join("\n");
    let previous = -1;
    for (const token of ["PROSE_START", "CODE_BODY", "DIAGRAM_A", "TABLE_ONE", "CONTROL_LABEL", "PROSE_END", "TABLE_TWO", "[chart vega-lite]"]) {
      const position = text.indexOf(token);
      expect(position, token).toBeGreaterThan(previous);
      expect(text.split(token), `${token} must not render twice`).toHaveLength(2);
      previous = position;
    }
    expect(result.rows.filter(row => row.widget).map(row => row.widget)).toEqual([{ cell: "a", index: 0 }]);
    expect(result.widgetRows.size).toBe(1);
    for (const [index, id] of [[3, "table-one"], [6, "table-two"]] as const) {
      const leaf = output.blocks![index]!.output;
      const rows = result.rows.filter(row => row.output === leaf);
      expect(rows.some(row => row.tableRow === 0)).toBe(true);
      expect(rows.every(row => row.tableObjectId === id)).toBe(true);
      expect(result.parts.some(part => part.kind === "table" && part.tableObjectId === id && part.output === leaf)).toBe(true);
    }
    const chart = output.blocks![7]!.output;
    expect(result.rows.some(row => row.output === chart)).toBe(true);
    expect(result.parts.some(part => part.kind === "chart" && part.output === chart)).toBe(true);
    nb.dispose();
  });
  test.each([false, true])("dynamic Markdown retains long pre/code tails in detail rows (section=%s)", section => {
    const source = `${"long source line\n".repeat(700)}DYNAMIC_LONGTAIL`;
    const nb = new NotebookState(); nb.apply("kernel-ready", { cell_ids: ["a"], codes: ['mo.md(f"{dynamic_text}")'] });
    nb.apply("cell-op", { cell_id: "a", output: { mimetype: "text/markdown", data: `<p>DYNAMIC_PROSE</p><pre><code>${source}</code></pre>` } });
    const cell = nb.cells.get("a")!;
    expect(source.length).toBeGreaterThan(8_000);
    expect(nb.isMarkdown(cell)).toBe(true);
    const result = detailRows(nb, theme, 0, { cell, width: 100, codeOpen: false, diff: false, section });
    const sourceRows = result.rows.filter(row => row.output?.codeBlocks && row.sourceLine !== undefined);
    expect(sourceRows).toHaveLength(source.split("\n").length);
    expect(sourceRows.at(-1)?.text).toBe("DYNAMIC_LONGTAIL");
    expect(result.rows.filter(row => row.text.includes("DYNAMIC_PROSE"))).toHaveLength(1);
    nb.dispose();
  });
  test("oversized diagram remains fully readable without an image, regardless of summary limits", () => {
    const source = `flowchart TD\n${"A-->B\n".repeat(45_000)}LAST`;
    const output = html(`<marimo-mermaid data-diagram='${attr(source)}'></marimo-mermaid>`);
    expect(output?.mermaid?.[0]).toBe(source);
    const rows = mermaidRows(source, theme, { blockId: "diagram", imageRows: 0, width: 80 });
    expect(rows[0]!.text).toContain("Mermaid:");
    expect(rows.at(-1)!.text).toBe("LAST");
    expect(rows.filter(row => row.sourceLine !== undefined)).toHaveLength(45_002);
  });
  test("malformed props and active content never become diagram sources", () => {
    expect(html('<script><marimo-mermaid data-diagram=\'"bad"\'></marimo-mermaid></script>')?.mermaid).toBeUndefined();
    expect(html('<marimo-mermaid data-diagram="not-json"></marimo-mermaid>')?.mermaid).toBeUndefined();
  });
});

describe("core progress and timing state", () => {
  const notebook = (onOutputChange?: () => void) => {
    const nb = new NotebookState(onOutputChange);
    nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["pass"] });
    return nb;
  };
  const status = (nb: NotebookState, status: string, timestamp?: number) => nb.apply("cell-op", { cell_id: "a", status, ...(timestamp !== undefined ? { timestamp } : {}) });
  test("server replay timestamps supply start/end and milliseconds; cancellation preserves completed run", () => {
    const nb = notebook(); const cell = nb.cells.get("a")!;
    status(nb, "running", 100); status(nb, "idle", 102.5);
    expect(cell).toMatchObject({ lastRunStartedAt: 100_000, lastRunEndedAt: 102_500, lastRunMs: 2500 });
    status(nb, "queued", 103); status(nb, "idle", 104);
    expect(cell).toMatchObject({ lastRunStartedAt: 100_000, lastRunEndedAt: 102_500, lastRunMs: 2500 });
    status(nb, "running", 110); status(nb, "idle", 109);
    expect(cell.lastRunMs).toBe(0);
    nb.dispose();
  });
  test("missing start/end and idle snapshots never fabricate durations", () => {
    const nb = notebook(); const cell = nb.cells.get("a")!;
    status(nb, "idle", 100); expect(cell.lastRunMs).toBeUndefined();
    status(nb, "running"); status(nb, "idle", 101);
    expect(cell.lastRunMs).toBeUndefined();
    expect(cell.lastRunStartedAt).toBeUndefined();
    status(nb, "running", 102); status(nb, "idle");
    expect(cell.lastRunMs).toBeUndefined();
    expect(cell.lastRunEndedAt).toBeUndefined();
    nb.dispose();
  });
  test("HTML progress takes precedence over tables and snapshots replace/reset", async () => {
    let redraws = 0;
    const nb = notebook(() => redraws++); const cell = nb.cells.get("a")!;
    const output = (data: string) => nb.apply("cell-op", { cell_id: "a", output: { mimetype: "text/html", data } });
    expect(output('<marimo-progress data-title="&quot;first&quot;" data-progress="1" data-total="4"></marimo-progress>')).toBe(false);
    expect(cell.progress).toHaveLength(1);
    expect(cell.progress?.[0]?.label).toBe("first");
    output('<progress value="2" max="10"></progress><progress value="3" max="10"></progress>');
    expect(cell.progress).toHaveLength(2);
    output("<p>ordinary</p>"); expect(cell.progress).toEqual([]);
    output('<progress value="1" max="10"></progress>');
    status(nb, "running", 1); expect(cell.progress).toEqual([]);
    expect(nb.apply("cell-op", { cell_id: "a", console: { channel: "stderr", data: "fit: 50%|#####| 5/10 [00:01<00:01, 5.00it/s]" } })).toBe(false);
    await nb.settled();
    expect(cell.progress).toHaveLength(1);
    expect(cell.console?.[0]?.severity).toBe("progress");
    nb.apply("cell-op", { cell_id: "a", console: [] });
    expect(cell.console).toBeUndefined(); expect(cell.progress).toEqual([]);
    expect(redraws).toBeGreaterThan(0);
    expect(nb.agentChanges.size).toBe(0);
    nb.dispose();
  });
  test("delete, replacement and reset invalidate in-flight console callbacks", async () => {
    const nb = notebook();
    nb.apply("cell-op", { cell_id: "a", console: { data: "old".repeat(10000) } });
    nb.apply("notebook-document-transaction", { transaction: { changes: [{ type: "delete-cell", cellId: "a" }] } });
    await nb.settled(); expect(nb.cells.has("a")).toBe(false);
    nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["new"] });
    expect(nb.cells.get("a")?.console).toBeUndefined();
    nb.apply("cell-op", { cell_id: "a", console: { data: "secret" } });
    nb.reset(); await nb.settled(); expect(nb.cells.size).toBe(0);
  });
  test("tracebacks and explicit error records differ from ordinary stderr and warnings", async () => {
    const console = new CellConsole();
    await console.append({ channel: "stderr", data: "notice" });
    expect(console.snapshot()[0]?.severity).toBe("stderr");
    console.clear(); await console.append({ channel: "stderr", data: "UserWarning: caution" });
    expect(console.snapshot()[0]?.severity).toBe("warning");
    console.clear(); await console.append({ channel: "stdout", level: "error", data: "bad" });
    expect(console.snapshot()[0]?.severity).toBe("error");
    expect(summarizeOutput({ mimetype: "application/vnd.marimo+traceback", data: "<pre>failure</pre>" })).toMatchObject({ severity: "error", text: "failure" });
    console.dispose();
  });
});

describe("running cells", () => {
  test("POSTs cellIds and codes with the session and server token headers", async () => {
    const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
    let token = "old";
    const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (init?.method !== "POST") return { ok: true, status: 200, text: async () => `<html data-token="${token}">` };
      return init.headers?.["Marimo-Server-Token"] === "new" ? { ok: true, status: 200, text: async () => "" } : { ok: false, status: 401, text: async () => "" };
    };
    // The page is fetched once, with the stale token; after a 401 it is fetched again.
    const pending = runCells({ url: "http://h:1", sessionId: "sess" }, [{ id: "a", code: "x = 1" }, { id: "b", code: "y = x" }], undefined, fetchImpl as never);
    token = "new";
    await pending.catch(() => undefined);
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts[0]!.url).toBe("http://h:1/api/kernel/run");
    expect(JSON.parse(posts[0]!.init!.body!)).toEqual({ cellIds: ["a", "b"], codes: ["x = 1", "y = x"] });
    expect(posts[0]!.init!.headers).toMatchObject({ "Marimo-Session-Id": "sess", "Content-Type": "application/json" });
  });

  test("a rejected run throws with marimo's status", async () => {
    const fetchImpl = async (_url: string, init?: { method?: string }) => init?.method === "POST" ? { ok: false, status: 500, text: async () => "" } : { ok: true, status: 200, text: async () => '<html data-token="t5">' };
    await expect(runCells({ url: "http://h:2", sessionId: "s" }, [{ id: "a", code: "" }], undefined, fetchImpl as never)).rejects.toThrow("marimo answered 500");
  });
});

describe("inline images", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  test("a png output, bare or as a data URL in an <img>, keeps its bytes; other images and huge ones do not", () => {
    expect(summarizeOutput({ channel: "output", mimetype: "image/png", data: png })?.image).toEqual({ mime: "image/png", data: png });
    expect(summarizeOutput({ channel: "output", mimetype: "image/png", data: `data:image/png;base64,${png}` })?.image?.data).toBe(png);
    const html = summarizeOutput({ channel: "output", mimetype: "text/html", data: `<img src='data:image/png;base64,${png}'/>` });
    expect(html).toMatchObject({ kind: "image", image: { data: png } });
    expect(summarizeOutput({ channel: "output", mimetype: "image/jpeg", data: png })?.image).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "image/png", data: "A".repeat(2_000_001) })?.image).toBeUndefined();
  });
});

describe("chart specs", () => {
  const spec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", mark: "bar", data: { values: [{ a: 1 }] } };
  test("a Vega-Lite mimetype and mo.ui.altair_chart's data-spec both keep the spec", () => {
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v6+json", data: JSON.stringify(spec) })).toMatchObject({ kind: "chart", vega: JSON.stringify(spec) });
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v5+json", data: spec })?.vega).toBe(JSON.stringify(spec));
    const attr = JSON.stringify(spec).replace(/"/gu, "&quot;");
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: `<marimo-ui-element><marimo-vega data-initial-value='{}' data-spec='${attr}'></marimo-vega></marimo-ui-element>` })?.vega).toBe(JSON.stringify(spec));
  });
  test("plotly and oversized or malformed specs keep only their label", () => {
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: "<marimo-plotly data-figure='x'></marimo-plotly>" })?.vega).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v6+json", data: "x".repeat(10) })?.vega).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v6+json", data: `{"d":"${"x".repeat(1_600_000)}"}` })?.vega).toBeUndefined();
  });
});

describe("tables, widgets and tracebacks", () => {
  // As marimo 0.25 writes mo.ui.table([{a: 1, b: "x"}, {a: 2, b: "y"}]): single quotes, the rows a JSON string of JSON.
  const table = `<marimo-ui-element object-id='Hbol-0' random-id='r'><marimo-table data-initial-value='[]' data-label='null' data-data='&quot;[{&#92;&quot;a&#92;&quot;:1,&#92;&quot;b&#92;&quot;:&#92;&quot;x&#92;&quot;},{&#92;&quot;a&#92;&quot;:2,&#92;&quot;b&#92;&quot;:&#92;&quot;y&#92;&quot;}]&quot;' data-total-rows='2' data-total-columns='2' data-field-types='[[&quot;a&quot;,[&quot;integer&quot;,&quot;int64&quot;]],[&quot;b&quot;,[&quot;string&quot;,&quot;object&quot;]]]'></marimo-table></marimo-ui-element>`;

  test("a marimo table keeps its first page, its row count and which columns are numbers; it is no widget", () => {
    const out = summarizeOutput({ channel: "output", mimetype: "text/html", data: table })!;
    expect(out).toMatchObject({ kind: "table", text: "[table, 2 rows]" });
    expect(out.table).toMatchObject({ columns: ["a", "b"], numeric: [true, false], rows: [["1", "x"], ["2", "y"]], totalRows: 2, totalColumns: 2 });
    expect(out.widgets).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: "<marimo-table data-total-rows='&quot;too_many&quot;' data-data='[]'></marimo-table>" })?.text).toBe("[table, many rows]");
  });

  test("HTML tables remain ordered blocks inside prose with a scalar table projection", () => {
    const html = "<table><thead><tr><th>name</th><th>n</th></tr></thead><tbody><tr><td>a</td><td>1,200</td></tr><tr><td>b</td><td>3.5</td></tr></tbody></table>";
    const out = summarizeOutput({ channel: "output", mimetype: "text/html", data: html })!;
    expect(out.kind).toBe("table");
    expect(out.table).toMatchObject({ columns: ["name", "n"], numeric: [false, true], rows: [["a", "1,200"], ["b", "3.5"]] });
    const prose = `<p>${"A long explanation of the numbers. ".repeat(4)}</p>${html}`;
    const mixed = summarizeOutput({ channel: "output", mimetype: "text/html", data: prose })!;
    expect(mixed.kind).toBe("text");
    expect(mixed.table).toEqual(out.table);
    expect(mixed.blocks?.map(block => block.output.kind)).toEqual(["text", "table"]);
    expect(mixed.blocks?.[1]?.output.table).toEqual(out.table);
  });

  test("widgets: their kind, label, value and range, as marimo writes them", () => {
    const slider = "<marimo-ui-element object-id='Hbol-0' random-id='x'><marimo-slider data-initial-value='0.3' data-label='&quot;&lt;span class=&#92;&quot;markdown&#92;&quot;&gt;alpha&lt;/span&gt;&quot;' data-start='0' data-stop='1' data-step='0.1' data-steps='[]' data-disabled='false'></marimo-slider></marimo-ui-element>";
    const dropdown = "<marimo-ui-element object-id='Hbol-1' random-id='y'><marimo-dropdown data-initial-value='[&quot;Two&quot;]' data-label='null' data-options='[&quot;One&quot;,&quot;Two&quot;]' data-allow-select-none='false'></marimo-dropdown></marimo-ui-element>";
    const checkbox = "<marimo-ui-element object-id='Hbol-2' random-id='z'><marimo-checkbox data-initial-value='true' data-label='&quot;c&quot;' data-disabled='true'></marimo-checkbox></marimo-ui-element>";
    const text = "<marimo-ui-element object-id='Hbol-3' random-id='t'><marimo-text data-initial-value='&quot;hi&quot;' data-label='&quot;t&quot;'></marimo-text></marimo-ui-element>";
    const button = "<marimo-ui-element object-id='Hbol-4' random-id='b'><marimo-button data-initial-value='0' data-label='&quot;go&quot;'></marimo-button></marimo-ui-element>";
    const other = "<marimo-ui-element object-id='Hbol-5' random-id='o'><marimo-file-browser data-initial-value='[]'></marimo-file-browser></marimo-ui-element>";
    const out = summarizeOutput({ channel: "output", mimetype: "text/html", data: `<div>${slider}${dropdown}${checkbox}${text}${button}${other}</div>` })!;
    expect(out.kind).toBe("widgets");
    expect(out.widgets?.map((w) => w.kind)).toEqual(["slider", "dropdown", "checkbox", "text", "button", "other"]);
    expect(out.widgets?.[0]).toMatchObject({ objectId: "Hbol-0", label: "alpha", initial: 0.3, start: 0, stop: 1, step: 0.1, steps: [], disabled: false });
    expect(out.widgets?.[1]).toMatchObject({ label: "", initial: ["Two"], options: ["One", "Two"] });
    expect(out.widgets?.[2]).toMatchObject({ initial: true, disabled: true });
    expect(out.widgets?.[5]).toMatchObject({ kind: "other", tag: "marimo-file-browser" });
    // A widget beside text keeps both.
    const both = summarizeOutput({ channel: "output", mimetype: "text/html", data: `<div>${slider}<p>value 0.3</p></div>` })!;
    expect(both).toMatchObject({ kind: "text", text: "value 0.3" });
    expect(both.widgets).toHaveLength(1);
  });

  test("a traceback is an error MIME block on stderr", async () => {
    const console = new CellConsole();
    await console.append({ channel: "stderr", mimetype: "application/vnd.marimo+traceback", data: '<pre><span class="gt">Traceback (most recent call last):</span>\n  File <span class="s">"x.py"</span>\n<span class="ne">ZeroDivisionError</span>: division by zero</pre>' });
    expect(console.snapshot().map(l => `${l.stream}:${l.text}`)).toEqual(["stderr:Traceback (most recent call last):", 'stderr:  File "x.py"', "stderr:ZeroDivisionError: division by zero"]);
    expect(console.snapshot().every(line => line.severity === "error")).toBe(true);
    console.dispose();
  });

  test("a mimebundle (marimo 0.25's matplotlib figures) shows its PNG", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.marimo+mimebundle", data: { "image/png": `data:image/png;base64,${png}`, "text/plain": "<Figure>" } })).toMatchObject({ kind: "image", image: { data: png } });
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.marimo+mimebundle", data: JSON.stringify({ "text/plain": "42" }) })).toEqual({ kind: "text", text: "42" });
  });
});
