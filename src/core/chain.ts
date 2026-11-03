// The latest run's cells, tracked from the kernel's queued/running statuses. View-only: never agent-visible.

export interface RunChain {
  /** Increments per chain (1, 2, ...). */
  id: number;
  startedAt: number;
  endedAt?: number;
  /** Cells the kernel queued or ran in this chain, in the order first seen. */
  members: string[];
  /** Actual 1-based run step, assigned when a member first reports "running". */
  steps: Map<string, number>;
  /** Non-member cells reported stale (lazy runtime) while the chain was active. */
  stale: Set<string>;
}

export class ChainTracker {
  current: RunChain | undefined;
  private counter = 0;

  reset(): void {
    this.current = undefined;
  }

  active(): boolean {
    return this.current !== undefined && this.current.endedAt === undefined;
  }

  status(id: string, status: string, at: number, busy: (id: string) => boolean): void {
    if (status === "queued" || status === "running") {
      if (!this.active()) this.current = { id: ++this.counter, startedAt: at, members: [], steps: new Map(), stale: new Set() };
      const chain = this.current!;
      if (!chain.members.includes(id)) chain.members.push(id);
      chain.stale.delete(id);
      if (status === "running" && !chain.steps.has(id)) chain.steps.set(id, chain.steps.size + 1);
      return;
    }
    const chain = this.current;
    if (chain && this.active() && chain.members.includes(id) && !chain.members.some(busy)) chain.endedAt = at;
  }

  markStale(id: string, stale: boolean): void {
    const chain = this.current;
    if (!chain || !this.active()) return;
    if (stale) { if (!chain.members.includes(id)) chain.stale.add(id); }
    else chain.stale.delete(id);
  }
}

/** Predicted 1-based steps for members without an actual step. */
export function predictedSteps(chain: RunChain, order: readonly string[], parents: (id: string) => readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const pending = chain.members.filter(id => !chain.steps.has(id));
  const pendingSet = new Set(pending);
  const index = (id: string) => { const i = order.indexOf(id); return i < 0 ? Infinity : i; };
  const inDegree = new Map<string, number>();
  for (const c of pending) inDegree.set(c, new Set(parents(c).filter(p => p !== c && pendingSet.has(p))).size);
  let next = chain.steps.size;
  const left = new Set(pending);
  while (left.size) {
    const ready = [...left].filter(c => inDegree.get(c) === 0)
      .sort((a, b) => index(a) - index(b) || (a < b ? -1 : a > b ? 1 : 0));
    const pick = ready[0];
    if (pick === undefined) break;
    out.set(pick, ++next);
    left.delete(pick);
    for (const c of left) if (parents(c).includes(pick) && c !== pick) inDegree.set(c, inDegree.get(c)! - 1);
  }
  for (const c of [...left].sort((a, b) => index(a) - index(b))) out.set(c, ++next);
  return out;
}

/** Every member's step: actual where known, otherwise predicted. */
export function chainSteps(chain: RunChain, order: readonly string[], parents: (id: string) => readonly string[]): Map<string, { step: number; predicted: boolean }> {
  const out = new Map<string, { step: number; predicted: boolean }>();
  for (const [id, step] of chain.steps) out.set(id, { step, predicted: false });
  for (const [id, step] of predictedSteps(chain, order, parents)) out.set(id, { step, predicted: true });
  return out;
}
