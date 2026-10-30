import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { progressFromHtml, progressFromText, type ProgressTask } from "../src/core/progress.js";

type Fixture = {
  name: string;
  producer: string;
  version: string;
  sourceUrl: string;
  provenance: string;
  kind: "html" | "text";
  input: string | string[];
  expected: Omit<ProgressTask, "id">[];
};
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("./fixtures/progress.json", import.meta.url), "utf8"));

describe("producer progress fixtures", () => {
  for (const fixture of fixtures) it(fixture.name, () => {
    expect(fixture.producer).toBeTruthy();
    expect(fixture.version).toBeTruthy();
    expect(fixture.provenance).toBeTruthy();
    expect(fixture.sourceUrl).toMatch(/^https:\/\//);
    const tasks = fixture.kind === "html"
      ? progressFromHtml(fixture.input as string)
      : progressFromText(fixture.input as string[]);
    expect(tasks.map(({ id: _id, ...rest }) => rest)).toEqual(fixture.expected);
    expect(new Set(tasks.map(t => t.id)).size).toBe(tasks.length);
  });
});

describe("HTML progress contracts", () => {
  it("is stateless: a new snapshot replaces chains rather than appending", () => {
    const html = (count: number) => `<table class="pymc-progress-table"><tr><th>Chain</th></tr>${Array.from({ length: count }, (_, i) => `<tr><td>${i}</td></tr>`).join("")}</table>`;
    expect(progressFromHtml(html(4))).toHaveLength(4);
    expect(progressFromHtml(html(1))).toHaveLength(1);
    expect(progressFromHtml("")).toEqual([]);
    expect(progressFromHtml(html(1))[0]?.id).toBe(progressFromHtml(html(1))[0]?.id);
  });

  it("keeps native raw counters beyond the total; a boolean never becomes a count", () => {
    const [over, spinner] = progressFromHtml(`<marimo-progress data-progress='12' data-total='10'></marimo-progress><marimo-progress data-progress='true' data-total='10'></marimo-progress>`);
    expect(over).toMatchObject({ completed: 12, total: 10, state: "complete" });
    expect(spinner?.completed).toBeUndefined();
    expect(spinner?.total).toBeUndefined();
    expect(spinner?.state).toBe("running");
  });

  it("accepts native numeric and numeric-string rate/ETA, not formatted guesses", () => {
    const [numeric, strings, formatted] = progressFromHtml(`<marimo-progress data-rate='0.5' data-eta='12.5'></marimo-progress><marimo-progress data-rate='&quot;0.5&quot;' data-eta='&quot;12.5&quot;'></marimo-progress><marimo-progress data-rate='&quot;2s/it&quot;' data-eta='&quot;soon&quot;'></marimo-progress>`);
    expect(numeric).toMatchObject({ rate: 0.5, etaSeconds: 12.5 });
    expect(strings).toMatchObject({ rate: 0.5, etaSeconds: 12.5 });
    expect(formatted?.rate).toBeUndefined();
    expect(formatted?.etaSeconds).toBeUndefined();
    expect(numeric?.elapsedSeconds).toBeUndefined();
  });

  it("ignores scripts/styles/templates and keeps labels inert", () => {
    expect(progressFromHtml(`<script><progress value=1></progress></script><style>progress { width:100% }</style><template><progress></progress></template>`)).toEqual([]);
    expect(progressFromHtml(`<progress value='.2' aria-label='&lt;script&gt;alert(1)&lt;/script&gt;'></progress>`)[0]).toMatchObject({ label: "<script>alert(1)</script>", completed: 0.2, total: 1 });
  });

  it("rejects malformed JSON, negative/nonfinite counters and non-numeric widths", () => {
    const [native] = progressFromHtml(`<marimo-progress data-title='invalid' data-progress='false' data-total='-1' data-rate='1e999' data-eta='null'></marimo-progress>`);
    expect(native?.label).toBe("");
    for (const key of ["completed", "total", "rate", "etaSeconds"] as const) expect(native?.[key]).toBeUndefined();
    for (const width of ["var(--progress)", "calc(30% + 1px)", "NaN%", "Infinity%", "-10%", "75px"]) {
      const [t] = progressFromHtml(`<table class='pymc-progress-table'><tr><th>Progress</th><th>Speed</th></tr><tr><td><div style='width:${width}'></div></td><td>123</td></tr></table>`);
      expect(t?.stats.percent).toBeUndefined();
      expect(t?.completed).toBeUndefined();
      expect(t?.total).toBeUndefined();
      expect(t?.rate).toBeUndefined();
    }
  });

  it("retains duplicate, missing and arbitrary PyMC columns without interpreting stats as counts", () => {
    const [t] = progressFromHtml(`<table class='pymc-progress-table'><tr><th>Progress</th><th>Stat</th><th>Stat</th></tr><tr><td>80%</td><td>12</td><td>9</td><td>other</td></tr></table>`);
    expect(t?.stats).toEqual({ Progress: "80%", percent: "80", Stat: "12", "Stat (2)": "9", "Column 4": "other" });
    expect(t?.completed).toBeUndefined();
    expect(t?.total).toBeUndefined();
  });

  it("preserves supplied PyMC counts with unknown totals, without deriving rates", () => {
    const [t] = progressFromHtml(`<table class='pymc-progress-table'><tr><th>Draw</th><th>Progress</th><th>Elapsed</th></tr><tr><td>4/? (0%)</td><td><div style='width:0%'></div></td><td>0.2s</td></tr></table>`);
    expect(t).toMatchObject({ completed: 4, elapsedSeconds: 0.2, state: "running" });
    expect(t?.total).toBeUndefined();
    expect(t?.rate).toBeUndefined();
  });

  it("does not parse ordinary tables or duplicate nested progress controls", () => {
    expect(progressFromHtml(`<table><tr><th>Progress</th></tr><tr><td>50%</td></tr></table>`)).toEqual([]);
    expect(progressFromHtml(`<table class='pymc-progress-table'><tr><td><progress value=1></progress></td></tr></table>`)).toHaveLength(1);
  });

  it("applies HTML's default max and leaves missing values indeterminate", () => {
    const [done, waiting] = progressFromHtml(`<progress value='1'></progress><progress max='10'></progress>`);
    expect(done).toMatchObject({ completed: 1, total: 1, state: "complete" });
    expect(waiting?.completed).toBeUndefined();
    expect(waiting?.state).toBe("running");
  });
});

describe("terminal progress contracts", () => {
  it("does not turn mathematical fractions or resource percentages into progress", () => {
    expect(progressFromText(["1/2", "ratio: 1/2", "CPU: 25%", "25%"])).toEqual([]);
  });
  it("supports bare unambiguous fractions and labelled percentages without inventing counts", () => {
    const [fraction, percent] = progressFromText(["Batch: 15/10", "Download: 25%"]);
    expect(fraction).toMatchObject({ label: "Batch", completed: 15, total: 10, state: "complete" });
    expect(percent).toMatchObject({ label: "Download", stats: { percent: "25" } });
    expect(percent?.completed).toBeUndefined();
    expect(percent?.total).toBeUndefined();
  });

  it("handles Keras without percent and preserves metrics separately", () => {
    expect(progressFromText(["10/10 [====================] - 2s - loss: 0.1"])[0]).toMatchObject({ completed: 10, total: 10, state: "complete", stats: { details: "2s - loss: 0.1" } });
  });

  it("parses explicit Keras ETA without turning it into elapsed time", () => {
    expect(progressFromText(["4/10 [====>.....] - ETA: 2s - loss: 0.1"])[0]).toMatchObject({ etaSeconds: 2 });
  });

  it("keeps unknown ETA and zero total indeterminate, with raw counters unchanged", () => {
    const [t] = progressFromText(["0%|          | 0/0 [00:00<?, ?it/s]"]);
    expect(t).toMatchObject({ completed: 0, total: 0, elapsedSeconds: 0, state: "running" });
    expect(t?.etaSeconds).toBeUndefined();
    expect(t?.rate).toBeUndefined();
  });

  it("does not retain previous snapshots or conflate distinct rows", () => {
    expect(progressFromText(["A: 1/3 [==>...]", "B: 2/3 [====>..]"])).toHaveLength(2);
    expect(progressFromText(["B: 3/3 [======]"])).toHaveLength(1);
    expect(progressFromText([])).toEqual([]);
  });
});
