import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import { NotebookSplit } from "../src/ui/split.ts";

const root = process.env.PI_PLUGINS_ROOT;
const suite = (...parts: string[]) => pathToFileURL(resolve(root!, ...parts)).href;
const leaf = (): Component => ({ render: () => [], invalidate() {} });

/** Exercise Pi's ordered, stop-on-consume raw listeners, not a mocked panel owner. */
describe.skipIf(!root)("Sidebar and notebook toggle integration", () => {
  async function setup(order: "sidebar-first" | "notebook-first", active: () => string | undefined, keys = ["ctrl+'"] ) {
    const { SidebarController } = await import(suite("packages/pi-sidebar/src/controller.ts"));
    const { FakePi, fakeCtx } = await import(suite("packages/pi-sidebar/test/fake.ts"));
    const pi = new FakePi();
    const sidebar = new SidebarController(pi as never, keys);
    const { ctx } = fakeCtx({ sessionId: `shortcut-${order}-${Math.random()}` });
    const editor = leaf();
    const listeners: Array<(data: string) => unknown> = [];
    const tui: any = {
      mode: "fullscreen", layoutRoot: leaf(), terminal: { columns: 140, rows: 45, write() {} },
      focused: editor, requestRender() {},
      getFocusedComponent() { return this.focused; },
      setFocus(component: Component | null) {
        if (this.focused && "focused" in this.focused) this.focused.focused = false;
        this.focused = component;
        if (component && "focused" in component) (component as any).focused = true;
      },
      setLayoutRoot(component: Component | undefined) { this.layoutRoot = component; },
    };
    (ctx.ui as any).setWidget = (_: string, factory?: (tui: unknown, theme: unknown) => unknown) => factory?.(tui, ctx.ui.theme);
    (ctx.ui as any).onTerminalInput = (handler: (data: string) => unknown) => {
      listeners.push(handler);
      return () => { const i = listeners.indexOf(handler); if (i >= 0) listeners.splice(i, 1); };
    };
    const views: any[] = [];
    const split = new NotebookSplit(pi as never, (_t, _th, key) => {
      const view = { notebook: key, focused: false, render: () => ["NB"], invalidate() {}, handleInput() {}, dispose: vi.fn(), snapshot: () => ({}), requestClose: vi.fn(async () => false) };
      views.push(view);
      return view as never;
    }, { active, toggleKeys: keys });
    if (order === "notebook-first") split.listen(ctx as never);
    await pi.emit("session_start", { reason: "startup" }, ctx);
    if (order === "sidebar-first") split.listen(ctx as never);
    const input = (key: string) => { for (const listener of [...listeners]) if ((listener(key) as { consume?: boolean } | undefined)?.consume) return true; return false; };
    const prompt = (name: string, event: unknown = {}) => { for (const handler of pi.handlers.get(name) ?? []) handler(event, ctx); };
    const shutdown = async () => { split.shutdown(); await pi.emit("session_shutdown", {}, ctx); };
    return { pi, ctx, sidebar, split, views, editor, tui, input, prompt, shutdown };
  }

  for (const order of ["sidebar-first", "notebook-first"] as const) {
    it(`${order}: one press opens the notebook, release/hold do not close it, next press does`, async () => {
      const s = await setup(order, () => "fit.py");
      try {
        expect(s.input("\x1b[39;5u")).toBe(true);
        expect(s.split.isOpen).toBe(true);
        expect(s.sidebar.isOpen).toBe(false);
        expect(s.tui.focused).toBe(s.views[0]);
        expect(s.input("\x1b[39;5:2u")).toBe(true);
        expect(s.input("\x1b[39;5:3u")).toBe(false);
        expect(s.split.isOpen).toBe(true);
        expect(s.input("\x1b[39;5u")).toBe(true);
        expect(s.split.isOpen).toBe(false);
        expect(s.tui.focused).toBe(s.editor);
        expect(s.sidebar.isOpen).toBe(false);
      } finally { await s.shutdown(); }
    });

    it(`${order}: open Sidebar owns the shortcut; /sidebar always selects Sidebar`, async () => {
      const s = await setup(order, () => "fit.py");
      try {
        s.sidebar.toggle(s.ctx as never);
        expect(s.sidebar.isOpen).toBe(true);
        s.input("\x1b[39;5u");
        expect(s.sidebar.isOpen).toBe(false);
        expect(s.split.isOpen).toBe(false);
        s.input("\x1b[39;5u");
        expect(s.split.isOpen).toBe(true);
        s.sidebar.toggle(s.ctx as never);
        expect(s.sidebar.isOpen).toBe(true);
        expect(s.split.isOpen).toBe(false);
      } finally { await s.shutdown(); }
    });

    it(`${order}: no notebook falls back to Sidebar, dialogs retain input`, async () => {
      let key: string | undefined;
      const s = await setup(order, () => key);
      try {
        s.input("\x1b[39;5u");
        expect(s.sidebar.isOpen).toBe(true);
        s.input("\x1b[39;5u");
        expect(s.sidebar.isOpen).toBe(false);
        key = "fit.py";
        s.prompt("ui_prompt_start", { kind: "input" });
        s.input("\x1b[39;5u");
        expect(s.split.isOpen).toBe(false);
        expect(s.sidebar.isOpen).toBe(false);
        s.prompt("ui_prompt_end");
        s.pi.events.emit("herdr:blocked", { active: true });
        s.prompt("ui_prompt_start", { kind: "custom" });
        s.input("\x1b[39;5u");
        expect(s.split.isOpen).toBe(false);
        s.pi.events.emit("herdr:blocked", { active: false });
        s.prompt("ui_prompt_end");
        s.input("\x1b[39;5u");
        expect(s.split.isOpen).toBe(true);
      } finally { await s.shutdown(); }
    });
  }

  it("configured alternative shortcut has the same press/repeat/release semantics", async () => {
    const s = await setup("sidebar-first", () => "fit.py", ["ctrl+t"]);
    try {
      s.input("\x1b[116;5u");
      s.input("\x1b[116;5:2u");
      s.input("\x1b[116;5:3u");
      expect(s.split.isOpen).toBe(true);
    } finally { await s.shutdown(); }
  });
});
