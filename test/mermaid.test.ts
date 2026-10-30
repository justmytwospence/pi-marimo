import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { CdpClient } from "../src/core/cdp.js";
import { componentProps, outputElements, parseOutputFragment, textContent } from "../src/core/html.js";
import { MermaidRenderer, mermaidBundlePath, type MermaidState } from "../src/core/mermaid.js";
import { mermaidRows } from "../src/ui/outputs.js";

vi.mock("@earendil-works/pi-tui", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-tui")>(),
  getCapabilities: () => ({ images: "kitty" }),
  Image: class { render() { return ["\x1b_Gfake", ""]; } },
}));

const geometry = { cols: 80, rows: 14, cellW: 8, cellH: 16 };
function mock() {
  const handlers = new Map<string, (p: Record<string, any>) => void>();
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>, _session?: string): Promise<Record<string, any>> => {
    if (method === "Target.createBrowserContext") return { browserContextId: "context" };
    if (method === "Target.createTarget") return { targetId: "page" };
    if (method === "Target.attachToTarget") return { sessionId: "session" };
    if (method === "Page.captureScreenshot") return { data: "aGVsbG8=" };
    return {};
  });
  const conn: CdpClient = { send, on: (method, _session, handler) => { handlers.set(method, handler); return () => { handlers.delete(method); }; }, close() {}, closed: new Promise(() => {}) };
  return { send, handlers, host: { connection: async () => conn } };
}
function ready(renderer: MermaidRenderer, source = "graph TD; A-->B", g = geometry, appearance: "light" | "dark" = "light"): Promise<MermaidState> {
  return new Promise(resolve => {
    const done = () => resolve(renderer.request(source, g, appearance, () => {}));
    const state = renderer.request(source, g, appearance, done);
    if (state.status !== "rendering") resolve(state);
  });
}

describe("inert fragments", () => {
  test("decodes entities once, then JSON; ignores active subtrees", () => {
    const nodes = [...outputElements(parseOutputFragment('<marimo-mermaid data-diagram="&quot;A &amp;amp; B&quot;"></marimo-mermaid><script>bad()</script><style>bad</style><pre><code>&lt;x&gt;\t\n</code></pre>'))];
    expect(componentProps(nodes[0]!).diagram).toBe("A &amp; B");
    expect(nodes.some(n => n.tagName === "script")).toBe(false);
    expect(textContent(parseOutputFragment('<script>bad</script><style>bad</style><p>safe</p>'))).toBe("safe");
    expect(textContent(nodes.find(n => n.tagName === "pre")!)).toBe("<x>\t\n");
    expect(componentProps(parseOutputFragment("x"))).toEqual({});
  });
});

