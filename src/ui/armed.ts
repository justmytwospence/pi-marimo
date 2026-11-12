// Two-press confirmations: a destructive key arms its action, and the same key again carries it out.
// Any other key, or a change of notebook, session or selection, disarms.

export class ArmedActions {
  /** The kernel whose interrupt is armed. */
  target: string | undefined;
  /** Run-all or run-stale, and the kernel it was armed for. */
  run: { what: "stale" | "all"; target: string } | undefined;
  /** The server whose stop is armed. */
  stop: string | undefined;
  /** The Lens selection whose removal is armed. */
  unmark: { id: string; label: string } | undefined;

  clear(): void {
    this.target = undefined;
    this.run = undefined;
    this.stop = undefined;
    this.unmark = undefined;
  }
}
