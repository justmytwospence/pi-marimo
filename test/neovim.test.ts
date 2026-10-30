import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { deliberateExit, neovimKey, NeovimSession, NEOVIM_REQUIRED } from "../src/core/neovim.ts";
describe("Neovim protocol boundaries", () => {
  it("normalizes terminal keys while preserving native Vim keys and literals", () => {
    expect(neovimKey("\x1b")).toBe("<Esc>"); expect(neovimKey("\x12")).toBe("<C-r>");
    expect(neovimKey("\r")).toBe("<CR>"); expect(neovimKey("\x1b[A")).toBe("<Up>");
    for (const key of ["?", "#", "q", "!", "\\", "H", "L", "界"]) expect(neovimKey(key)).toBe(key);
    expect(neovimKey("<")).toBe("<LT>"); expect(neovimKey("+")).toBe("+");
    expect(neovimKey("\x1b[5~")).toBe("<PageUp>");
    expect(neovimKey("\x1b[97u")).toBe("a");
    expect(neovimKey("\x1b[97;5u")).toBe("<C-a>");
  });
  it("requires affirmative normal exit plus process status, never VimLeavePre alone", () => {
    const notice = { dying: 0, exiting: 0, modified: true, text: "draft" };
    expect(deliberateExit(notice, 0, null)).toBe(true);
    expect(deliberateExit(undefined, 0, null)).toBe(false);
    expect(deliberateExit({ ...notice, dying: 1 }, 0, null)).toBe(false);
    expect(deliberateExit({ ...notice, exiting: 2 }, 0, null)).toBe(false);
    expect(deliberateExit(notice, 1, null)).toBe(false);
    expect(deliberateExit(notice, 0, "SIGTERM")).toBe(false);
    expect(deliberateExit(notice, 0, null, true)).toBe(false);
  });
  it("reports unavailable executable without shell evaluation", async () => {
    await expect(NeovimSession.open({ command: "missing-neovim; echo unsafe", text: "draft", filetype: "python", onWrite: vi.fn() })).rejects.toThrow(NEOVIM_REQUIRED);
  });
  it("uses official attach with silent logger, isolated pipe arguments, version check and idempotent disposal", async () => {
    const proc = Object.assign(new EventEmitter(), { kill: vi.fn(), stderr: { resume: vi.fn() } });
    const client = Object.assign(new EventEmitter(), {
      apiInfo: Promise.resolve([4, { version: { major: 0, minor: 10 } }]),
      lua: vi.fn().mockResolvedValue(undefined), uiAttach: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockResolvedValue(true), input: vi.fn().mockResolvedValue(1),
    });
    const spawn = vi.fn(() => proc), attach = vi.fn(() => client);
    vi.resetModules(); vi.doMock("node:child_process", () => ({ spawn })); vi.doMock("neovim", () => ({ attach }));
    try {
      const { NeovimSession: FakeSession } = await import("../src/core/neovim.ts");
      const drafts: string[] = [], exits: any[] = [];
      const s = await FakeSession.open({ text: "base", filetype: "python", onDraft: t => drafts.push(t), onExit: e => exits.push(e), onWrite: async t => {
        await expect(s.getText()).rejects.toThrow("synchronous write"); return { canonicalCode: t, requestId: "receipt" };
      } });
      expect(spawn).toHaveBeenCalledWith("nvim", ["--embed", "--clean", "-n", "-i", "NONE"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      expect(attach.mock.calls[0]?.[0].options.logger.level).toBe("silent");
      expect(client.uiAttach).toHaveBeenCalledWith(80, 12, expect.objectContaining({ ext_linegrid: true, ext_multigrid: false, ext_cmdline: false, ext_popupmenu: false }));
      await s.input("\x1b[200~literal <"); await s.input("界\x1b[201~");
      expect(client.request).toHaveBeenCalledWith("nvim_paste", ["literal <界", false, -1]);
      const send = vi.fn(); client.emit("request", "marimo_write", ["draft", "base"], { send });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ ok: true, canonicalCode: "draft", requestId: "receipt" }));
      client.emit("notification", "marimo_draft", ["latest"]); proc.emit("close", 0, null);
      expect(drafts).toEqual(["latest"]); expect(exits[0]).toMatchObject({ deliberate: false, text: "latest" });
      s.dispose(); s.dispose(); expect(proc.kill).toHaveBeenCalledTimes(1);
      const failedExits: any[] = [];
      const failed = await FakeSession.open({ text: "draft", filetype: "python", onExit: e => failedExits.push(e), onWrite: vi.fn() });
      client.emit("notification", "marimo_leave", [{ dying: 0, exiting: 0, modified: true, text: "draft" }]);
      client.emit("error", new Error("transport failed")); proc.emit("close", 0, null);
      expect(failedExits[0]).toMatchObject({ deliberate: false, text: "draft" }); failed.dispose();
      client.apiInfo = Promise.resolve([4, { version: { major: 0, minor: 9 } }]);
      await expect(FakeSession.open({ text: "base", filetype: "python", onWrite: vi.fn() })).rejects.toThrow(NEOVIM_REQUIRED);
    } finally { vi.doUnmock("node:child_process"); vi.doUnmock("neovim"); vi.resetModules(); }
  });
});
