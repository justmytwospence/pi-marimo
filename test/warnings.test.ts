import { describe, expect, test } from "vitest";
import { parseWarnings, shortPath } from "../src/core/warnings.js";
import { warningRows } from "../src/ui/warnings.js";
import type { ConsoleLine } from "../src/core/output.js";

const NAMES = ["FunctionTransformer", "ColumnTransformer", "SimpleImputer", "StandardScaler", "LinearRegression", "Pipeline"];
const URL = "https://scikit-learn.org/stable/model_persistence.html#security-maintainability-limitations";
const sklearn = (names: string[]) => names.flatMap(n => [
  `/Users/x/Projects/bio/.venv/lib/python3.12/site-packages/sklearn/base.py:525: InconsistentVersionWarning: Trying to unpickle estimator ${n} from version 1.8.0 when using version 1.9.0. This might lead to breaking code or invalid results. Use at your own risk. For more info please refer to:`,
  URL,
  "  warnings.warn(",
]);
const lines = (texts: string[]): ConsoleLine[] => texts.map(text => ({ stream: "stderr", text, severity: "warning" }));
const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };

describe("parseWarnings", () => {
  test("groups the repeated sklearn warning", () => {
    const items = parseWarnings(sklearn(NAMES));
    expect(items).toHaveLength(1);
    const item = items[0]!;
    if (item.kind !== "warning") throw new Error("kind");
    expect(item.count).toBe(6);
    expect(item.file.endsWith("sklearn/base.py")).toBe(true);
    expect(item.line).toBe(525);
    expect(item.message).toHaveLength(2);
    expect(item.message.join("\n")).not.toContain("warnings.warn(");
    expect(item.varies).toEqual(NAMES);
  });

  test("interleaved call sites make two groups in first-seen order", () => {
    const a = (n: number) => [`/a.py:1: UserWarning: a ${n}`, "  x()"];
    const b = (n: number) => [`/b.py:2: UserWarning: b ${n}`, "  y()"];
    const items = parseWarnings([...a(1), ...b(1), ...a(2)]);
    expect(items.map(i => i.kind === "warning" ? `${i.file}:${i.count}` : "line")).toEqual(["/a.py:2", "/b.py:1"]);
  });

  test("plain lines stay in order and an empty line ends a record", () => {
    const items = parseWarnings(["before", "/a.py:1: UserWarning: m", "", "after"]);
    expect(items.map(i => i.kind)).toEqual(["line", "warning", "line", "line"]);
    expect(items.filter(i => i.kind === "line").map(i => (i as { index: number }).index)).toEqual([0, 2, 3]);
  });

  test("a record without a source line is followed by the next header", () => {
    const items = parseWarnings(["/a.py:1: UserWarning: m", "/b.py:2: UserWarning: n"]);
    expect(items).toHaveLength(2);
  });

  test("different token counts list distinct messages", () => {
    const item = parseWarnings(["/a.py:1: UserWarning: one two", "  w", "/a.py:1: UserWarning: one two three", "  w"])[0]!;
    if (item.kind !== "warning") throw new Error("kind");
    expect(item.varies).toEqual([]);
    expect(item.distinct).toEqual([["one two"], ["one two three"]]);
  });

  test("identical messages only count", () => {
    const item = parseWarnings(["/a.py:1: UserWarning: same", "  w", "/a.py:1: UserWarning: same", "  w"])[0]!;
    if (item.kind !== "warning") throw new Error("kind");
    expect(item.count).toBe(2);
    expect(item.varies).toEqual([]);
  });
});

test("shortPath", () => {
  expect(shortPath("/v/.venv/lib/python3.12/site-packages/sklearn/base.py")).toBe("sklearn/base.py");
  expect(shortPath("/usr/lib/python3/dist-packages/foo.py")).toBe("foo.py");
  expect(shortPath("/usr/lib/python3.12/warnings.py")).toBe("warnings.py");
  expect(shortPath("/Users/me/x.py", "/Users/me")).toBe("~/x.py");
  expect(shortPath("/opt/y.py", "/Users/me")).toBe("/opt/y.py");
});

describe("warningRows", () => {
  test("renders the sklearn fixture as four rows", () => {
    const rows = warningRows(lines(sklearn(NAMES)), theme).map(r => r.text);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe("InconsistentVersionWarning ×6  sklearn/base.py:525");
    expect(rows[2]).toBe(URL);
    expect(rows[3]).toBe(`varies: ${NAMES.join(", ")}`);
    expect(rows.join("\n")).not.toContain("warnings.warn(");
  });
  test("caps the varies row", () => {
    const names = Array.from({ length: 10 }, (_, i) => `N${i}`);
    expect(warningRows(lines(sklearn(names)), theme).at(-1)!.text).toMatch(/, \+2 more$/u);
  });
});