describe("Mermaid renderer", () => {
  test("installed full local browser bundle exists", () => {
    expect(mermaidBundlePath()).toContain("mermaid.min.js");
    expect(readFileSync(mermaidBundlePath(), "utf8").length).toBeGreaterThan(500_000);
  });
  test("serializes source safely, loads local bytes and closes isolated targets", async () => {
    const m = mock(); const renderer = new MermaidRenderer(m.host);
    const source = 'graph TD; A["</script>\\\"; window.pwned=true; //"]-->B';
    expect((await ready(renderer, source)).status).toBe("ready");
    const calls = m.send.mock.calls;
    const render = calls.find(([method, p]) => method === "Runtime.evaluate" && String(p?.expression).includes("const rendered"));
    expect(render?.[1]?.expression).toContain(JSON.stringify(source));
    expect(render?.[1]?.expression).toContain("securityLevel:'strict'");
    expect(render?.[1]?.expression).toContain("htmlLabels:false");
    expect(render?.[1]?.expression).not.toContain("bindFunctions");
    expect(calls.some(([method, p]) => method === "Runtime.evaluate" && String(p?.expression).length > 500_000)).toBe(true);
    expect(calls).toContainEqual(["Browser.setDownloadBehavior", { behavior: "deny", browserContextId: "context" }]);
    expect(calls.some(([method]) => method === "Target.closeTarget")).toBe(true);
    expect(calls.some(([method]) => method === "Target.disposeBrowserContext")).toBe(true);
    expect(m.handlers.size).toBe(0);
    renderer.dispose();
  });
  test("network, navigation and popups are blocked before source execution", async () => {
    const m = mock(); let release!: () => void;
    const original = m.send.getMockImplementation()!;
    m.send.mockImplementation(async (method, p, session) => {
      if (method === "Runtime.evaluate" && String(p?.expression).includes("const rendered")) await new Promise<void>(r => { release = r; });
      return original(method, p, session);
    });
    const renderer = new MermaidRenderer(m.host);
    const result = ready(renderer);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(m.send.mock.calls.some(([method, p]) => method === "Network.setBlockedURLs" && JSON.stringify(p).includes("*"))).toBe(true);
    m.handlers.get("Fetch.requestPaused")!({ requestId: "external" });
    expect(m.send.mock.calls).toContainEqual(["Fetch.failRequest", { requestId: "external", errorReason: "BlockedByClient" }, "session"]);
    m.handlers.get("Target.attachedToTarget")!({ targetInfo: { targetId: "popup" } });
    expect(m.send.mock.calls).toContainEqual(["Target.closeTarget", { targetId: "popup" }]);
    m.handlers.get("Page.frameRequestedNavigation")!({});
    expect(await result).toMatchObject({ status: "failed", reason: "navigation blocked" });
    release(); renderer.dispose();
  });
  test("deduplicates, caches multiple diagrams and regenerates on geometry/theme changes", async () => {
    const m = mock(); const renderer = new MermaidRenderer(m.host);
    await Promise.all([ready(renderer), ready(renderer)]);
    await ready(renderer); await ready(renderer, "graph TD; C-->D");
    await ready(renderer, undefined, { ...geometry, cols: 40 });
    await ready(renderer, undefined, geometry, "dark");
    expect(m.send.mock.calls.filter(([method]) => method === "Target.createTarget")).toHaveLength(4);
    for (let i = 0; i < 34; i++) await ready(renderer, `graph TD; A-->B${i}`);
    await ready(renderer);
    expect(m.send.mock.calls.filter(([method]) => method === "Target.createTarget")).toHaveLength(39);
    renderer.dispose();
  });
  test("32 MiB image budget evicts before the entry count limit", async () => {
    const m = mock(); const original = m.send.getMockImplementation()!;
    m.send.mockImplementation(async (method, p, session) => method === "Page.captureScreenshot" ? { data: "A".repeat(17 * 1024 * 1024) } : original(method, p, session));
    const renderer = new MermaidRenderer(m.host);
    await ready(renderer, "a"); await ready(renderer, "b"); await ready(renderer, "a");
    expect(m.send.mock.calls.filter(([method]) => method === "Target.createTarget")).toHaveLength(3);
    renderer.dispose();
  });
  test("source fallback is complete for failure/rendering and image metadata uses the existing path", () => {
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
    const m = mock(); const renderer = new MermaidRenderer(m.host);
    const source = `graph TD\n${"A-->B\n".repeat(10_000)}LAST`;
    const request = vi.spyOn(renderer, "request");
    request.mockReturnValue({ status: "failed", reason: "browser missing" });
    const options = { blockId: "fence-2", renderer, width: 80, showSource: false };
    const rows = mermaidRows(source, theme, options);
    expect(rows[0]!.text).toContain("Mermaid: browser missing");
    expect(rows.at(-1)!.text).toBe("LAST");
    expect(rows.filter(row => row.sourceLine !== undefined)).toHaveLength(10_002);
    request.mockReturnValue({ status: "rendering" });
    expect(mermaidRows(source, theme, options).at(-1)!.text).toBe("LAST");
    request.mockReturnValue({ status: "ready", png: "image" });
    const image = mermaidRows(source, theme, options);
    expect(image[0]).toMatchObject({ blockId: "fence-2", image: { index: 0, height: 2 } });
    expect(image[1]).toMatchObject({ image: { index: 1, height: 2 } });
    expect(mermaidRows(source, theme, { ...options, showSource: true }).at(-1)!.text).toBe("LAST");
    renderer.dispose();
  });
  test("oversize input is rejected without starting Chrome", () => {
    const m = mock(); const renderer = new MermaidRenderer(m.host);
    expect(renderer.request("é".repeat(131073), geometry, "light", () => {})).toMatchObject({ status: "failed", reason: expect.stringContaining("256 KiB") });
    expect(m.send).not.toHaveBeenCalled(); renderer.dispose();
  });
  test("deadline closes targets and allows the next serialized job", async () => {
    const m = mock(); const original = m.send.getMockImplementation()!;
    m.send.mockImplementation(async (method, p, session) => method === "Runtime.evaluate" ? new Promise(() => {}) : original(method, p, session));
    const renderer = new MermaidRenderer(m.host, 30);
    expect(await ready(renderer)).toMatchObject({ status: "failed", reason: "render timed out" });
    expect(m.send.mock.calls.some(([method]) => method === "Target.closeTarget")).toBe(true);
    renderer.dispose();
  });
  test("syntax errors close targets and leave readable failure states", async () => {
    const m = mock(); const original = m.send.getMockImplementation()!;
    m.send.mockImplementation(async (method, p, session) => method === "Runtime.evaluate" ? { exceptionDetails: { text: "syntax error" } } : original(method, p, session));
    const renderer = new MermaidRenderer(m.host);
    expect(await ready(renderer)).toMatchObject({ status: "failed", reason: "invalid diagram or unsupported syntax" });
    expect(m.handlers.size).toBe(0);
    expect(m.send.mock.calls.some(([method]) => method === "Target.closeTarget")).toBe(true);
    renderer.dispose();
  });
  test("a target crash invalidates work; late context creation after disposal is cleaned up", async () => {
    const m = mock(); let release!: () => void;
    const original = m.send.getMockImplementation()!;
    m.send.mockImplementation(async (method, p, session) => {
      if (method === "Runtime.evaluate") await new Promise<void>(r => { release = r; });
      return original(method, p, session);
    });
    const renderer = new MermaidRenderer(m.host); const result = ready(renderer);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    m.handlers.get("Inspector.targetCrashed")!({});
    expect(await result).toMatchObject({ status: "failed", reason: "browser target crashed" });
    release(); renderer.dispose();
    const late = mock(); let resolve!: (v: Record<string, any>) => void;
    late.send.mockImplementation(async method => method === "Target.createBrowserContext" ? new Promise(r => { resolve = r; }) : {});
    const disposed = new MermaidRenderer(late.host);
    disposed.request("late", geometry, "light", () => {});
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    disposed.dispose(); resolve({ browserContextId: "late-context" });
    await vi.waitFor(() => expect(late.send.mock.calls).toContainEqual(["Target.disposeBrowserContext", { browserContextId: "late-context" }]));
  });
  test("dispose cancels active and pending renders without notifying stale consumers", async () => {
    const m = mock(); const original = m.send.getMockImplementation()!;
    m.send.mockImplementation(async (method, p, session) => method === "Runtime.evaluate" ? new Promise(() => {}) : original(method, p, session));
    const renderer = new MermaidRenderer(m.host); const callback = vi.fn();
    renderer.request("one", geometry, "light", callback); renderer.request("two", geometry, "light", callback);
    await vi.waitFor(() => expect(m.send.mock.calls.some(([method]) => method === "Runtime.evaluate")).toBe(true));
    renderer.dispose(); await new Promise(r => setTimeout(r, 10));
    expect(callback).not.toHaveBeenCalled();
    expect(m.send.mock.calls.filter(([method]) => method === "Target.createTarget")).toHaveLength(1);
    expect(renderer.request("one", geometry, "light", callback)).toMatchObject({ status: "failed", reason: "renderer disposed" });
  });
});
