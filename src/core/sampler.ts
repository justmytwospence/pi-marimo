// nutpie 0.16.8's inert HTML progress template. Unknown templates fall back to ordinary HTML.
import { outputElements, textContent, type OutputNode } from "./html.js";
import type { ProgressTask } from "./progress.js";

type Element = Extract<OutputNode, { tagName: string }>;
const attr = (node: Element, name: string) => node.attrs.find(a => a.name === name)?.value;
const children = (node: Element, tag: string) => node.childNodes.filter((child): child is Element => "tagName" in child && child.tagName === tag);
const hasClass = (node: Element, name: string) => attr(node, "class")?.split(/\s+/u).includes(name);
const clean = (node: OutputNode) => textContent(node).replace(/\s+/gu, " ").trim();
const count = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim())) return;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const total = (value: string | undefined): number | undefined => {
  const n = count(value);
  return n !== undefined && n > 0 ? n : undefined;
};
const integer = (value: string): number | undefined => /^\d+$/u.test(value) ? count(value) : undefined;
const unexpected = (node: Element, allowed: readonly string[]): boolean => node.childNodes.some(child =>
  "tagName" in child ? !allowed.includes(child.tagName) || unexpected(child, allowed) : "value" in child && child.nodeName === "#text" && ["div", "table", "thead", "tbody", "tr"].includes(node.tagName) && !!child.value.trim());
const directElements = (node: Element) => node.childNodes.filter((child): child is Element => "tagName" in child);

/** Only claim the known nutpie schema; never swallow arbitrary HTML or infer chain shares. */
export function nutpieProgressFromNode(root: OutputNode, groupId: string): ProgressTask[] | undefined {
  if (!("tagName" in root) || root.tagName !== "div" || !hasClass(root, "nutpie")) return;
  // Summary paragraphs may contain inline labels/spans and the total progress control.
  const paragraphs = children(root, "p");
  const tables = children(root, "table");
  if (tables.length !== 1 || directElements(root).some(node => !["p", "table", "progress"].includes(node.tagName))
    || unexpected(root, ["p", "table", "progress", "span", "b", "strong", "em", "br", "thead", "tbody", "tr", "th", "td"])) return;
  const table = tables[0]!;
  if (paragraphs.some(p => unexpected(p, ["span", "b", "strong", "em", "br", "progress"]))
    || unexpected(table, ["thead", "tbody", "tr", "th", "td", "progress", "span"])) return;
  const bodies = children(table, "tbody").filter(node => attr(node, "id") === "chain-details");
  if (bodies.length !== 1 || children(table, "tbody").length !== 1) return;
  const progress = [...outputElements(root)].filter(node => node.tagName === "progress");
  const aggregate = progress.filter(node => attr(node, "id") === "total-progress-bar" && ![...outputElements(table)].includes(node));
  if (aggregate.length !== 1) return;
  const headers = [...outputElements(table)].filter(node => node.tagName === "th").map(clean);
  const progressIndex = headers.findIndex(name => /^progress$/iu.test(name));
  const drawsIndex = headers.findIndex(name => /^draws$/iu.test(name));
  if (progressIndex < 0 || drawsIndex < 0 || !headers.length) return;
  const rows = children(bodies[0]!, "tr");
  if (directElements(bodies[0]!).length !== rows.length) return;
  const summary: NonNullable<ProgressTask["sampler"]>["summary"] = {};
  const stats: Record<string, string> = {};
  let extra = 0;
  for (const paragraph of paragraphs) {
    const value = clean(paragraph);
    if (!value || value === "Sampler Progress") continue;
    const chains = /^(total|active|finished)\s+chains\s*:\s*(\d+)\s*$/iu.exec(value);
    if (chains) {
      const key = `${chains[1]!.toLowerCase()}Chains` as "totalChains" | "activeChains" | "finishedChains";
      const parsed = integer(chains[2]!);
      if (parsed !== undefined) { summary[key] = parsed; continue; }
    }
    const timing = /^(?:sampling\s+for\s+|(?:time\s+)?elapsed\s*:\s*)(.+)$/iu.exec(value);
    if (timing) { summary.elapsed = timing[1]!.trim(); continue; }
    const eta = /^(?:estimated\s+time\s+to\s+completion|estimated\s+time\s+remaining|eta|remaining)\s*:\s*(.+)$/iu.exec(value);
    if (eta) { summary.eta = eta[1]!.trim(); continue; }
    stats[`Summary ${++extra}`] = value;
  }
  const base = { producer: "nutpie" as const, groupId };
  const main = aggregate[0]!;
  const completed = count(attr(main, "value"));
  const max = total(attr(main, "max"));
  const tasks: ProgressTask[] = [{
    id: `${groupId}:total`, label: "Sampler", state: max !== undefined && completed !== undefined && completed >= max ? "complete" : "running",
    ...(completed !== undefined ? { completed } : {}), ...(max !== undefined ? { total: max } : {}),
    stats, sampler: { ...base, role: "total", summary },
  }];
  for (const [index, row] of rows.entries()) {
    const cells = children(row, "td");
    if (cells.length !== headers.length || directElements(row).length !== cells.length) return;
    const bars = [...outputElements(cells[progressIndex]!)].filter(node => node.tagName === "progress");
    if (bars.length !== 1) return;
    const bar = bars[0]!;
    const original = count(attr(bar, "value"));
    const draws = count(clean(cells[drawsIndex]!));
    const done = original ?? draws;
    const limit = total(attr(bar, "max"));
    const columns: Record<string, string> = {};
    cells.forEach((cell, i) => {
      const name = headers[i] || `Column ${i + 1}`;
      let key = name;
      for (let suffix = 2; Object.hasOwn(columns, key); suffix++) key = `${name} (${suffix})`;
      columns[key] = clean(cell);
    });
    tasks.push({
      id: `${groupId}:chain:${index}`, label: `Chain ${index + 1}`,
      state: limit !== undefined && done !== undefined && done >= limit ? "complete" : "running",
      ...(done !== undefined ? { completed: done } : {}), ...(limit !== undefined ? { total: limit } : {}),
      stats: columns, sampler: { ...base, role: "chain" },
    });
  }
  // A chain control may not be hidden in a summary or another part of the container.
  if (progress.length !== tasks.length) return;
  return tasks;
}
