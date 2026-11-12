import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { hostForServer, readHostRecords } from "../src/core/hosts.js";

const record = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, name: "marimo", process: { pid: 4242, started_at: "x" }, token: "tok", url: "http://127.0.0.1:2800/api/marimo/v1", ...over });
function dirWith(files: Record<string, { body: string; mode?: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-marimo-hosts-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, { body, mode }] of Object.entries(files)) { const p = join(dir, name); writeFileSync(p, body); chmodSync(p, mode ?? 0o600); }
  return dir;
}

describe.skipIf(process.platform === "win32")("readHostRecords", () => {
  test("accepts a private record of a live process", async () => {
    const dir = dirWith({ "a.json": { body: record() } });
    expect(await readHostRecords(dir, () => true)).toEqual([{ url: "http://127.0.0.1:2800/api/marimo/v1", token: "tok", pid: 4242, file: join(dir, "a.json") }]);
  });
  test("skips group-readable, dead, non-loopback, wrong-version and malformed records", async () => {
    const dir = dirWith({
      "open.json": { body: record(), mode: 0o644 },
      "dead.json": { body: record({ process: { pid: 1 } }) },
      "remote.json": { body: record({ url: "http://example.com/api/marimo/v1" }) },
      "v2.json": { body: record({ version: 2 }) },
      "bad.json": { body: "{nope" },
      "note.txt": { body: record() },
    });
    expect(await readHostRecords(dir, (pid) => pid !== 1)).toEqual([]);
  });
  test("a missing directory has no records", async () => {
    expect(await readHostRecords(join(tmpdir(), "pi-marimo-nope-dir"), () => true)).toEqual([]);
  });
});

describe("hostForServer", () => {
  const records = [{ url: "http://127.0.0.1:2800/api/marimo/v1", token: "t", pid: 1, file: "f" }, { url: "http://127.0.0.1:2900/base/api/marimo/v1", token: "u", pid: 2, file: "g" }];
  test("matches localhost to 127.0.0.1, rejects other ports, respects a base path", () => {
    expect(hostForServer(records, "http://localhost:2800")?.token).toBe("t");
    expect(hostForServer(records, "http://localhost:2801")).toBeUndefined();
    expect(hostForServer(records, "http://127.0.0.1:2900/base/")?.token).toBe("u");
    expect(hostForServer(records, "http://127.0.0.1:2900")).toBeUndefined();
  });
});
