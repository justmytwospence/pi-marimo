import { describe, expect, test, vi } from "vitest";
import { interruptKernel, runCells } from "../src/core/kernel.js";

const host = { url: "http://127.0.0.1:2800/api/marimo/v1", token: "secret", pid: 1, file: "f" };
const ok = (status = 202) => ({ ok: status < 300, status, text: async () => "" });

function setup(status = 202) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init });
    return url.endsWith("/") ? { ok: true, status: 200, text: async () => 'data-token="srv"' } : ok(status);
  });
  return { calls, fetchImpl: fetchImpl as never };
}

describe("host protocol", () => {
  test("interrupt posts to the notebook's runtime with a bearer and an idempotency key", async () => {
    const { calls, fetchImpl } = setup();
    await interruptKernel({ url: "http://localhost:2800", sessionId: "s", notebookId: "nb-1" }, undefined, fetchImpl, async () => host);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:2800/api/marimo/v1/notebooks/nb-1/runtime/interrupt");
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer secret");
    expect(calls[0]!.init.headers["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/u);
  });
  test("run sends cell ids only", async () => {
    const { calls, fetchImpl } = setup();
    await runCells({ url: "http://x", sessionId: "s", notebookId: "nb-1" }, [{ id: "a", code: "1" }], undefined, fetchImpl, async () => host);
    expect(calls[0]!.url).toContain("/notebooks/nb-1/runtime/runs");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ cells: [{ id: "a" }] });
  });
  test("a host refusal throws and is not retried", async () => {
    const { calls, fetchImpl } = setup(409);
    await expect(interruptKernel({ url: "http://x", sessionId: "s", notebookId: "nb-1" }, undefined, fetchImpl, async () => host)).rejects.toThrow("marimo answered 409");
    expect(calls).toHaveLength(1);
  });
});

describe("legacy endpoints", () => {
  test("without a host record", async () => {
    const { calls, fetchImpl } = setup();
    await interruptKernel({ url: "http://x", sessionId: "s", notebookId: "nb-1" }, undefined, fetchImpl, async () => undefined);
    expect(calls.at(-1)!.url).toBe("http://x/api/kernel/interrupt");
  });
  test("without a notebook id the host is not even looked up", async () => {
    const { calls, fetchImpl } = setup();
    const hosts = vi.fn(async () => host);
    await runCells({ url: "http://x", sessionId: "s" }, [{ id: "a", code: "1" }], undefined, fetchImpl, hosts);
    expect(hosts).not.toHaveBeenCalled();
    expect(calls.at(-1)!.url).toBe("http://x/api/kernel/run");
    expect(JSON.parse(calls.at(-1)!.init.body)).toEqual({ cellIds: ["a"], codes: ["1"] });
  });
});
