import { describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { NotebookState } from "../src/core/notebook.js";
import type { Followed } from "../src/core/watcher.js";
import { notebookKey } from "../src/ui/identity.js";
import { NotebookView } from "../src/ui/view.js";
import { outputLeaves, summarizeOutput, type CellOutput } from "../src/core/output.js";
import { outputRows } from "../src/ui/outputs.js";

const html = (data: string): CellOutput => summarizeOutput({ channel: "output", mimetype: "text/html", data })!;
const MD = `<span class="markdown prose dark:prose-invert contents"><span class="paragraph"><strong>7</strong> to look at</span>
<span class="paragraph">Readings past the range.</span>
<ul>
<li>a</li>
<li>b</li>
</ul>
<h2 id="h">H</h2>
<span class="paragraph"><code>x</code> <a href="http://a" rel="noopener noreferrer" target="_blank">l</a></span></span>`;
const stat = (label: string, value: string, extra = "") => `<marimo-stat data-value='&quot;${value}&quot;' data-label='&quot;${label}&quot;' data-bordered='false' ${extra}></marimo-stat>`;
const ROW = "display: flex;flex: 1;flex-direction: row;justify-content: space-between;gap: 0.5rem";
const ACCORDION = `<marimo-accordion data-labels='[&quot;&#92;u003cspan class=&#92;&quot;paragraph&#92;&quot;&#92;u003eB2: no protein&#92;u003c/span&#92;u003e&quot;,&quot;B3&quot;]' data-multiple='false' data-expanded='[]'><div><span class="paragraph">VCAM1 x</span></div><div><span class="paragraph">y</span></div></marimo-accordion>`;
const TABS = `<marimo-ui-element object-id='t' random-id='t'><marimo-tabs data-initial-value='&quot;&quot;' data-label='null' data-tabs='[&quot;One&quot;,&quot;Two&quot;]' data-orientation='&quot;horizontal&quot;'><div data-kind='tab'><span class="paragraph">a</span></div><div data-kind='tab'><span class="paragraph">b</span></div></marimo-tabs></marimo-ui-element>`;

describe("HTML output text", () => {
  test("paragraphs, summaries and nested divs separate without doubled blank lines", () => {
    expect(html(`<span class="paragraph">a</span><span class="paragraph">b</span>`).text).toBe("a\n\nb");
    expect(html("<div><div>x</div></div><div>y</div>").text).toBe("x\ny");
  });

  test("prose carries Markdown, with literal syntax escaped", () => {
    const out = html(MD);
    expect(out.markdown).toContain("**7** to look at");
    expect(out.markdown).toContain("- a");
    expect(out.markdown).toContain("## H");
    expect(out.markdown).toContain("`x`");
    expect(out.markdown).toContain("[l](http://a)");
    expect(html("<p>2 * 3 # not a heading</p>").markdown).toBe("2 \\* 3 \\# not a heading");
  });

  test("HTML tables report their full row count", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `<tr><td>${i}</td></tr>`).join("");
    const out = html(`<table><thead><tr><th>n</th></tr></thead><tbody>${rows}</tbody></table>`);
    expect(out.table?.rows).toHaveLength(50);
    expect(out.table?.totalRows).toBe(60);
  });
});

