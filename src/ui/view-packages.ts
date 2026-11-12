// The packages mode of the notebook view (`P`): the kernel's installed and missing packages, and
// cancel-first install, upgrade and removal. It owns the pane and its keys; the view hosts it.
import { matchesKey } from "@earendil-works/pi-tui";
import type { Followed } from "../core/watcher.js";
import type { PackageAction } from "../core/packages.js";
import { commandFor } from "./keys.js";
import { PackagePane, type PackagePaneState } from "./packages.js";
import type { ViewHost } from "./view-host.js";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class PackagesController {
  pane: PackagePane;
  private owner?: Followed["notebook"];

  constructor(private readonly host: ViewHost, state?: PackagePaneState) {
    this.pane = new PackagePane(state);
  }

  /** The pane's filter box has the keyboard. */
  get typing(): boolean { return this.pane.typing; }

  /** Whether the packages of this notebook have not been loaded yet. */
  needsOpen(f: Followed): boolean { return this.owner !== f.notebook; }

  open(f: Followed | undefined): void {
    if (!f) return;
    if (this.owner !== f.notebook) {
      if (this.owner) { this.pane.dispose(); this.pane = new PackagePane(); }
      this.owner = f.notebook;
    }
    const pane = this.pane;
    const { actions } = this.host;
    if (!actions.packages) { pane.error = "Package management unavailable"; return; }
    void actions.packages(f).then((client) => {
      if (!this.host.isClosed() && pane === this.pane) return pane.refresh(client, () => this.host.render());
    }).catch((e) => { if (pane === this.pane) { pane.error = message(e); this.host.render(); } });
  }

  private mutate(f: Followed, action: PackageAction, spec: string): void {
    const pane = this.pane;
    const { actions } = this.host;
    if (pane.mutating || !actions.packages) return;
    pane.mutating = true;
    void actions.packages(f).then((client) => client.mutate(action, spec, async (question) => {
      if (this.host.isClosed() || this.host.current()?.notebook !== f.notebook) return false;
      const fp = question.fingerprint;
      this.host.setConfirming(true);
      try {
        const answer = await actions.confirm?.(`${question.action}: ${question.spec}\nNotebook: ${fp.filename}\nKernel: ${fp.executable}\npid ${fp.pid} · ${fp.manager}\n${question.warning}`, ["Cancel", "Confirm"]);
        return answer === "Confirm" && !this.host.isClosed() && this.host.current()?.notebook === f.notebook;
      } finally { this.host.setConfirming(false); }
    })).then((result) => {
      if (pane !== this.pane || this.host.isClosed()) return;
      pane.error = result.status === "restart-required" ? "Restart required; restart manually when safe." : `Package operation: ${result.status}`;
      if (result.status !== "cancelled") this.open(f);
    }).catch((e) => { if (pane === this.pane) pane.error = message(e); })
      .finally(() => { pane.mutating = false; this.host.render(); });
  }

  key(f: Followed | undefined, data: string): void {
    const pane = this.pane, state = pane.state;
    if (pane.typing) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) pane.typing = false;
      else if (matchesKey(data, "backspace")) state.filter = state.filter.slice(0, -1);
      else if (!data.startsWith("\x1b") && data >= " ") state.filter += data;
      state.cursor = 0; state.scroll = 0; pane.treeCursor = 0; return;
    }
    const command = commandFor("packages", data)?.id;
    const { actions } = this.host;
    if (command === "pkg-back" && state.detail) { state.detail = false; state.scroll = 0; return; }
    if (command === "pkg-close" || command === "pkg-back") { this.host.showCells(); return; }
    if (command === "pkg-find") { pane.typing = true; state.filter = ""; state.scroll = 0; return; }
    if (command === "pkg-tab") {
      const tabs = ["Installed", "Missing", "Operations"] as const;
      state.tab = tabs[(tabs.indexOf(state.tab) + 1) % tabs.length]!; state.cursor = 0; state.scroll = 0; state.detail = false; return;
    }
    const delta = command === "pkg-down" ? 1 : command === "pkg-up" ? -1 : 0;
    if (delta) {
      if (state.detail) pane.treeCursor = Math.max(0, Math.min(pane.trees().length - 1, pane.treeCursor + delta));
      else state.cursor = Math.max(0, state.cursor + delta);
      state.scroll = Math.max(0, state.scroll + delta); return;
    }
    if (command === "pkg-page-down" || command === "pkg-page-up") { state.scroll = Math.max(0, state.scroll + (command === "pkg-page-down" ? this.host.viewport() : -this.host.viewport())); return; }
    if (command === "pkg-top" || command === "pkg-bottom") { state.scroll = command === "pkg-top" ? 0 : Number.MAX_SAFE_INTEGER; return; }
    if (!f) return;
    if (command === "pkg-refresh") { this.open(f); return; }
    if (command === "pkg-detail") {
      if (state.detail) {
        const treeRow = pane.trees()[pane.treeCursor];
        if (treeRow?.expandable) state.expanded = state.expanded.includes(treeRow.key) ? state.expanded.filter((key) => key !== treeRow.key) : [...state.expanded, treeRow.key];
      } else if (state.tab === "Installed" && pane.installed()[state.cursor] && actions.packages) {
        const selected = pane.installed()[state.cursor]!;
        state.detail = true; state.scroll = 0; pane.treeError = undefined;
        void actions.packages(f).then((client) => client.dependencyTree()).then((tree) => {
          if (pane === this.pane && !this.host.isClosed()) { pane.tree = tree; pane.selectTree(selected.name); this.host.render(); }
        }).catch((e) => { pane.treeError = `Dependency tree unavailable: ${message(e)}`; this.host.render(); });
      }
      return;
    }
    if (pane.mutating) { this.host.setNote("A package operation is already pending."); return; }
    if (command === "pkg-add") {
      this.host.openDock({ kind: "ask", title: "Install kernel requirement", hint: "Requirement, not a shell command · enter review · esc cancel", submit: (text) => {
        if (!text.trim()) return;
        this.host.closeDock(); this.mutate(f, "install", text.trim()); this.host.render();
      }, cancel: () => { this.host.closeDock(); this.host.render(); } });
    } else if ((command === "pkg-upgrade" || command === "pkg-remove") && state.tab === "Installed" && !state.detail) {
      const selected = pane.installed()[state.cursor];
      if (selected) this.mutate(f, command === "pkg-upgrade" ? "upgrade" : "remove", selected.name);
    }
  }

  dispose(): void { this.pane.dispose(); }
}
