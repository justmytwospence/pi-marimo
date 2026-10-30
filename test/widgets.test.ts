import { afterEach, expect, test, vi } from "vitest";
import type { Widget } from "../src/core/output.js";
import { NotebookState } from "../src/core/notebook.js";
import { WidgetSender, nextValue, typeable, typedValue, widgetHit, widgetLine, widgetValue } from "../src/ui/widgets.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const w = (over: Partial<Widget>): Widget => ({ objectId: "a-0", kind: "slider", tag: "marimo-slider", label: "n", initial: 3, options: [], steps: [], disabled: false, ...over });

afterEach(() => vi.useRealTimers());

test("sliders step by their step, by their steps when given, stay in range, and keep tidy decimals", () => {
  expect(nextValue(w({ start: 0, stop: 10 }), 3, "inc", 0)).toEqual({ value: 4, sub: 0, send: true });
  expect(nextValue(w({ start: 0, stop: 10 }), 9, "inc10", 0)?.value).toBe(10);
  expect(nextValue(w({ start: 0, stop: 1, step: 0.1 }), 0.3, "inc", 0)?.value).toBe(0.4);
  expect(nextValue(w({ start: 0, stop: 1 }), 0.5, "dec", 0)?.value).toBe(0.49);
  expect(nextValue(w({ start: 0, stop: 100, steps: [1, 5, 10, 50] }), 5, "inc", 0)?.value).toBe(10);
  expect(nextValue(w({ start: 0, stop: 10 }), 3, "toggle", 0)).toBeUndefined();
});

test("numbers, ranges, choices, checkboxes and buttons", () => {
  expect(nextValue(w({ kind: "number" }), 7, "dec10", 0)?.value).toBe(-3);
  expect(nextValue(w({ kind: "range-slider", start: 0, stop: 10 }), [2, 5], "inc", 1)).toEqual({ value: [2, 6], sub: 1, send: true });
  expect(nextValue(w({ kind: "range-slider", start: 0, stop: 10 }), [2, 5], "toggle", 0)).toMatchObject({ sub: 1, send: false });
  expect(nextValue(w({ kind: "range-slider", start: 0, stop: 10 }), [5, 5], "inc", 0)?.value).toEqual([5, 5]);
  expect(nextValue(w({ kind: "dropdown", options: ["a", "b"] }), ["b"], "inc", 0)?.value).toEqual(["a"]);
  expect(nextValue(w({ kind: "radio", options: ["a", "b"] }), "a", "dec", 0)?.value).toBe("b");
  expect(nextValue(w({ kind: "multiselect", options: ["a", "b", "c"] }), ["a"], "inc", 0)).toEqual({ value: ["a"], sub: 1, send: false });
  expect(nextValue(w({ kind: "multiselect", options: ["a", "b", "c"] }), ["a"], "toggle", 1)?.value).toEqual(["a", "b"]);
  expect(nextValue(w({ kind: "multiselect", options: ["a", "b", "c"] }), ["a", "b"], "toggle", 0)?.value).toEqual(["b"]);
  expect(nextValue(w({ kind: "checkbox" }), true, "inc", 0)?.value).toBe(false);
  expect(nextValue(w({ kind: "button" }), 2, "toggle", 0)?.value).toBe(3);
  expect(nextValue(w({ kind: "text" }), "x", "inc", 0)).toBeUndefined();
});

test("typed values are checked", () => {
  expect(typedValue(w({ kind: "number", start: 0, stop: 10 }), "12")).toEqual({ error: "Enter a number between 0 and 10." });
  expect(typedValue(w({ kind: "number" }), "x")).toEqual({ error: "Enter a number." });
  expect(typedValue(w({ kind: "number" }), " 4.5 ")).toEqual({ value: 4.5 });
  expect(typedValue(w({ kind: "date" }), "2024-1-2")).toEqual({ error: "Enter a date as YYYY-MM-DD." });
  expect(typedValue(w({ kind: "text" }), "hi there")).toEqual({ value: "hi there" });
});

