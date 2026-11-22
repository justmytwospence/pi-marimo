import { expect, test } from "vitest";
import type { ExecutionRecord } from "../src/core/execution.ts";
import { hasNews, isConfirmation, shownMark, unseenText } from "../src/core/novelty.ts";

function rec(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    version: 1, id: "r", owner: { sessionId: "s", anchorId: "a" },
    target: { url: "http://localhost:2799", path: "/w/fit.py", canonicalPath: "/w/fit.py", sessionId: "k" },
    kind: "execute", label: "Python execution", state: "succeeded", startedAt: 1, endedAt: 2, notification: "explicit", delivery: "pending", detached: true,
    stdout: "", stderr: "", stdoutOmittedBytes: 0, stderrOmittedBytes: 0, errors: [], blocked: [], ...over,
  };
}

test("isConfirmation matches marimo code mode and uv confirmations", () => {
  for (const line of [
    "created and ran cell 'PQdm'", "created cell 'a' (x)", "edited code of cell 'ulNU' (_) and ran", "edited code and config of cell 'b'",
    "re-ran cell 'mPxu' (_)", "deleted cell 'c'", "moved cell 'c'", "installed h5py", "updated 2 UI element(s)",
    "Resolved 1 package in 129ms", "Installed 1 package in 6ms", " + h5py==3.16.0",
  ]) expect(isConfirmation(line), line).toBe(true);
});

test("isConfirmation rejects errors, failures and real output", () => {
  for (const line of [
    "re-ran cell 'x' (_) (error)", "created and ran cell 'y' (error)", "failed to install foo",
    "changes saved for foo; restart the kernel to use them", "728 of 1,172 windows are uniform", "",
  ]) expect(isConfirmation(line), line).toBe(false);
});

test("unseenText returns only what grew past the mark", () => {
  expect(unseenText("abcdef", 0, 3)).toBe("def");
  expect(unseenText("abcdef", 0, 6)).toBe("");
  expect(unseenText("tail", 100, 10)).toBe("tail");
});

test("hasNews", () => {
  const shown = shownMark(rec({ stdout: "start\n" }));
  expect(hasNews(rec(), undefined)).toBe(true);
  for (const state of ["failed", "unknown", "interrupted"] as const) expect(hasNews(rec({ state, stdout: "start\n" }), shown)).toBe(true);
  expect(hasNews(rec({ stdout: "start\n", errors: ["fit: ValueError"] }), shown)).toBe(true);
  expect(hasNews(rec({ stdout: "start\n", blocked: ["child"] }), shown)).toBe(true);
  expect(hasNews(rec({ stdout: "start\n\n" }), shown)).toBe(false);
  expect(hasNews(rec({ stdout: "start\ncreated and ran cell 'a'\nre-ran cell 'b' (_)\n" }), shown)).toBe(false);
  expect(hasNews(rec({ stdout: "start\ncreated and ran cell 'a'\nresult: 42\n" }), shown)).toBe(true);
  expect(hasNews(rec({ stdout: "start\n", stderr: "warning: slow\n" }), shown)).toBe(true);
  expect(hasNews(rec({ stdout: "start\n", errors: ["e"] }), shownMark(rec({ stdout: "start\n", errors: ["e"] })))).toBe(false);
});
