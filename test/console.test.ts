import { describe, expect, test } from "vitest";
import { consoleLineText } from "../src/ui/outputs.js";
import { CellConsole } from "../src/core/console.js";

const item = (data: string, channel = "stdout") => ({ data, channel, mimetype: "text/plain" });
const texts = (console: CellConsole) => console.snapshot().map(line => line.text);

describe("terminal console display", () => {
  test("UI reconstructs trusted styles in terminal columns, including wide/combining/astral tails", async () => {
    const producer = new CellConsole();
    await producer.append(item("é\x1b[7m界é😀Z\x1b[27;38;2;12;34;56mRGB\x1b[39;48;5;123mBG\x1b[0mTAIL"));
    const line = producer.snapshot()[0]!;
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as any;
    const rendered = consoleLineText(line, theme);
    expect(rendered).toContain("\x1b[7m界\x1b[27m");
    expect(rendered).toContain("38;2;12;34;56");
    expect(rendered).toContain("48;5;123");
    expect(rendered).not.toContain("5;-1");
    const replay = new CellConsole();
    await replay.append(item(rendered));
    expect(texts(replay)).toEqual(texts(producer));
    expect(replay.snapshot()[0]?.styles).toEqual(line.styles);
    producer.dispose(); replay.dispose();
  });
  test("diagnostic fallback preserves explicit producer colors and never revives unsafe bytes", async () => {
    const producer = new CellConsole();
    await producer.append(item("default \x1b[38;5;42mexplicit\x1b[0m\x1b]52;c;YQ==\x07 tail", "stderr"));
    const theme = { fg: (_: string, text: string) => `\x1b[31m${text}\x1b[39m`, bold: (text: string) => text } as any;
    const rendered = consoleLineText(producer.snapshot()[0]!, theme);
    expect(rendered).toContain("\x1b[31mdefault ");
    expect(rendered).toContain("\x1b[38;5;42m\x1b[49me");
    expect(rendered).not.toMatch(/52;|YQ==|\x07/u);
    producer.dispose();
  });
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
  test("snapshots inverse and default colors without treating defaults as palette indexes", async () => {
    const console = new CellConsole();
    await console.append(item("\x1b[7mA\x1b[31mB\x1b[39;44mC\x1b[49mD\x1b[27mE"));
    expect(texts(console)).toEqual(["ABCDE"]);
    expect(console.snapshot()[0]?.styles).toMatchInlineSnapshot(`
      [
        {
          "bg": -1,
          "bgDefault": true,
          "bgMode": 0,
          "bold": false,
          "column": 0,
          "fg": -1,
          "fgDefault": true,
          "fgMode": 0,
          "inverse": true,
          "italic": false,
          "underline": false,
          "width": 1,
        },
        {
          "bg": -1,
          "bgDefault": true,
          "bgMode": 0,
          "bold": false,
          "column": 1,
          "fg": 1,
          "fgDefault": false,
          "fgMode": 16777216,
          "inverse": true,
          "italic": false,
          "underline": false,
          "width": 1,
        },
        {
          "bg": 4,
          "bgDefault": false,
          "bgMode": 16777216,
          "bold": false,
          "column": 2,
          "fg": -1,
          "fgDefault": true,
          "fgMode": 0,
          "inverse": true,
          "italic": false,
          "underline": false,
          "width": 1,
        },
        {
          "bg": -1,
          "bgDefault": true,
          "bgMode": 0,
          "bold": false,
          "column": 3,
          "fg": -1,
          "fgDefault": true,
          "fgMode": 0,
          "inverse": true,
          "italic": false,
          "underline": false,
          "width": 1,
        },
      ]
    `);
    console.dispose();
  });
  test("snapshots validated palette, RGB and text attributes, including their reset", async () => {
    const console = new CellConsole();
    await console.append(item("\x1b[1;3;4;38;5;123;48;2;12;34;56mA\x1b[22;23;24;39;49mB\x1b[38;2;240;128;16;48;5;231mC\x1b[0mD"));
    expect(texts(console)).toEqual(["ABCD"]);
    expect(console.snapshot()[0]?.styles).toMatchInlineSnapshot(`
      [
        {
          "bg": 795192,
          "bgDefault": false,
          "bgMode": 50331648,
          "bold": true,
          "column": 0,
          "fg": 123,
          "fgDefault": false,
          "fgMode": 33554432,
          "inverse": false,
          "italic": true,
          "underline": true,
          "width": 1,
        },
        {
          "bg": 231,
          "bgDefault": false,
          "bgMode": 33554432,
          "bold": false,
          "column": 2,
          "fg": 15761424,
          "fgDefault": false,
          "fgMode": 50331648,
          "inverse": false,
          "italic": false,
          "underline": false,
          "width": 1,
        },
      ]
    `);
    console.dispose();
  });
  test("style spans use terminal columns across wide, combining and astral glyphs", async () => {
    const console = new CellConsole();
    await console.append(item("é\x1b[7m界é😀Z\x1b[0m!"));
    expect(texts(console)).toEqual(["é界é😀Z!"]);
    expect(console.snapshot()[0]?.styles?.map(({ column, width, inverse, fgDefault, bgDefault }) => ({ column, width, inverse, fgDefault, bgDefault }))).toEqual([
      { column: 1, width: 2, inverse: true, fgDefault: true, bgDefault: true },
      { column: 3, width: 1, inverse: true, fgDefault: true, bgDefault: true },
      // xterm's default Unicode provider gives this astral emoji one column.
      { column: 4, width: 1, inverse: true, fgDefault: true, bgDefault: true },
      { column: 5, width: 1, inverse: true, fgDefault: true, bgDefault: true },
    ]);
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
  test("split unsafe OSC and hyperlink controls never enter styled snapshots", async () => {
    const console = new CellConsole();
    await console.append(item("\x1b]52;c;"));
    await console.append(item("YQ==\x1b"));
    await console.append(item("\\\x1b]8;;https://unsafe.example/\x07\x1b[7mlink\x1b[0m\x1b]8;;\x1b\\"));
    expect(texts(console)).toEqual(["link"]);
    expect(console.snapshot()[0]?.styles).toHaveLength(4);
    expect(console.snapshot()[0]?.styles?.every(style => style.inverse && style.fgDefault && style.bgDefault)).toBe(true);
    expect(JSON.stringify(console.snapshot())).not.toMatch(/unsafe|YQ==|\\u001b/u);
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
