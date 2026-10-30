import { describe, expect, test } from "vitest";
import { CellConsole } from "../src/core/console.js";

const item = (data: string, channel = "stdout") => ({ data, channel, mimetype: "text/plain" });
const texts = (console: CellConsole) => console.snapshot().map(line => line.text);

describe("terminal console display", () => {
  test("CR retains tails, split CRLF and CSI preserve parser state", async () => {
    const console = new CellConsole();
    await console.append(item("abc\rXY"));
    expect(texts(console)).toEqual(["XYc"]);
    await console.append(item("\r"));
    await console.append(item("\nsecond\x1b["));
    await console.append(item("2K\rthird"));
    expect(texts(console)).toEqual(["XYc", "third"]);
    console.dispose();
  });
  test("Rich cursor-up multi-row redraw, erase, wide text and styles", async () => {
    const console = new CellConsole();
    await console.append(item("chain 1\nchain 2\x1b[1A\r\x1b[2K\x1b[31m界é\x1b[0m\x1b[1B\r\x1b[2Kdone"));
    expect(texts(console)).toEqual(["界é", "done"]);
    expect(console.snapshot()[0]?.styles?.[0]?.width).toBe(2);
    console.dispose();
  });
  test("stream provenance and ordering use last completed update", async () => {
    const console = new CellConsole();
    await console.append(item("first"));
    await console.append(item("warning", "stderr"));
    await console.append(item("!"));
    expect(console.snapshot().map(line => [line.stream, line.text, line.severity])).toEqual([["stderr", "warning", "stderr"], ["stdout", "first!", "output"]]);
    console.dispose();
  });
  test("HTML and tracebacks remain separate ordered blocks with severity", async () => {
    const console = new CellConsole();
    await console.append(item("abc"));
    await console.append({ data: "<pre>Traceback (most recent call last):\nValueError</pre>", mimetype: "application/vnd.marimo+traceback", channel: "stderr" });
    await console.append({ data: "<p>html</p>", mimetype: "text/html" });
    expect(texts(console)).toEqual(["abc", "Traceback (most recent call last):", "ValueError", "html"]);
    expect(console.snapshot()[1]?.severity).toBe("error");
    console.dispose();
  });
  test("never forwards OSC52, title, DCS or raw escape bytes", async () => {
    const console = new CellConsole();
    await console.append(item("before\x1b]52;c;YQ==\x07\x1b]0;title\x07\x1bPpayload\x1b\\after"));
    expect(texts(console)).toEqual(["beforeafter"]);
    expect(JSON.stringify(console.snapshot())).not.toContain("\\u001b");
    console.dispose();
  });
  test("batch-equivalent input, bounded history and backpressure without dropped tail", async () => {
    const one = new CellConsole(); const split = new CellConsole();
    const input = `${"row\n".repeat(1500)}TAIL`;
    await one.append(item(input));
    await Promise.all(Array.from({ length: Math.ceil(input.length / 7) }, (_, index) => split.append(item(input.slice(index * 7, index * 7 + 7)))));
    expect(texts(one)).toEqual(texts(split));
    expect(texts(one).length).toBeLessThanOrEqual(1064);
    expect(texts(one).at(-1)).toBe("TAIL");
    one.dispose(); split.dispose();
  });
  test("clear and dispose invalidate queued writes and settle outstanding promises", async () => {
    let changes = 0;
    const console = new CellConsole(() => changes++);
    const pending = console.append(item("x".repeat(100_000)));
    console.clear(); await pending;
    expect(texts(console)).toEqual([]);
    await console.append(item("fresh"));
    expect(texts(console)).toEqual(["fresh"]);
    const next = console.append(item("old"));
    console.dispose(); const before = changes;
    await next; await console.settled(); await console.append(item("ignored"));
    expect(texts(console)).toEqual([]);
    expect(changes).toBe(before);
  });
});
