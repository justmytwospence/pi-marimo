import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { CdpClient } from "./cdp.js";
import { sharedChrome } from "./chrome.js";
import type { Geometry } from "./live.js";

export type MermaidAppearance = "light" | "dark";
export type MermaidState = { status: "rendering" } | { status: "ready"; png: string } | { status: "failed"; reason: string };
export const mermaidBundlePath = (): string => createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
let bundle: Promise<string> | undefined;
const localBundle = () => bundle ??= readFile(mermaidBundlePath(), "utf8");
interface Entry { state: MermaidState; callbacks: Set<() => void>; bytes: number }

/** Lazy, serial, isolated Mermaid renders. Source is data, never executable page/HTML input. */
export class MermaidRenderer {
  private entries = new Map<string, Entry>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private cancel = new Set<() => void>();
  constructor(private readonly host: { connection(): Promise<CdpClient> } = sharedChrome(), private readonly deadlineMs = 10_000) {}

  request(source: string, geometry: Geometry, appearance: MermaidAppearance, onReady: () => void): MermaidState {
    if (this.disposed) return { status: "failed", reason: "renderer disposed" };
    if (Buffer.byteLength(source) > 256 * 1024) return { status: "failed", reason: "source exceeds 256 KiB render limit" };
    const key = JSON.stringify([source, geometry, appearance]);
    const known = this.entries.get(key);
    if (known) {
      this.entries.delete(key); this.entries.set(key, known);
      if (known.state.status === "rendering") known.callbacks.add(onReady);
      return known.state;
    }
    const entry: Entry = { state: { status: "rendering" }, callbacks: new Set([onReady]), bytes: 0 };
    this.entries.set(key, entry);
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      try {
        const png = await this.render(source, geometry, appearance);
        entry.state = { status: "ready", png }; entry.bytes = Buffer.byteLength(png);
      } catch (e) { entry.state = { status: "failed", reason: e instanceof Error ? e.message : "could not render" }; }
      if (this.disposed) return;
      this.trim();
      for (const callback of entry.callbacks) { try { callback(); } catch { /* consumer redraw */ } }
      entry.callbacks.clear();
    });
    return entry.state;
  }

  private trim(): void {
    let bytes = [...this.entries.values()].reduce((sum, e) => sum + e.bytes, 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 32 && bytes <= 32 * 1024 * 1024) break;
      if (entry.state.status === "rendering") continue;
      bytes -= entry.bytes; this.entries.delete(key);
    }
  }

  private async render(source: string, g: Geometry, appearance: MermaidAppearance): Promise<string> {
    let conn: CdpClient | undefined, context: string | undefined, target: string | undefined;
    let stopped = false;
    const offs: Array<() => void> = [];
    const cleanup = () => {
      stopped = true;
      for (const off of offs.splice(0)) off();
      if (target && conn) void conn.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
      if (context && conn) void conn.send("Target.disposeBrowserContext", { browserContextId: context }).catch(() => undefined);
    };
    let abort!: (e: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { abort = reject; });
    const cancel = () => { cleanup(); abort(new Error("renderer disposed")); };
    this.cancel.add(cancel);
    const timer = setTimeout(() => { cleanup(); abort(new Error("render timed out")); }, this.deadlineMs);
    const check = () => { if (stopped) { cleanup(); throw new Error("render cancelled"); } };
    const work = async () => {
      conn = await this.host.connection(); check();
      const created = await conn.send("Target.createBrowserContext", { disposeOnDetach: true });
      context = created.browserContextId as string; check();
      await conn.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: context }); check();
      const page = await conn.send("Target.createTarget", { url: "about:blank", browserContextId: context });
      target = page.targetId as string; check();
      const attached = await conn.send("Target.attachToTarget", { targetId: target, flatten: true }); check();
      const session = attached.sessionId as string;
      const cmd = async (method: string, params: Record<string, unknown> = {}) => { check(); const result = await conn!.send(method, params, session); check(); return result; };
      const fail = (message: string) => { if (stopped) return; cleanup(); abort(new Error(message)); };
      offs.push(conn.on("Fetch.requestPaused", session, (p) => { void conn!.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, session).catch(() => undefined); }));
      offs.push(conn.on("Page.frameRequestedNavigation", session, () => fail("navigation blocked")));
      offs.push(conn.on("Target.attachedToTarget", session, (p) => { void conn!.send("Target.closeTarget", { targetId: p.targetInfo.targetId }).catch(() => undefined); }));
      offs.push(conn.on("Inspector.targetCrashed", session, () => fail("browser target crashed")));
      void conn.closed.then(() => fail("browser closed"));
      await cmd("Page.enable");
      await cmd("Network.enable");
      await cmd("Network.setBlockedURLs", { urls: ["*"] });
      await cmd("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await cmd("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      const width = Math.max(1, Math.round(g.cols * g.cellW)), height = Math.max(1, Math.round(g.rows * g.cellH));
      await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      const evaluate = async (expression: string) => {
        const result = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error("invalid diagram or unsupported syntax");
        return result;
      };
      await evaluate(`document.head.innerHTML = '<meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; style-src \\'unsafe-inline\\'; img-src data:; font-src data:; base-uri \\'none\\'; form-action \\'none\\'">'; document.body.style.cssText='margin:0;overflow:hidden'; window.open=()=>null;`);
      await evaluate(await localBundle());
      await evaluate(`(async () => {
        mermaid.initialize({startOnLoad:false,securityLevel:'strict',secure:[...mermaid.mermaidAPI.defaultConfig.secure,'htmlLabels','flowchart','theme'],maxTextSize:262144,theme:${JSON.stringify(appearance === "dark" ? "dark" : "default")},htmlLabels:false,flowchart:{htmlLabels:false}});
        const rendered = await mermaid.render('diagram', ${JSON.stringify(source)});
        document.body.innerHTML = rendered.svg;
        await document.fonts.ready;
        const svg = document.querySelector('svg');
        if (!svg) throw new Error('no diagram');
        const bounds = svg.getBBox();
        if (!svg.hasAttribute('viewBox')) svg.setAttribute('viewBox', [bounds.x, bounds.y, Math.max(1,bounds.width), Math.max(1,bounds.height)].join(' '));
        svg.style.cssText = 'display:block;width:${width}px;height:${height}px;max-width:none';
        svg.setAttribute('preserveAspectRatio','xMidYMid meet');
        document.body.style.background = ${JSON.stringify(appearance === "dark" ? "#1e1e1e" : "#ffffff")};
      })()`);
      const shot = await cmd("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } });
      if (typeof shot.data !== "string" || !shot.data) throw new Error("empty diagram image");
      return shot.data;
    };
    try { return await Promise.race([work(), cancelled]); }
    finally { clearTimeout(timer); this.cancel.delete(cancel); cleanup(); }
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of this.cancel) cancel();
    this.cancel.clear(); this.entries.clear();
  }
}
