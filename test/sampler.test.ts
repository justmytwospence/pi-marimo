import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { parseOutputFragment } from "../src/core/html.js";
import { nutpieProgressFromNode } from "../src/core/sampler.js";
import { progressFromHtml } from "../src/core/progress.js";
import { samplerRows } from "../src/ui/sampler.js";
import { progressRows } from "../src/ui/progress.js";

const fixture = readFileSync(new URL("./fixtures/nutpie-0.16.8.html", import.meta.url), "utf8");
const root = (html: string) => parseOutputFragment(html).childNodes.find(node => "tagName" in node && node.tagName === "div")!;
const theme = { fg: (color: string, text: string) => color === "warning" ? `\x1b[33m${text}\x1b[0m` : text, bold: (text: string) => text };

describe("nutpie 0.16.8 structured adapter", () => {
  it("parses the synthetic producer template, duplicate span ID and stray closing tr, once", () => {
    expect(fixture).toContain('id="active-chains">4');
    expect(fixture).toContain('id="active-chains">0');
    expect(fixture).toContain("</tr>\n    </tbody>");
    const tasks = nutpieProgressFromNode(root(fixture), "sample")!;
    expect(tasks).toHaveLength(5);
    expect(tasks.map(task => task.id)).toEqual(["sample:total", ...[0, 1, 2, 3].map(i => `sample:chain:${i}`)]);
    expect(tasks[0]).toMatchObject({ label: "Sampler", completed: 136, total: 6000, state: "running", sampler: { producer: "nutpie", groupId: "sample", role: "total", summary: { totalChains: 4, activeChains: 4, finishedChains: 0, elapsed: "4 minutes", eta: "3 hours" } } });
    expect(tasks.slice(1).map(task => [task.completed, task.total, task.stats.Draws, task.label])).toEqual([[42, 1500, "42", "Chain 1"], [41, 1500, "41", "Chain 2"], [27, 1500, "27", "Chain 3"], [26, 1500, "26", "Chain 4"]]);
    expect(progressFromHtml(fixture)).toHaveLength(5);
  });

  it("retains each independent max, unknown counts, mismatched Draws and raw counts beyond total", () => {
    const unequal = fixture.replace('value="41" max="1500"', 'value="41" max="800"')
      .replace('value="27" max="1500"', 'value="27" max="900"')
      .replace('value="26" max="1500"', 'value="26" max="2000"');
    const tasks = nutpieProgressFromNode(root(unequal), "unequal")!;
    expect(tasks.slice(1).map(task => task.total)).toEqual([1500, 800, 900, 2000]);
    expect(tasks[0]?.total).toBe(6000);
    const unknown = unequal.replace('value="136" max="6000"', 'value="136" max="0"')
      .replace('value="42" max="1500"', 'value="12" max="invalid"')
      .replace('<td>42</td>', '<td>19</td>')
      .replace('value="41" max="800"', 'value="1000" max="800"')
      .replace('value="27" max="900"', 'max="900"')
      .replace('<td>27</td>', '<td>unknown</td>')
      .replace('value="26" max="2000"', 'max="2000"');
    const parsed = nutpieProgressFromNode(root(unknown), "unknown")!;
    const absentMax = nutpieProgressFromNode(root(fixture.replace('value="42" max="1500"', 'value="42"')), "absent")!;
    expect(absentMax[1]?.total).toBeUndefined();
    expect(absentMax[1]?.state).toBe("running");
    expect(parsed[0]).toMatchObject({ completed: 136, state: "running" });
    expect(parsed[0]?.total).toBeUndefined();
    expect(parsed[1]).toMatchObject({ completed: 12, stats: { Draws: "19" }, state: "running" });
    expect(parsed[1]?.total).toBeUndefined();
    expect(parsed[2]).toMatchObject({ completed: 1000, total: 800, state: "complete" });
    expect(parsed[3]?.completed).toBeUndefined();
    expect(parsed[4]).toMatchObject({ completed: 26, total: 2000 }); // Draws supplied a missing value.
    for (const task of parsed) { expect(task.rate).toBeUndefined(); expect(task.etaSeconds).toBeUndefined(); }
    expect(parsed[0]?.sampler?.summary?.eta).toBe("3 hours");
  });

  it("supports empty/complete snapshots and retains arbitrary duplicate diagnostics and summary text", () => {
    const extra = fixture.replace('<p>Time Elapsed:', '<p>Sampler notice: synthetic</p><p>Time Elapsed:')
      .replace('<th>Gradients/Draw</th>', '<th>Gradients/Draw</th><th>Metric</th><th>Metric</th>')
      .replace(/<td>(127|255|511)<\/td><\/tr>/gu, '<td>$1</td><td>x</td><td>y</td></tr>');
    const parsed = nutpieProgressFromNode(root(extra), "extra")!;
    expect(parsed[0]?.stats).toEqual({ "Summary 1": "Sampler notice: synthetic" });
    expect(parsed[1]?.stats).toMatchObject({ Metric: "x", "Metric (2)": "y" });
    const empty = fixture.replace(/<tr><td><progress value="(?:42|41|27|26)"[^\n]+\n/gu, "");
    expect(nutpieProgressFromNode(root(empty), "empty")).toHaveLength(1);
    const complete = empty.replace('value="136" max="6000"', 'value="6000" max="6000"');
    expect(nutpieProgressFromNode(root(complete), "complete")?.[0]?.state).toBe("complete");
  });

  it("rejects unknown and mismatched containers without claiming their native controls", () => {
    for (const html of [fixture.replace('class="nutpie"', 'class="other"'), fixture.replace('id="chain-details"', 'id="different"'), fixture.replace('<th>Draws</th>', '<th>Things</th>'), fixture.replace('<td>42</td>', ''), fixture.replace('</table>', '</table><aside>unknown content</aside>'), fixture.replace('</table>', '</table><script>unknown()</script>'), fixture.replace('</table>', '</table>unexpected text'), fixture.replace('Total Chains:', '<script>bad()</script>Total Chains:')]) {
      expect(nutpieProgressFromNode(root(html), "unknown")).toBeUndefined();
    }
    expect(progressFromHtml(fixture.replace('id="chain-details"', 'id="different"')).length).toBe(5); // ordinary native progress traversal
  });
});

