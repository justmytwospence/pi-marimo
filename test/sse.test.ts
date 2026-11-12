import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { NotebookState } from "../src/core/notebook.js";
import { SessionDecoder, SseParser } from "../src/core/sse.js";

const ev = (event: string | undefined, data: unknown) => ({ ...(event ? { event } : {}), data: JSON.stringify(data) });

describe("SseParser", () => {
  test("keeps event ids", () => {
    expect(new SseParser().push("id: e-1\nevent: ready\ndata: {}\n\n")).toEqual([{ event: "ready", id: "e-1", data: "{}" }]);
  });
});

describe("SessionDecoder", () => {
  test("legacy message events unwrap op and data", () => {
    expect(new SessionDecoder().decode(ev(undefined, { op: "cell-op", data: { cell_id: "a" } }))).toEqual([{ op: "cell-op", data: { cell_id: "a" } }]);
    expect(new SessionDecoder().decode(ev("message", { op: "x", data: 1 }))).toEqual([{ op: "x", data: 1 }]);
  });
  test("marimo events carry the fields inline; kernel-ready gains the buffered cells", () => {
    const d = new SessionDecoder();
    d.decode(ev("cell", { cell: { id: "a", code: "x = 1", name: "_", config: { hide_code: true } } }));
    d.decode(ev("cell", { cell: { id: "b", code: "y = x", name: "named", config: {} } }));
    d.decode(ev("document", { document: { order: ["b", "a", "gone"] } }));
    const [ready] = d.decode(ev("marimo", { marimo: { op: "kernel-ready", ui_values: {} } }));
    expect(ready).toMatchObject({ op: "kernel-ready", data: { cell_ids: ["b", "a"], codes: ["y = x", "x = 1"], names: ["named", "_"], configs: [{}, { hide_code: true }] } });
  });
  test("kernel-ready that already lists cells passes through", () => {
    const data = { op: "kernel-ready", cell_ids: ["z"], codes: ["1"] };
    expect((new SessionDecoder().decode(ev("marimo", { marimo: data }))[0]!.data as { cell_ids: string[] }).cell_ids).toEqual(["z"]);
  });
  test("cell.removed drops a buffered cell; other events and bad JSON are ignored", () => {
    const d = new SessionDecoder();
    d.decode(ev("cell", { cell: { id: "a", code: "1" } }));
    d.decode(ev("document", { document: { order: ["a"] } }));
    d.decode(ev("cell.removed", { id: "a" }));
    expect((d.decode(ev("marimo", { marimo: { op: "kernel-ready" } }))[0]!.data as { cell_ids: string[] }).cell_ids).toEqual([]);
    expect(d.decode(ev("run", { run: {} }))).toEqual([]);
    expect(d.decode({ event: "marimo", data: "{nope" })).toEqual([]);
  });
});

describe("host session fixture (marimo main)", () => {
  test("builds a ready notebook", () => {
    const nb = new NotebookState();
    const decoder = new SessionDecoder();
    for (const event of new SseParser().push(readFileSync(new URL("./fixtures/host-session.sse", import.meta.url), "utf8"))) {
      for (const m of decoder.decode(event)) nb.apply(m.op, m.data);
    }
    expect(nb.ready).toBe(true);
    expect(nb.order).toEqual(["Hbol", "MJUe", "vblA", "bkHC"]);
    expect(nb.cells.get("vblA")!.code).toContain("time.sleep(1)");
    expect(nb.cells.get("MJUe")!.output?.text).toContain("Loading");
    expect(nb.defs.get("vblA")).toContain("y");
  });
});
