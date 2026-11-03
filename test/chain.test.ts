import { expect, test } from "vitest";
import { ChainTracker, chainSteps, predictedSteps } from "../src/core/chain.js";

const busyOf = (set: Set<string>) => (id: string) => set.has(id);

test("a chain starts at queued, steps follow run start order, and it ends when nothing is busy", () => {
  const t = new ChainTracker();
  const busy = new Set<string>();
  busy.add("a"); t.status("a", "queued", 1, busyOf(busy));
  busy.add("b"); t.status("b", "queued", 1, busyOf(busy));
  t.status("b", "running", 2, busyOf(busy));
  t.status("a", "running", 3, busyOf(busy));
  expect(t.current!.members).toEqual(["a", "b"]);
  expect([...t.current!.steps]).toEqual([["b", 1], ["a", 2]]);
  busy.delete("b"); t.status("b", "idle", 4, busyOf(busy));
  expect(t.active()).toBe(true);
  busy.delete("a"); t.status("a", "idle", 5, busyOf(busy));
  expect(t.active()).toBe(false);
  expect(t.current!.endedAt).toBe(5);
  busy.add("c"); t.status("c", "queued", 6, busyOf(busy));
  expect(t.current!.id).toBe(2);
  expect(t.current!.members).toEqual(["c"]);
});

test("markStale records non-members only while active; reset clears", () => {
  const t = new ChainTracker();
  t.markStale("x", true);
  expect(t.current).toBeUndefined();
  t.status("a", "queued", 1, () => true);
  t.markStale("x", true);
  t.markStale("a", true);
  expect([...t.current!.stale]).toEqual(["x"]);
  t.markStale("x", false);
  expect(t.current!.stale.size).toBe(0);
  t.reset();
  expect(t.current).toBeUndefined();
});

test("predicted steps follow dependencies, ties broken by file order", () => {
  const t = new ChainTracker();
  for (const id of ["a", "b", "c", "d"]) t.status(id, "queued", 1, () => true);
  t.status("a", "running", 2, () => true);
  const parents: Record<string, string[]> = { a: [], b: ["a"], c: ["a"], d: ["b", "c"] };
  const p = predictedSteps(t.current!, ["a", "c", "b", "d"], id => parents[id]!);
  expect([p.get("c"), p.get("b"), p.get("d")]).toEqual([2, 3, 4]);
  expect(chainSteps(t.current!, ["a", "c", "b", "d"], id => parents[id]!).get("a")).toEqual({ step: 1, predicted: false });
});

test("a cycle falls back to file order", () => {
  const t = new ChainTracker();
  t.status("a", "queued", 1, () => true);
  t.status("b", "queued", 1, () => true);
  const parents: Record<string, string[]> = { a: ["b"], b: ["a"] };
  const p = predictedSteps(t.current!, ["b", "a"], id => parents[id]!);
  expect([p.get("b"), p.get("a")]).toEqual([1, 2]);
});