describe("compact sampler rows", () => {
  const tasks = nutpieProgressFromNode(root(fixture), "sample")!;
  it.each([20, 46, 80, 120, 180])("fits %i columns and retains every chain/diagnostic without table chrome", width => {
    const rows = samplerRows(tasks, width, theme, 0);
    const plain = rows.map(row => stripTerminalSequences(row.text)).join("\n");
    expect(rows.every(row => visibleWidth(row.text) <= width)).toBe(true);
    expect(new Set(rows.map(row => row.progress?.id))).toEqual(new Set(tasks.map(task => task.id)));
    for (const count of ["42/1500", "41/1500", "27/1500", "26/1500"]) expect(plain).toContain(count);
    for (const value of ["127", "255", "511", "0.05", "0.04", "0.01"]) expect(plain).toContain(value);
    expect(plain).not.toMatch(/rows 1–4|total unknown|phase|\/s\b/iu);
    if (width >= 80) { expect(rows.length).toBeLessThanOrEqual(10); expect(plain).toMatch(/Chain\s+Progress/u); }
    expect(plain).not.toContain("Draws: 42");
    if (width <= 46) expect(plain).not.toMatch(/Chain\s+Progress/u);
  });
  it("surfaces divergence warnings, mismatched Draws and unknown columns in continuations", () => {
    const modified = fixture.replace('<td>42</td><td>0</td>', '<td>99</td><td>2</td>')
      .replace('<th>Gradients/Draw</th>', '<th>Gradients/Draw</th><th>Notice</th>')
      .replace(/<td>(127|255|511)<\/td><\/tr>/gu, '<td>$1</td><td>diagnostic</td></tr>');
    const parsed = nutpieProgressFromNode(root(modified), "warn")!;
    for (const width of [20, 80]) {
      const text = samplerRows(parsed, width, theme, 0).map(row => row.text).join("\n");
      expect(text).toContain("\x1b[33m");
      expect(stripTerminalSequences(text)).toContain("Draws: 99");
      expect(stripTerminalSequences(text)).toContain("Notice: diagnostic");
    }
  });
  it("omits bars below eight columns without dropping textual counts", () => {
    for (const width of [1, 7]) {
      const rows = samplerRows(tasks, width, theme, 0);
      expect(rows.every(row => visibleWidth(row.text) <= width)).toBe(true);
      expect(rows.map(row => stripTerminalSequences(row.text)).join("")).toContain("42/1500");
      expect(rows.map(row => row.text).join("")).not.toContain("[");
    }
  });
  it("does not collapse distinct groups or generic progress", () => {
    const other = nutpieProgressFromNode(root(fixture), "other")!;
    const generic = { id: "ordinary", label: "Download", state: "running" as const, stats: {}, completed: 2, total: 4 };
    const rows = progressRows([...tasks, generic, ...other], 80, theme, 0);
    expect(rows.filter(row => row.progress?.id === "ordinary").length).toBeGreaterThan(0);
    expect(rows.filter(row => row.progress?.id === "sample:total").length).toBeGreaterThan(0);
    expect(rows.filter(row => row.progress?.id === "other:total").length).toBeGreaterThan(0);
  });
});
