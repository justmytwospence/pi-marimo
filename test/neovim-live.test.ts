import { describe, it, expect } from "vitest";
import { NeovimSession, type NeovimExit } from "../src/core/neovim.ts";
import { NeovimGrid } from "../src/ui/neovim-grid.ts";

const live = process.env.PI_MARIMO_NVIM_TEST === "1" ? describe : describe.skip;
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise(r => setTimeout(r, 10)); }
}
live("real embedded Neovim", () => {
  it("executes native motions, operators, textobjects, registers, macros, block selection, undo/redo and Ex", async () => {
    const s = await NeovimSession.open({ text: "one two\nthree four", filetype: "python", onWrite: async t => ({ canonicalCode: t, requestId: "1" }) });
    async function keys(input: string, expected: string) { await s.input(input); await until(async () => await s.getText() === expected); expect(await s.getText()).toBe(expected); }
    try {
      await keys("wdiw", "one \nthree four");
      await keys("u", "one two\nthree four");
      await keys("\x12", "one \nthree four");
      await keys('gg0"ayyp', "one \none \nthree four");
      await keys("gg0qaI!\x1bqj@a", "!one \n!one \nthree four");
      await s.replaceText("abc\ndef");
      await keys("gg0\x16jIx\x1b", "xabc\nxdef");
      await keys(":%s/x/Z/g\r", "Zabc\nZdef");
      await s.replaceText('print("hello world")');
      await keys('gg0f"ci"界é\x1b', 'print("界é")');
      await s.setLineNumbers(true); await s.resize(24, 6);
      await s.replaceText("x".repeat(200)); await s.input("gg$");
      expect(await s.getText()).toBe("x".repeat(200));
      await s.input("\x1b[200~<literal>\n界\x1b[201~");
      await until(async () => (await s.getText()).includes("<literal>\n界"));
    } finally { s.dispose(); }
  });
  it("saves canonically in Lua without nested RPC; :wq saves before deliberate exit", async () => {
    let exit: NeovimExit | undefined; const writes: string[][] = []; const drafts: string[] = [];
    const s = await NeovimSession.open({ text: "old", filetype: "python", onDraft: t => drafts.push(t), onWrite: async (t, b) => {
      writes.push([t, b]); await new Promise(r => setTimeout(r, 20)); return { canonicalCode: t.trim(), requestId: "1" };
    }, onExit: e => { exit = e; } });
    try {
      await s.replaceText("new  "); await s.input(":w\r");
      await until(() => drafts.includes("new"));
      expect(await s.getText()).toBe("new");
      await s.input("u"); await until(async () => await s.getText() === "new  ");
      await s.input("\x12"); await until(async () => await s.getText() === "new");
      await s.input(":wq\r"); await until(() => !!exit);
      expect(writes).toEqual([["new  ", "old"], ["new", "new"]]);
      expect(exit?.deliberate).toBe(true); expect(exit?.text).toBe("new"); expect(drafts).toContain("new");
    } finally { s.dispose(); }
  });
  it("save failure keeps text and prevents :wq; alternate paths reject; host commands notify", async () => {
    let attempts = 0, closed = false; const actions: string[] = [];
    const s = await NeovimSession.open({ text: "base", filetype: "markdown", onWrite: async () => { attempts++; throw new Error("conflict"); }, onExit: () => { closed = true; }, onRun: () => { actions.push("run"); }, onRevert: () => { actions.push("revert"); }, onClose: () => { actions.push("close"); } });
    try {
      await s.replaceText("draft"); await s.input(":wq\r"); await until(() => attempts === 1); await s.input("\r");
      expect(await s.getText()).toBe("draft"); expect(closed).toBe(false);
      await s.input("\x1b:write alternate\r"); await new Promise(r => setTimeout(r, 30)); await s.input("\r"); expect(attempts).toBe(1);
      await s.input("\x1b:MarimoRun\r:MarimoRevert\r:MarimoClose\r"); await until(() => actions.length === 3);
      expect(actions).toEqual(["run", "revert", "close"]);
    } finally { s.dispose(); }
  });
  it("retains latest draft on fatal exit and discards only deliberate :q!", async () => {
    for (const fatal of [false, true]) {
      let exit: NeovimExit | undefined; let draft = "";
      const s = await NeovimSession.open({ text: "base", filetype: "python", onWrite: async t => ({ canonicalCode: t, requestId: "1" }), onDraft: t => { draft = t; }, onExit: e => { exit = e; } });
      try {
        await s.replaceText("retained界"); await until(() => draft === "retained界");
        if (fatal) await s.input(":cq\r"); else await s.input(":q!\r");
        await until(() => !!exit); expect(exit?.deliberate).toBe(!fatal); expect(exit?.text).toBe("retained界");
      } finally { s.dispose(); }
    }
  });
  it("retains an attached draft on a genuine fatal signal with VimLeavePre", async () => {
    let exit: NeovimExit | undefined, draft = "";
    const s = await NeovimSession.open({ text: "base", filetype: "python", onDraft: t => { draft = t; }, onWrite: async t => ({ canonicalCode: t, requestId: "1" }), onExit: e => { exit = e; } });
    try {
      await s.replaceText("fatal draft"); await until(() => draft === "fatal draft");
      await s.input(":lua vim.uv.kill(vim.fn.getpid(), 15)\r");
      await until(() => !!exit); expect(exit?.deliberate).toBe(false); expect(exit?.text).toBe("fatal draft");
      expect(exit?.notice?.dying).toBeGreaterThan(0);
    } finally { s.dispose(); }
  });
  it("produces native single-grid redraws with nowrap and resize", async () => {
    const grid = new NeovimGrid();
    const s = await NeovimSession.open({ text: "界".repeat(100), filetype: "python", width: 30, height: 8, onRedraw: e => { grid.reduce(e); }, onWrite: async t => ({ canonicalCode: t, requestId: "1" }) });
    try {
      await until(() => grid.snapshot().width === 30);
      await s.setLineNumbers(true);
      await until(() => grid.snapshot().cells[0]?.slice(0, 4).some(c => c.text === "1") ?? false);
      await s.resize(40, 10); await until(() => grid.snapshot().width === 40);
      expect(grid.snapshot().error).toBeUndefined();
      // The 200-column line occupies exactly one source row with nowrap.
      expect(grid.snapshot().cells[1]?.some(c => c.text === "界")).toBe(false);
      await s.input("$"); expect(await s.getText()).toBe("界".repeat(100));
    }
    finally { s.dispose(); }
  });
});
