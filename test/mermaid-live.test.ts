import { afterAll, describe, expect, test } from "vitest";
import { getPngDimensions } from "@earendil-works/pi-tui";
import { sharedChrome } from "../src/core/chrome.js";
import { MermaidRenderer, type MermaidState } from "../src/core/mermaid.js";

const fixtures: Record<string, string> = {
  flowchart: 'flowchart TD\n A[Start] --> B{Ready?}\n B -->|yes| C[Done]',
  sequence: 'sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Hi',
  class: 'classDiagram\n Animal <|-- Duck\n Animal : +int age\n Duck : +swim()',
  ER: 'erDiagram\n CUSTOMER ||--o{ ORDER : places\n CUSTOMER {\n int id\n string name\n }',
  state: 'stateDiagram-v2\n [*] --> Still\n Still --> Moving\n Moving --> [*]',
  gantt: 'gantt\n title Work\n dateFormat YYYY-MM-DD\n section Tasks\n Build :a1, 2026-01-01, 2d\n Test :after a1, 1d',
  mindmap: 'mindmap\n root((Ideas))\n  One\n  Two',
};

describe.skipIf(process.env.PI_MARIMO_RENDER_TEST !== "1")("sandboxed local Mermaid browser", () => {
  const host = sharedChrome();
  const renderer = new MermaidRenderer(host);
  afterAll(() => { renderer.dispose(); host.stop(); });
  const render = (source: string): Promise<MermaidState> => new Promise(resolve => {
    const done = () => resolve(renderer.request(source, { cols: 80, rows: 24, cellW: 8, cellH: 16 }, "light", () => {}));
    const state = renderer.request(source, { cols: 80, rows: 24, cellW: 8, cellH: 16 }, "light", done);
    if (state.status !== "rendering") resolve(state);
  });
  // Resolve browser assets before the renderer's deliberately strict per-diagram deadline.
  test("dedicated sandboxed browser starts", async () => { await host.connection(); }, 360_000);
  for (const [name, source] of Object.entries(fixtures)) test(name, async () => {
    const state = await render(source);
    expect(state.status, JSON.stringify(state)).toBe("ready");
    if (state.status === "ready") expect(getPngDimensions(state.png)).toEqual({ widthPx: 640, heightPx: 384 });
  }, 20_000);
  test("invalid and unknown syntax fail cleanly", async () => {
    expect((await render("this is not a diagram !!!")).status).toBe("failed");
    expect((await render("flowchart TD\n A --> [")).status).toBe("failed");
  }, 25_000);
  test("malicious labels and external loads cannot reach the network", async () => {
    const conn = await host.connection();
    const observed: string[] = [];
    // Observe all target sessions created by this renderer without touching any user page.
    const original = conn.send.bind(conn);
    const offs: Array<() => void> = [];
    conn.send = async (method, params, session) => {
      const result = await original(method, params, session);
      if (method === "Target.attachToTarget") {
        offs.push(conn.on("Network.responseReceived", result.sessionId, p => { observed.push(String(p.response.url)); }));
      }
      return result;
    };
    try {
      const sources = [
        'flowchart TD\n A["<img src=\'https://example.invalid/steal\'>"] --> B',
        'flowchart TD\n A["</script><script>fetch(\'https://example.invalid/pwn\')</script>"] --> B',
        'flowchart TD\n A --> B\n click A "https://example.invalid/nav"',
        'sequenceDiagram\n participant A as &quot;; window.open(\'https://example.invalid\'); //\n A->>B: hi',
        'flowchart TD\n A@{ img: "https://example.invalid/image.png", label: "External" }',
      ];
      for (const source of sources) {
        const state = await render(source);
        expect(["ready", "failed"]).toContain(state.status);
        if (state.status === "failed") expect(state.reason).not.toBe("render timed out");
      }
      expect(observed.filter(url => /^https?:/u.test(url))).toEqual([]);
    } finally { conn.send = original; for (const off of offs) off(); }
  }, 60_000);
});
