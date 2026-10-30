import { Editor } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { PillView, renderPill, type PillSource, type PillUI } from "../src/pill.ts";

const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
const tui = { requestRender: () => {}, terminal: { rows: 27 } };
function setup(source: PillSource) {
  const editor = new Editor(tui as any, { borderColor: (s: string) => s } as any);
  const widgets = new Map<string, any>();
  const ui: PillUI = {
    setWidget: (key, factory) => { if (factory) widgets.set(key, factory); else widgets.delete(key); },
    onTerminalInput: () => () => {}, getEditorText: () => editor.getText(),
  };
  const pill = new PillView(source, "pi-marimo-pill");
  pill.setUI(ui); pill.update();
  const widget = widgets.get("pi-marimo-pill")({ ...tui, getFocusedComponent: () => editor }, theme);
  widget.render(100);
  return { pill, widget, editor };
}

it("leaves typed navigation letters to the native editor", () => {
  const open = vi.fn();
  const { pill } = setup({ pill: () => ({ label: "work" }), open });
  try {
    for (const key of ["h", "j", "k", "l", "\x15", "\x04"]) {
      expect(pill.handleKey("\x1b[B")).toEqual({ consume: true });
      expect(pill.handleKey(key)).toBeUndefined();
      expect(pill.isSelected).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
    pill.handleKey("\x1b[B");
    expect(pill.handleKey("\r")).toEqual({ consume: true });
    expect(open).toHaveBeenCalledOnce();
  } finally { pill.dispose(); }
});

it("selects rows, moves through rows and label, opens the row, and returns without touching the draft", () => {
  const open = vi.fn(); const openRow = vi.fn();
  const rows = [
    { key: "a", label: "a.py", detail: ":2718 · idle", status: "done" as const, stats: "", startedAt: 0 },
    { key: "b", label: "b.py", detail: ":2719 · running Fit", status: "running" as const, stats: "0:12", startedAt: 0 },
  ];
  const { pill, widget, editor } = setup({ pill: () => ({ label: "1 notebook", rows }), open, openRow });
  editor.setText("draft");
  try {
    const idle = widget.render(100);
    expect(idle).toHaveLength(3); expect(idle[0]).toContain("a.py");
    expect(idle[1]).toMatch(/○ b\.py {2}:2719 · running Fit +0:12/u);
    expect(idle[2]).toContain("1 notebook");
    expect(pill.handleKey("\x1b[B")).toEqual({ consume: true });
    expect(widget.render(100)).toHaveLength(3);
    expect(widget.render(100)[0]).toContain(" ● a.py");
    expect(pill.handleKey("\x1b[B")).toEqual({ consume: true });
    expect(pill.handleKey("\r")).toEqual({ consume: true });
    expect(openRow).toHaveBeenCalledExactlyOnceWith("b");
    expect(pill.isSelected).toBe(false);
    for (let i = 0; i < 4; i++) pill.handleKey("\x1b[B");
    pill.handleKey("\r"); expect(open).toHaveBeenCalledOnce();
    pill.handleKey("\x1b[B");
    expect(pill.handleKey("\x1b[A")).toEqual({ consume: true });
    expect(pill.isSelected).toBe(false);
    pill.handleKey("\x1b[B"); pill.handleKey("\x1b[B");
    expect(pill.handleKey("\x1b")).toEqual({ consume: true });
    expect(pill.isSelected).toBe(false); expect(editor.getText()).toBe("draft");
  } finally { pill.dispose(); }
});

it("renders a styled notebook row after its selection dot, retaining failure status", () => {
  const row = { key: "a", label: "a.py", detail: "", status: "done" as const, stats: "", startedAt: 0,
    line: (t: typeof theme) => `Marimo ${t.fg("accent", "a.py")}:2718 · idle` };
  expect(renderPill({ label: "", rows: [row] }, false, 80, theme)).toEqual([" ○ Marimo a.py:2718 · idle"]);
  expect(renderPill({ label: "", rows: [row] }, { index: 0 }, 80, theme)[0]).toBe(" ● Marimo a.py:2718 · idle");
  expect(renderPill({ label: "", rows: [{ ...row, status: "failed" }] }, false, 30, theme)[0]).toBe(" ○ Marimo a.py:2718 · idle   ✗");
});

it("reselects the same row when its view returns, not the prompt", async () => {
  let close!: () => void;
  const openRow = vi.fn(() => new Promise<void>((resolve) => { close = resolve; }));
  const rows = ["a", "b", "c"].map((key) => ({ key, label: `${key}.py`, detail: "", status: "done" as const, stats: "", startedAt: 0 }));
  const { pill, widget } = setup({ pill: () => ({ label: "", rows }), open: () => {}, openRow });
  try {
    pill.handleKey("\x1b[B"); pill.handleKey("\x1b[B"); pill.handleKey("\r");
    expect(openRow).toHaveBeenCalledWith("b"); expect(pill.isSelected).toBe(false);
    close(); await new Promise((r) => setTimeout(r, 0));
    expect(pill.isSelected).toBe(true);
    pill.handleKey("\r"); expect(openRow).toHaveBeenLastCalledWith("b");
    close(); await new Promise((r) => setTimeout(r, 0));
    expect(pill.handleKey("\x1b")).toEqual({ consume: true });
    expect(pill.isSelected).toBe(false); expect(widget.render(100)).toHaveLength(3);
  } finally { pill.dispose(); }
});
