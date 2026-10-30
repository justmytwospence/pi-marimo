import { spawn, type ChildProcess } from "node:child_process";
import { attach, type NeovimClient } from "neovim";
import { decodeKittyPrintable, isKeyRelease, parseKey } from "@earendil-works/pi-tui";
import { normalizeViewPreferences, type EditorOptions } from "../ui/settings.ts";

export interface BufferSnapshot { text: string; changedtick: number }
export interface SavedReconciliation extends BufferSnapshot { applied: boolean }
export interface WriteReceipt { canonicalCode: string; requestId: string }
export interface LeaveNotice { dying: number; exiting: number; modified: boolean; text: string }
export interface NeovimExit { deliberate: boolean; text: string; code: number | null; signal: string | null; notice?: LeaveNotice }
export interface NeovimOpenOptions {
  text: string; filetype: "python" | "markdown"; command?: string; options?: Partial<EditorOptions>;
  width?: number; height?: number; lineNumbers?: boolean;
  highlights?: Record<string, Record<string, string | number | boolean>>;
  onRedraw?: (events: unknown[][]) => void; onDraft?: (text: string, changedtick: number) => void;
  onWrite: (text: string, base: string, changedtick: number) => Promise<WriteReceipt>;
  onRun?: () => void | Promise<void>; onRevert?: () => void | Promise<void>; onClose?: () => void | Promise<void>;
  onExit?: (exit: NeovimExit) => void;
}
export const NEOVIM_REQUIRED = "Neovim 0.10+ is required for inline editing";
export function deliberateExit(notice: LeaveNotice | undefined, code: number | null, signal: string | null, failed = false): boolean {
  return !failed && notice?.dying === 0 && notice.exiting === 0 && code === 0 && signal === null;
}
/** Terminal bytes are decoded once; Vim, not the host, owns all editing semantics. */
export function neovimKey(data: string): string {
  const key = parseKey(data);
  if (!key) return data.replaceAll("<", "<LT>");
  const names: Record<string, string> = { escape: "Esc", enter: "CR", return: "CR", backspace: "BS", delete: "Del", insert: "Insert", tab: "Tab", space: "Space", pageup: "PageUp", pagedown: "PageDown", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End" };
  const printable = decodeKittyPrintable(data);
  if (printable !== undefined) return printable.replaceAll("<", "<LT>");
  let name = key;
  const modifiers: string[] = [];
  const aliases: Record<string, string> = { ctrl: "C", alt: "M", shift: "S", super: "D" };
  while (true) {
    const prefix = Object.keys(aliases).find(p => name.startsWith(`${p}+`));
    if (!prefix) break;
    modifiers.push(aliases[prefix]!); name = name.slice(prefix.length + 1);
  }
  const native = names[name.toLowerCase()] ?? name;
  if (!modifiers.length && !names[name.toLowerCase()] && !/^f\d+$/.test(name)) return name.replaceAll("<", "<LT>");
  return `<${[...modifiers, native].join("-")}>`;
}

const setup = `
local cfg = ...
local api = vim.api
local channel = cfg.channel
local b = api.nvim_get_current_buf()
api.nvim_buf_set_name(b, 'marimo-cell')
vim.bo[b].buftype = 'acwrite'
vim.bo[b].bufhidden = 'hide'
vim.bo[b].swapfile = false
vim.bo[b].modeline = false
vim.bo[b].filetype = cfg.filetype
vim.wo.wrap = false
vim.wo.number = cfg.numbers
vim.o.shada = ''
vim.o.modeline = false
vim.o.exrc = false
vim.o.more = false
vim.o.confirm = false
for k,v in pairs(cfg.options) do vim.opt[k] = v end
vim.cmd('filetype plugin off')
vim.cmd('syntax enable')
for group,attrs in pairs(cfg.highlights) do api.nvim_set_hl(0, group, attrs) end
local function text() return table.concat(api.nvim_buf_get_lines(b,0,-1,true), '\\n') end
local function lines(s) return vim.split(s, '\\n', {plain=true}) end
api.nvim_buf_set_lines(b,0,-1,true,lines(cfg.text))
vim.bo[b].modified = false
local base = cfg.text
local latest = cfg.text
local function snapshot()
  return {text=text(), changedtick=api.nvim_buf_get_changedtick(b)}
end
_G.marimo_snapshot = snapshot
local function reconcile(expected, canonical)
  local current = snapshot()
  local applied = current.text == expected.text and current.changedtick == expected.changedtick
  base = canonical
  if applied and current.text ~= canonical then
    api.nvim_buf_set_lines(b,0,-1,true,lines(canonical))
  end
  local result = snapshot()
  vim.bo[b].modified = result.text ~= base
  result.applied = applied
  return result
end
_G.marimo_reconcile = reconcile
_G.marimo_replace = function(s, newbase)
  api.nvim_buf_set_lines(b,0,-1,true,lines(s))
  if newbase then base = s end
  vim.bo[b].modified = text() ~= base
end
api.nvim_create_autocmd('BufWriteCmd', {buffer=b, callback=function(ev)
  if ev.match ~= api.nvim_buf_get_name(b) then error('Alternate-path writes are not supported') end
  local before = snapshot()
  local ok, receipt = pcall(vim.rpcrequest, channel, 'marimo_write', before.text, base, before.changedtick)
  if not ok then error(receipt) end
  if not receipt.ok then error(receipt.error) end
  local result = reconcile(before, receipt.canonicalCode)
  vim.rpcnotify(channel, 'marimo_draft', result.text, result.changedtick)
end})
for _,name in ipairs({'Run','Revert','Close'}) do
  api.nvim_create_user_command('Marimo'..name, function() vim.rpcnotify(channel, 'marimo_action', name) end, {})
end
api.nvim_create_autocmd('VimLeavePre', {callback=function()
  vim.rpcnotify(channel, 'marimo_leave', {dying=vim.v.dying, exiting=vim.v.exiting, modified=vim.bo[b].modified, text=latest})
end})
api.nvim_buf_attach(b, false, {on_lines=function()
  -- Fatal teardown can empty/unload buffers: it is not a user edit.
  if vim.v.dying == 0 then
    latest = text()
    vim.rpcnotify(channel, 'marimo_draft', latest, api.nvim_buf_get_changedtick(b))
  end
end})
`;

export class NeovimSession {
  private client!: NeovimClient;
  private proc!: ChildProcess;
  private latest: string;
  private notice?: LeaveNotice;
  private failed = false;
  private saving = false;
  private disposed = false;
  private pasteBuffer: string | undefined;
  private assertNotSaving(): void {
    if (this.saving) throw new Error("Neovim RPC is blocked by a synchronous write; use only the write response");
  }
  private constructor(private config: NeovimOpenOptions) { this.latest = config.text; }
  static async open(config: NeovimOpenOptions): Promise<NeovimSession> {
    const session = new NeovimSession(config);
    try { await session.start(); return session; }
    catch (error) { session.dispose(); throw new Error(`${NEOVIM_REQUIRED}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  private async start(): Promise<void> {
    const prefs = normalizeViewPreferences({ editor: { command: this.config.command ?? "nvim", options: this.config.options } });
    this.proc = spawn(prefs.editor.command, ["--embed", "--clean", "-n", "-i", "NONE"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr?.resume();
    const unavailable = new Promise<never>((_, reject) => this.proc.once("error", error => { this.failed = true; reject(error); }));
    // The official client's logger is inside options (not the top-level attach object).
    const noop = (() => undefined) as any;
    this.client = attach({ proc: this.proc, options: { logger: { info: noop, warn: noop, error: noop, debug: noop, level: "silent" } } });
    this.client.on("notification", (name: string, args: any[]) => {
      if (name === "redraw") this.config.onRedraw?.(args);
      if (name === "marimo_draft") { this.latest = args[0]; this.config.onDraft?.(this.latest, args[1]); }
      if (name === "marimo_leave") { this.notice = args[0]; this.latest = this.notice!.text; }
      if (name === "marimo_action") {
        const callback = args[0] === "Run" ? this.config.onRun : args[0] === "Revert" ? this.config.onRevert : this.config.onClose;
        void Promise.resolve().then(() => callback?.()).catch(() => { /* host owns action error display */ });
      }
    });
    this.client.on("request", (name: string, args: any[], response: { send: (value: unknown, isError?: boolean) => void }) => {
      if (name !== "marimo_write") { response.send("Unsupported request", true); return; }
      this.saving = true;
      // Never call the Neovim client here: Lua is blocked inside rpcrequest.
      void Promise.resolve().then(() => this.config.onWrite(args[0], args[1], args[2])).then(receipt => {
        this.saving = false; response.send({ ok: true, ...receipt });
      }, error => { this.saving = false; response.send({ ok: false, error: String(error instanceof Error ? error.message : error) }); });
    });
    this.client.on("error", () => { this.failed = true; });
    this.proc.once("close", (code, signal) => {
      if (!this.disposed) this.config.onExit?.({ deliberate: deliberateExit(this.notice, code, signal, this.failed || this.saving), text: this.latest, code, signal, notice: this.notice });
    });
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("startup timed out")), 5000); });
    try {
      await Promise.race([unavailable, timeout, (async () => {
        const [channel, info] = await this.client.apiInfo;
        if (info.version.major === 0 && info.version.minor < 10) throw new Error(NEOVIM_REQUIRED);
        await this.client.lua(setup, [{ channel, text: this.config.text, filetype: this.config.filetype, options: prefs.editor.options, numbers: this.config.lineNumbers ?? false, highlights: this.config.highlights ?? {} }] as any);
        await this.client.uiAttach(Math.max(12, this.config.width ?? 80), Math.max(4, this.config.height ?? 12), { rgb: true, ext_linegrid: true, ext_multigrid: false, ext_cmdline: false, ext_popupmenu: false, ext_tabline: false, ext_wildmenu: false, ext_messages: false });
      })()]);
    } finally { clearTimeout(timer!); }
  }
  async input(data: string): Promise<void> {
    this.assertNotSaving();
    if (isKeyRelease(data)) return;
    const start = "\x1b[200~", end = "\x1b[201~";
    if (this.pasteBuffer !== undefined || data.startsWith(start)) {
      this.pasteBuffer = (this.pasteBuffer ?? "") + (data.startsWith(start) ? data.slice(start.length) : data);
      const endAt = this.pasteBuffer.indexOf(end);
      if (endAt < 0) return;
      const text = this.pasteBuffer.slice(0, endAt), rest = this.pasteBuffer.slice(endAt + end.length);
      this.pasteBuffer = undefined;
      await this.paste(text);
      if (rest) await this.input(rest);
      return;
    }
    await this.client.input(neovimKey(data));
  }
  async paste(text: string): Promise<void> { this.assertNotSaving(); await this.client.request("nvim_paste", [text, false, -1]); }
  async resize(width: number, height: number): Promise<void> { this.assertNotSaving(); if (width >= 12 && height >= 4) await this.client.uiTryResize(width, height); }
  async setLineNumbers(value: boolean): Promise<void> { this.assertNotSaving(); await this.client.lua("vim.wo.number = ...", [value]); }
  async getText(): Promise<string> { this.assertNotSaving(); return (await this.snapshotBuffer()).text; }
  async snapshotBuffer(): Promise<BufferSnapshot> { this.assertNotSaving(); return await this.client.lua("return _G.marimo_snapshot()") as BufferSnapshot; }
  async reconcileSaved(expected: BufferSnapshot, canonicalText: string): Promise<SavedReconciliation> {
    this.assertNotSaving();
    return await this.client.lua("return _G.marimo_reconcile(...)", [expected, canonicalText] as any) as SavedReconciliation;
  }
  async replaceText(text: string, updateBase = false): Promise<void> { this.assertNotSaving(); await this.client.lua("_G.marimo_replace(...)", [text, updateBase]); }
  async focus(focused: boolean): Promise<void> { this.assertNotSaving(); await this.client.command(`doautocmd <nomodeline> ${focused ? "FocusGained" : "FocusLost"}`); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.proc?.kill(); }
}
