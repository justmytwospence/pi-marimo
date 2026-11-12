import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { type InboxMessage, type InboxTarget, PairInbox } from "../src/core/pair-inbox.js";

const fixture = readFileSync(new URL("./fixtures/pair-inbox.sse", import.meta.url), "utf8");
const host = { url: "http://127.0.0.1:2800/api/marimo/v1", token: "secret", pid: 1, file: "f" };
const target: InboxTarget = { serverUrl: "http://localhost:2800", notebookId: "nb-1", path: "/w/nb.py" };
const bytes = (text: string) => ({ ok: true, status: 200, body: (async function* () { yield new TextEncoder().encode(text); })() });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(responses: Array<() => unknown>, over: { host?: typeof host | undefined } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const messages: InboxMessage[] = [];
  const trouble = vi.fn();
  const detached = vi.fn();
  let n = 0;
  const inbox = new PairInbox({
    identity: "pi-marimo-probe",
    onMessage: (m) => messages.push(m),
    onTrouble: trouble,
    onDetached: detached,
    backoff: { initialMs: 1, maxMs: 4 },
    findHost: async () => ("host" in over ? over.host : host),
    fetchImpl: (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return (responses[Math.min(n++, responses.length - 1)] as () => unknown)();
    }) as never,
  });
  return { inbox, calls, messages, trouble, detached, count: () => n };
}

describe("PairInbox", () => {
  test("attaches as an agent named Pi and delivers notebook messages", async () => {
    const { inbox, calls, messages } = make([() => bytes(fixture)]);
    inbox.sync([target]);
    await wait(30);
    inbox.dispose();
    expect(calls[0]!.url).toBe("http://127.0.0.1:2800/api/marimo/v1/notebooks/nb-1/events?types=custom,attachment");
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer secret", "Marimo-Attachment-Kind": "agent", "Marimo-Attachment-Name": "Pi", "Marimo-Attachment-Identity": "pi-marimo-probe" });
    expect(messages.slice(0, 2).map((m) => m.text)).toEqual(["Please explain cell y", '{"text":"structured","cells":["vblA"]}']);
    expect(messages[0]).toMatchObject({ serverUrl: target.serverUrl, path: "/w/nb.py", notebookId: "nb-1" });
  });

  test("reconnects with the last event id", async () => {
    const { inbox, calls } = make([() => bytes(fixture)]);
    inbox.sync([target]);
    await wait(40);
    inbox.dispose();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[1]!.headers["Last-Event-ID"]).toBe("ec2d2833-26");
  });

  test("being detached in marimo stops it until reattach", async () => {
    const text = 'event: attachment\ndata: {"attachment":{"id":"att-1","identity":"pi-marimo-probe","kind":"agent"}}\n\nevent: attachment.removed\ndata: {"id":"att-1"}\n\n';
    const { inbox, count, detached } = make([() => bytes(text)]);
    inbox.sync([target]);
    await wait(30);
    expect(count()).toBe(1);
    expect(detached).toHaveBeenCalledTimes(1);
    inbox.sync([target]);
    await wait(20);
    expect(count()).toBe(1);
    inbox.reattach();
    inbox.sync([target]);
    await wait(30);
    inbox.dispose();
    expect(count()).toBe(2);
  });

  test("a server without a host record is left alone", async () => {
    const { inbox, count } = make([() => bytes("")], { host: undefined });
    inbox.sync([target]);
    inbox.sync([target]);
    await wait(20);
    inbox.dispose();
    expect(count()).toBe(0);
  });

  test("failures back off and report trouble once, at the third", async () => {
    const { inbox, trouble, count } = make([() => ({ ok: false, status: 500, body: null })]);
    inbox.sync([target]);
    await wait(80);
    inbox.dispose();
    expect(count()).toBeGreaterThanOrEqual(4);
    expect(trouble).toHaveBeenCalledTimes(1);
    expect(trouble.mock.calls[0]![1].message).toContain("500");
  });

  test("leaving the list closes the stream", async () => {
    const { inbox, count } = make([() => ({ ok: false, status: 500, body: null })]);
    inbox.sync([target]);
    await wait(10);
    inbox.sync([]);
    const seen = count();
    await wait(30);
    expect(count()).toBe(seen);
    inbox.dispose();
  });
});