test("sliders and ranges accept bounded finite typed values and snap to their steps", () => {
  const slider = w({ start: -1, stop: 1, step: 0.1 });
  const range = w({ kind: "range-slider", start: -1, stop: 1, step: 0.1 });
  expect(typeable(slider)).toBe(true);
  expect(typeable(range)).toBe(true);
  expect(typeable(w({ kind: "checkbox" }))).toBe(false);
  expect(typedValue(slider, " 0.34 ")).toEqual({ value: 0.3 });
  expect(typedValue(slider, "-1")).toEqual({ value: -1 });
  expect(typedValue(slider, "1")).toEqual({ value: 1 });
  expect(typedValue(range, " -0.34, 0.76 ")).toEqual({ value: [-0.3, 0.8] });
  expect(typedValue(range, "0.3, 0.3")).toEqual({ value: [0.3, 0.3] });
  expect(typedValue(range, "-1, 1")).toEqual({ value: [-1, 1] });
  for (const text of ["", " ", "NaN", "Infinity", "-Infinity", "1e309", "1.01", "-1.01", "0, 1", "abc"]) {
    expect(typedValue(slider, text)).toHaveProperty("error");
  }
  for (const text of ["", "0", ",", "0,", ", 1", "0, 1, 1", "NaN, 1", "0, Infinity", "-1.01, 0", "0, 1.01", "0.5, 0.4"]) {
    expect(typedValue(range, text)).toHaveProperty("error");
  }
  const discrete = w({ start: 0, stop: 100, steps: [1, 5, 10, 50] });
  expect(typedValue(discrete, "8")).toEqual({ value: 10 });
  expect(typedValue(discrete, "3")).toEqual({ value: 1 }); // Ties use the existing nearest-step helper.
  expect(typedValue(discrete, "100")).toEqual({ value: 50 });
  expect(typedValue(w({ ...discrete, kind: "range-slider" }), "4, 41")).toEqual({ value: [5, 50] });
  expect(typedValue(w({ start: 0, stop: 10 }), "3.6")).toEqual({ value: 4 });
  expect(typedValue(w({ start: 0, stop: 1 }), "0.456")).toEqual({ value: 0.46 });
  expect(typedValue(w({ start: 2, stop: 2 }), "2")).toEqual({ value: 2 });
  expect(typedValue(w({ start: 0.05, stop: 1, step: 0.1 }), "0.26")).toEqual({ value: 0.25 });
  expect(typedValue(w({ kind: "text-area" }), "first\nsecond\n")).toEqual({ value: "first\nsecond\n" });
});

test("disabled widgets cannot be changed by typing, keys or mouse", () => {
  for (const kind of ["slider", "range-slider", "number", "checkbox", "switch", "button", "text", "multiselect"] as const) {
    const widget = w({ kind, disabled: true, start: 0, stop: 10, options: ["a", "b"] });
    expect(typeable(widget)).toBe(typeable({ ...widget, disabled: false }));
    expect(typedValue(widget, "4")).toEqual({ error: "This widget is disabled." });
    expect(nextValue(widget, 3, "inc", 0)).toBeUndefined();
    expect(nextValue(widget, 3, "toggle", 0)).toBeUndefined();
    expect(widgetHit(widget, 3, 4)).toBeUndefined();
  }
});

test("typed step snapping matches mouse values without changing mouse bar math", () => {
  for (const slider of [w({ start: 0.05, stop: 1, step: 0.1 }), w({ start: 0, stop: 10 }), w({ start: 0, stop: 1 })]) {
    for (let col = 0; col < 16; col++) {
      const raw = slider.start! + col / 15 * (slider.stop! - slider.start!);
      const typed = typedValue(slider, String(raw));
      expect(widgetHit(slider, 0, col + 3)).toEqual({ ...typed, drag: true });
    }
  }
  const discrete = w({ start: 0, stop: 100, steps: [1, 5, 10, 50] });
  expect(widgetHit(discrete, 1, 3 + 5)).toEqual({ value: 5, drag: true });
  expect(widgetHit(discrete, 1, 3 + 10)).toEqual({ value: 10, drag: true });
});

