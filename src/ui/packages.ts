// Package pane state and presentation. All kernel work belongs to PackageClient.
import { visibleWidth } from "@earendil-works/pi-tui";
import type { EnvironmentState, PackageClient, PackageInfo, PackageSnapshot } from "../core/packages.js";
import type { Row } from "./rows.js";
export type PackageTab = "Installed" | "Missing" | "Operations";
export interface PackagePaneState {
  tab: PackageTab; filter: string; cursor: number; scroll: number; detail: boolean; expanded: string[];
  treeCursor?: number;
}
export interface DependencyNode { name: string; version?: string | null; tags?: { kind: string; value: string }[]; dependencies?: DependencyNode[] }
export interface TreeRow { key: string; name: string; text: string; expandable: boolean }
export function dependencyRows(raw: unknown, expanded: Set<string>, filter = ""): TreeRow[] {
  const q = filter.toLowerCase();
  const rows: TreeRow[] = [];
  const walk = (value: unknown, key: string, depth: number, ancestors: Set<unknown>): boolean => {
    if (!value || typeof value !== "object") return false;
    const node = value as DependencyNode;
    if (typeof node.name !== "string") return false;
    const cycle = ancestors.has(value);
    const tags = (Array.isArray(node.tags) ? node.tags : []).map(t => `[${t.kind}${t.value ? `: ${t.value}` : ""}]`).join(" ");
    const children = Array.isArray(node.dependencies) ? node.dependencies : [];
    const leaf = cycle || !!node.tags?.some(t => t.kind === "cycle" || t.kind === "dedupe");
    const row: TreeRow = { key, name: node.name, expandable: !leaf && children.length > 0, text: `${"  ".repeat(depth)}${!leaf && children.length ? expanded.has(key) || q ? "▾" : "▸" : " "} ${node.name}${node.version ? ` ${node.version}` : ""} ${tags}${cycle ? " [cycle]" : ""}` };
    const start = rows.length;
    rows.push(row);
    let found = row.text.toLowerCase().includes(q);
    if (!leaf && (expanded.has(key) || q)) for (let i = 0; i < children.length; i++) found = walk(children[i], `${key}/${i}`, depth + 1, new Set([...ancestors, value])) || found;
    if (q && !found) rows.splice(start);
    return found;
  };
  walk(raw, "root", 0, new Set());
  return rows;
}
export function wrapPackageLines(lines: string[], width: number): Row[] {
  return lines.flatMap(line => {
    const rows: Row[] = []; let text = "";
    for (const ch of line) { if (text && visibleWidth(text + ch) > Math.max(1, width)) { rows.push({ text }); text = ""; } text += ch; }
    rows.push({ text }); return rows;
  });
}
export class PackagePane {
  state: PackagePaneState = { tab: "Installed", filter: "", cursor: 0, scroll: 0, detail: false, expanded: ["root"] };
  snapshot?: PackageSnapshot;
  tree?: unknown;
  treeError?: string;
  error?: string;
  loading = false;
  mutating = false;
  typing = false;
  treeCursor = 0;
  private generation = 0;
  constructor(state?: PackagePaneState) { if (state) { this.state = { ...state, expanded: [...state.expanded] }; this.treeCursor = state.treeCursor ?? 0; } }
  selectTree(name: string): void {
    const find = (raw: unknown, key: string, parents: string[]): string[] | undefined => {
      if (!raw || typeof raw !== "object") return;
      const node = raw as DependencyNode;
      if (node.name === name) return [...parents, key];
      for (const [i, child] of (node.dependencies ?? []).entries()) {
        const found = find(child, `${key}/${i}`, [...parents, key]); if (found) return found;
      }
      return;
    };
    const path = find(this.tree, "root", []);
    if (path) {
      this.state.expanded = [...new Set([...this.state.expanded, ...path])];
      this.treeCursor = Math.max(0, this.trees().findIndex(row => row.key === path.at(-1)));
    }
  }
  dispose(): void { this.generation++; }
  async refresh(client: PackageClient, changed: () => void): Promise<void> {
    const generation = ++this.generation;
    this.loading = true; this.error = undefined; changed();
    try { const snapshot = await client.reconcile(); if (generation === this.generation) this.snapshot = snapshot; }
    catch (e) { if (generation === this.generation) this.error = String(e instanceof Error ? e.message : e); }
    finally { if (generation === this.generation) { this.loading = false; changed(); } }
  }
  installed(): PackageInfo[] { const q = this.state.filter.toLowerCase(); return (this.snapshot?.packages ?? []).filter(p => `${p.name} ${p.version}`.toLowerCase().includes(q)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
  trees(): TreeRow[] { return dependencyRows(this.tree, new Set(this.state.expanded), this.state.filter); }
  rows(environment: EnvironmentState, width: number): Row[] {
    const state = this.state;
    const lines: string[] = [`Packages · ${state.tab} · ${this.loading ? "refreshing" : "notebook kernel"}`, `Tab Installed/Missing/Operations · / ${state.filter}`];
    if (this.snapshot) { const fp = this.snapshot.fingerprint; lines.push(`${fp.filename} · ${fp.manager}`, `${fp.executable} · pid ${fp.pid}`, "Environment may be shared with server/other notebooks."); }
    if (this.error) lines.push(this.error);
    if (state.detail) {
      if (this.treeError) lines.push(this.treeError);
      else if (!this.tree) lines.push("Loading dependency tree…");
      else lines.push(...this.trees().map((r, i) => `${i === this.treeCursor ? "●" : " "} ${r.text}`));
    } else if (state.tab === "Installed") {
      const list = this.installed();
      state.cursor = Math.max(0, Math.min(state.cursor, list.length - 1));
      lines.push(...list.map((p, i) => `${i === state.cursor ? "●" : " "} ${p.name} ${p.version}`));
      if (!list.length) lines.push(this.loading ? "Loading packages…" : "No installed package matches.");
    } else if (state.tab === "Missing") {
      for (const [source, missing] of environment.missing) for (const name of missing.packages) if (name.toLowerCase().includes(state.filter.toLowerCase())) lines.push(`${source}: ${name}${source === "server" ? " · server tooling; not kernel-installable" : " · missing import"}`);
      lines.push("Use a to enter a kernel requirement explicitly.");
    } else {
      for (const op of environment.operations.values()) {
        const title = `${op.source}: ${op.action} · ${op.status.kind} · ${Object.keys(op.packages).join(", ")}`;
        const text = `${title}\n${op.status.error ?? op.status.reason ?? ""}\n${environment.logText(op)}`;
        if (text.toLowerCase().includes(state.filter.toLowerCase())) lines.push(...text.split("\n"));
      }
      for (const [source, required] of environment.restartRequired) if (required) lines.push(`${source}: restart required. Restart manually when safe; never automatic.`);
    }
    if (this.mutating) lines.push("Package operation pending; do not repeat.");
    return wrapPackageLines(lines, width);
  }
}