describe("marimo components", () => {
  test("stats of one flex row merge into one card row; a column of them does not", () => {
    const row = html(`<div style='${ROW}'>${stat("Batches", "7 of 7")}${stat("Rate", "2.7%", "data-direction='&quot;increase&quot;'")}</div>`);
    expect(row.blocks).toHaveLength(1);
    expect(row.blocks![0]!.output.stats).toMatchObject([{ label: "Batches", value: "7 of 7" }, { value: "2.7%", good: true }]);
    const column = html(`<div style='display: flex;flex-direction: column'>${stat("A", "1")}${stat("B", "2")}</div>`);
    expect(column.blocks).toHaveLength(2);
  });

  test("callouts and admonitions become containers", () => {
    const callout = html(`<marimo-callout-output data-html='&quot;&#92;u003cspan class=&#92;&quot;paragraph&#92;&quot;&#92;u003eHello &#92;u003cstrong&#92;u003ethere&#92;u003c/strong&#92;u003e&#92;u003c/span&#92;u003e&quot;' data-kind='&quot;warn&quot;'></marimo-callout-output>`);
    expect(callout.blocks![0]!.output.container).toMatchObject({ type: "callout", tone: "warn" });
    expect(callout.blocks![0]!.output.container!.body!.markdown).toBe("Hello **there**");
    const admonition = html(`<div class="admonition attention"><span class="admonition-title">Heads up</span><span class="paragraph">Body</span></div>`);
    expect(admonition.blocks![0]!.output.container).toMatchObject({ type: "callout", tone: "warn", title: "Heads up" });
    expect(admonition.blocks![0]!.output.container!.body!.text).toBe("Body");
  });

  test("details, accordion and tabs are sections", () => {
    const accordion = html(ACCORDION);
    expect(accordion.blocks!.map(b => b.output.container)).toMatchObject([{ type: "disclosure", title: "B2: no protein", open: false }, { type: "disclosure", title: "B3", open: false }]);
    const tabs = html(TABS);
    expect(tabs.blocks!.map(b => [b.output.container?.title, b.output.container?.open])).toEqual([["One", true], ["Two", false]]);
    expect(outputLeaves(tabs).some(leaf => leaf.widgets)).toBe(false);
    const details = html("<details open><summary>S</summary>x</details>");
    expect(details.blocks![0]!.output.container).toMatchObject({ title: "S", open: true });
    expect(details.blocks![0]!.output.container!.body!.text).toBe("x");
    const ids = html(`${ACCORDION}${TABS}`).blocks!.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("outputLeaves descends into section bodies, and the projections follow", () => {
    const table = `<marimo-ui-element object-id='tb' random-id='r'><marimo-table data-data='&quot;[{&#92;&quot;a&#92;&quot;:1}]&quot;' data-total-rows='1' data-total-columns='1'></marimo-table></marimo-ui-element>`;
    const out = html(`<marimo-accordion data-labels='[&quot;T&quot;]' data-multiple='false' data-expanded='[0]'><div>${table}</div></marimo-accordion>`);
    expect(outputLeaves(out).some(leaf => leaf.table)).toBe(true);
    expect(out.table?.objectId).toBe("tb");
  });
});

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const cellOf = (output: CellOutput) => ({ id: "a", output }) as any;
const rows = (output: CellOutput, width: number, extra = {}) => outputRows(cellOf(output), theme, { width, bar: "", pad: "", ...extra }, { textLines: 40, tableRows: 10 }).map(r => r.text);

describe("rendering", () => {
  test("long plain text wraps instead of being cut", () => {
    const lines = rows({ kind: "text", text: "word ".repeat(40).trim() }, 40);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    lines.forEach(line => expect(visibleWidth(line)).toBeLessThanOrEqual(40));
    expect(lines.join(" ")).not.toContain("…");
  });

  test("stat cards sit side by side and wrap into bands", () => {
    const out = html(`<div style='${ROW}'>${stat("Batches", "7 of 7")}${stat("Rate", "2.7%")}</div>`);
    expect(rows(out, 80)).toEqual(["Batches    Rate", "7 of 7     2.7%"]);
    expect(rows(out, 12)).toEqual(["Batches", "7 of 7", "", "Rate", "2.7%"]);
  });

  test("prose columns share rows when they fit, and stack when they do not", () => {
    const out = html(`<div style='${ROW}'><div>left</div><div>right</div></div>`);
    expect(out.blocks![0]!.output.columns).toEqual(["left", "right"]);
    expect(rows(out, 80)).toEqual(["left   right"]);
    expect(rows(out, 6)).toEqual(["left", "", "right"]);
  });

  test("sections show a header and their body only when open", () => {
    const out = html(ACCORDION);
    expect(rows(out, 60)).toEqual(["▸ B2: no protein", "▸ B3"]);
    const opened = rows(out, 60, { disclosureOpen: (id: string) => id.includes("marimo-accordion:0") });
    expect(opened).toContain("▾ B2: no protein");
    expect(opened.join("\n")).toContain("VCAM1 x");
    expect(opened.join("\n")).not.toContain("\ny");
  });
});

function nbWith(output: string): Followed {
  const notebook = new NotebookState();
  notebook.apply("kernel-ready", { cell_ids: ["a"], codes: ["x"], names: ["_"] });
  notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: output } });
  return { attachment: { path: "/w/nb.py", url: "http://fixture.invalid", sessionId: "s" }, notebook, connection: "connected", current: true, touchedAt: 0 };
}
const tui = { requestRender: () => {}, terminal: { rows: 28 } };
const make = (f: Followed) => new NotebookView(tui as any, theme as any, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
const screen = (v: NotebookView) => v.render(100).join("\n");

describe("collapsible sections in the view", () => {
  test("Enter toggles a focused section and the state survives a redraw", () => {
    const v = make(nbWith(ACCORDION));
    try {
      expect(screen(v)).toContain("▸ B2: no protein");
      expect(screen(v)).not.toContain("VCAM1");
      v.handleInput("n");
      v.handleInput("\r");
      expect(screen(v)).toContain("▾ B2: no protein");
      expect(screen(v)).toContain("VCAM1 x");
      expect(screen(v)).toContain("VCAM1 x");
      v.handleInput("\r");
      expect(screen(v)).not.toContain("VCAM1");
    } finally { v.dispose(); }
  });

  test("a click on a section header toggles it", () => {
    const v = make(nbWith(ACCORDION));
    try {
      const lines = v.render(100);
      const y = lines.findIndex(line => line.includes("▸ B2"));
      const x = lines[y]!.indexOf("▸ B2");
      const ev = (type: string) => ({ type, button: "left", x, y, screenX: x, screenY: y, width: 100, height: 28, shift: false, alt: false, ctrl: false }) as any;
      v.handleMouse(ev("click"));
      expect(screen(v)).toContain("VCAM1 x");
    } finally { v.dispose(); }
  });
});