test("a widget's line, with the value set since it was made", () => {
  const nb = new NotebookState();
  const slider = w({ start: 0, stop: 10 });
  expect(widgetValue(nb, slider)).toBe(3);
  nb.uiValues.set("a-0", 10);
  const line = widgetLine(slider, widgetValue(nb, slider), undefined, theme);
  expect(line).toBe(`n  ${"━".repeat(15)}●  10  0–10`);
  expect(widgetLine(w({ kind: "dropdown", options: ["One", "Two"], label: "" }), ["Two"], undefined, theme)).toBe("‹ Two ›  2 of 2");
  expect(widgetLine(w({ kind: "checkbox", label: "c", disabled: true }), false, undefined, theme)).toBe("c  [ ]  (disabled)");
  expect(widgetLine(w({ kind: "other", tag: "marimo-file-browser", label: "" }), [], undefined, theme)).toBe("[file-browser widget: o opens the notebook]");
});

test("the sender sends only a widget's last value, after the delay", async () => {
  vi.useFakeTimers();
  const sent: unknown[] = [];
  const sender = new WidgetSender(async (_t, id, value) => { sent.push([id, value]); }, 120);
  const target = { url: "http://h", sessionId: "s" };
  sender.set(target, "a-0", 1);
  sender.set(target, "a-0", 2);
  sender.set(target, "a-1", true);
  await vi.advanceTimersByTimeAsync(100);
  expect(sent).toEqual([]);
  sender.set(target, "a-0", 3);
  await vi.advanceTimersByTimeAsync(130);
  expect(sent).toEqual([["a-1", true], ["a-0", 3]]);
  sender.dispose();
});

test("a click on a widget's line: where on its control says what it does", () => {
  // `n  ` is the label: clicks there only focus.
  expect(widgetHit(w({ start: 0, stop: 10 }), 3, 1)).toBeUndefined();
  expect(widgetHit(w({ start: 0, stop: 10 }), 3, 3)).toEqual({ value: 0, drag: true });
  expect(widgetHit(w({ start: 0, stop: 10 }), 3, 3 + 15)).toEqual({ value: 10, drag: true });
  expect(widgetHit(w({ start: 0, stop: 100, steps: [1, 5, 10, 50] }), 5, 3 + 15)).toEqual({ value: 50, drag: true });
  // The nearer knob of a range moves.
  expect(widgetHit(w({ kind: "range-slider", start: 0, stop: 10 }), [2, 8], 3 + 14)).toEqual({ value: [2, 9], sub: 1, drag: true });
  // ‹ 5 ›: the arrows step, the number is typed.
  const num = w({ kind: "number", label: "", start: 0, stop: 10 });
  expect(widgetHit(num, 5, 0)).toEqual({ action: "dec" });
  expect(widgetHit(num, 5, 2)).toEqual({ type: true });
  expect(widgetHit(num, 5, 4)).toEqual({ action: "inc" });
  const drop = w({ kind: "dropdown", label: "", options: ["a", "bb"] });
  expect(widgetHit(drop, ["bb"], 0)).toEqual({ action: "dec" });
  expect(widgetHit(drop, ["bb"], 5)).toEqual({ action: "inc" });
  // A multiselect's option toggles where it is drawn.
  const multi = w({ kind: "multiselect", label: "", options: ["x", "yy", "z"] });
  expect(widgetHit(multi, ["yy"], 3)).toEqual({ value: [], sub: 1 });
  expect(widgetHit(multi, ["yy"], 7)).toEqual({ value: ["yy", "z"], sub: 2 });
  expect(widgetHit(w({ kind: "checkbox", label: "" }), true, 1)).toEqual({ action: "toggle" });
  expect(widgetHit(w({ kind: "text", label: "" }), "hi", 1)).toEqual({ type: true });
});
