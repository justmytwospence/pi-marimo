import { expect, test } from "vitest";
import { listSessions } from "../src/core/registry.js";

test("listSessions keeps marimo main's notebook id", async () => {
  const io = { getJson: async () => ({ s_1: { path: "/w/nb.py", notebook_id: "nb-1" }, s_2: { filename: "/w/b.py" } }) } as never;
  expect(await listSessions(io, "http://x")).toEqual([
    { url: "http://x", sessionId: "s_1", path: "/w/nb.py", notebookId: "nb-1" },
    { url: "http://x", sessionId: "s_2", path: "/w/b.py" },
  ]);
});

test("listSessions keeps marimo 0.25.2's stable pair session id apart from the socket's", async () => {
  const io = { getJson: async () => ({ "s-socket": { path: "/w/nb.py", session_id: "sess-stable" }, s_old: { path: "/w/old.py", session_id: "" } }) } as never;
  expect(await listSessions(io, "http://x")).toEqual([
    { url: "http://x", sessionId: "s-socket", path: "/w/nb.py", pairSessionId: "sess-stable" },
    { url: "http://x", sessionId: "s_old", path: "/w/old.py" },
  ]);
});
