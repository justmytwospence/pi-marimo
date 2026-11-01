import { componentProps, outputElements, parseOutputFragment, textContent, type OutputNode } from "./html.js";
import { nutpieProgressFromNode } from "./sampler.js";

export interface ProgressTask {
  id: string;
  label: string;
  completed?: number;
  total?: number;
  /** Work units per second, only when the producer supplies a numeric rate. */
  rate?: number;
  etaSeconds?: number;
  elapsedSeconds?: number;
  state: "running" | "complete";
  /** Original producer columns, subtitle, and/or percent (without invented counts). */
  stats: Record<string, string>;
  sampler?: {
    producer: "nutpie";
    groupId: string;
    role: "total" | "chain";
    summary?: { totalChains?: number; activeChains?: number; finishedChains?: number; elapsed?: string; eta?: string };
  };
}

type Element = Extract<OutputNode, { tagName: string }>;
const attr = (node: Element, name: string) => node.attrs.find(a => a.name === name)?.value;
const elements = (node: OutputNode) => [...outputElements(node)];
const clean = (node: OutputNode) => textContent(node).replace(/\s+/g, " ").trim();
function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim()))) return;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function seconds(value: string | undefined): number | undefined {
  if (!value) return;
  if (/^\d+(?:\.\d+)?s$/.test(value)) return numeric(value.slice(0, -1));
  if (!/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(value)) return;
  return value.split(":").reduce((n, part) => n * 60 + Number(part), 0);
}
function finish(task: ProgressTask): ProgressTask {
  if ((task.total !== undefined && task.total > 0 && task.completed !== undefined && task.completed >= task.total)
    || numeric(task.stats.percent) !== undefined && Number(task.stats.percent) >= 100) task.state = "complete";
  return task;
}
function task(id: string, label = ""): ProgressTask {
  return { id, label, state: "running", stats: {} };
}

/** Parse one output snapshot. No state is retained between snapshots. HTML stays inert. */
export function progressFromHtml(html: string): ProgressTask[] {
  return progressFromNode(parseOutputFragment(html));
}

/** Read an existing inert parse5 subtree, including its root, without reparsing HTML. */
export function progressFromNode(root: OutputNode): ProgressTask[] {
  const result: ProgressTask[] = [];
  const consumed = new Set<OutputNode>();
  let samplerIndex = 0;
  for (const node of outputElements(root)) {
    if (consumed.has(node)) continue;
    if (node.tagName === "div") {
      const sampler = nutpieProgressFromNode(node, `nutpie:${samplerIndex}`);
      if (sampler) {
        samplerIndex++;
        for (const child of outputElements(node)) consumed.add(child);
        result.push(...sampler);
        continue;
      }
    }
    if (node.tagName === "marimo-progress") {
      const props = componentProps(node);
      const t = task(attr(node, "id") ?? `marimo:${result.length}`, typeof props.title === "string" ? props.title : "");
      if (typeof props.subtitle === "string") t.stats.subtitle = props.subtitle;
      // A boolean progress prop explicitly requests a spinner, even if a total is present.
      if (props.progress !== true) {
        t.completed = numeric(props.progress);
        t.total = numeric(props.total);
      }
      t.rate = numeric(props.rate);
      t.etaSeconds = numeric(props.eta);
      result.push(finish(t));
    } else if (node.tagName === "table" && attr(node, "class")?.split(/\s+/).includes("pymc-progress-table")) {
      const descendants = elements(node);
      for (const child of descendants) consumed.add(child);
      const rows = descendants.filter(n => n.tagName === "tr");
      const header = rows.find(r => elements(r).some(n => n.tagName === "th"));
      const headers = header ? elements(header).filter(n => n.tagName === "th").map(clean) : [];
      let rowIndex = 0;
      for (const row of rows) {
        if (row === header) continue;
        const cells = elements(row).filter(n => n.tagName === "td");
        if (!cells.length) continue;
        const t = task(`pymc:${result.length}:${rowIndex++}`);
        cells.forEach((cell, i) => {
          const name = headers[i] || `Column ${i + 1}`;
          let key = name;
          for (let suffix = 2; Object.hasOwn(t.stats, key); suffix++) key = `${name} (${suffix})`;
          t.stats[key] = clean(cell);
          if (/^(chain|chains)$/i.test(name)) t.label = `Chain ${clean(cell)}`;
          if (/elapsed/i.test(name)) t.elapsedSeconds = seconds(clean(cell));
          if (/remaining|eta/i.test(name)) t.etaSeconds = seconds(clean(cell));
          // Current PyMC puts explicit counters in a dynamic Draw/Samples/etc. column.
          // Percent-only bars never acquire an artificial total of 100.
          const counters = clean(cell).match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?|\?)(?:\s*\(\d+(?:\.\d+)?%\))?$/);
          if (counters) {
            t.completed = numeric(counters[1]);
            t.total = numeric(counters[2]);
          }
          // Read only an actual numeric width in a progress column, never a table layout width.
          if (/progress/i.test(name) || !headers.length) {
            for (const div of elements(cell).filter(n => n.tagName === "div")) {
              const width = attr(div, "style")?.match(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)%\s*(?:;|$)/i);
              if (width) t.stats.percent = width[1]!;
            }
            const percent = clean(cell).match(/^(\d+(?:\.\d+)?)\s*%$/);
            if (percent) t.stats.percent = percent[1]!;
          }
        });
        if (!t.label) t.label = `Sampling ${rowIndex}`;
        result.push(finish(t));
      }
    } else if (node.tagName === "progress") {
      const t = task(attr(node, "id") ?? `progress:${result.length}`, attr(node, "aria-label") ?? attr(node, "title") ?? clean(node));
      // Missing value is indeterminate according to the HTML progress contract.
      if (attr(node, "value") !== undefined) {
        t.completed = numeric(attr(node, "value"));
        t.total = attr(node, "max") === undefined ? 1 : numeric(attr(node, "max"));
      }
      result.push(finish(t));
    }
  }
  return result;
}

/** Consume already-reduced terminal screen lines, not a stream of CR/ANSI redraws. */
export function progressFromText(lines: readonly string[]): ProgressTask[] {
  const result: ProgressTask[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    // Fractions require a progress bar, percent, timing/rate field, or a bare labelled count.
    const fraction = line.match(/(?<![-\w./])(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?![\w./])/);
    const percent = line.match(/(?<![-\w.])(\d+(?:\.\d+)?)\s*%/);
    const bar = /[━──█▓░▏▎▍▌▋▊▉]{2,}|\[[=>.\s-]{3,}\]|\|[^|]*\|/.test(line);
    const timing = line.match(/\[([\d:.]+)<([\d:.?]+)(?:,\s*([^\]]+))?\]/);
    const unknown = line.match(/(?:^|:\s*)(\d+)\s*it\s*\[([\d:.]+),\s*([^\]]+)\]/);
    // A plain mathematical fraction or CPU percentage is not a progress signal.
    const progressLabel = /^(?:batch|step|epoch|download|upload|fetch|install|progress|sampling|training)(?:\s+[^:]+)?:\s*/i.test(line);
    const bareFraction = progressLabel && /^[^:]+:\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(line);
    const percentOnly = progressLabel && /^[^:]+:\s*\d+(?:\.\d+)?\s*%$/.test(line);
    if (!(fraction && (bar || percent || timing || bareFraction) || percent && (bar || percentOnly) || unknown)) continue;
    const start = Math.min(...[fraction?.index, percent?.index, unknown?.index].filter((n): n is number => n !== undefined));
    const label = line.slice(0, start).replace(/[\s:|━─█▓░]+$/u, "");
    const t = task(`text:${index}`, label);
    if (fraction) {
      t.completed = numeric(fraction[1]);
      t.total = numeric(fraction[2]);
    }
    if (percent) t.stats.percent = percent[1]!;
    if (unknown) {
      t.completed = numeric(unknown[1]);
      t.elapsedSeconds = seconds(unknown[2]);
    }
    if (timing) {
      t.elapsedSeconds = seconds(timing[1]);
      t.etaSeconds = seconds(timing[2]);
    } else {
      const clocks = line.replace(/\bETA:\s*\S+/g, "").match(/\b\d+(?::\d{2}){1,2}\b/g);
      if (clocks?.[0]) t.elapsedSeconds ??= seconds(clocks[0]);
      if (clocks?.[1]) t.etaSeconds = seconds(clocks[1]);
    }
    const eta = line.match(/\bETA:\s*(\d+(?::\d{1,2}){1,2}(?:\.\d+)?|\d+(?:\.\d+)?s)\b/);
    if (eta) t.etaSeconds = seconds(eta[1]);
    const rate = line.match(/(\d+(?:\.\d+)?)\s*(it|samples?|steps?|[kMGT]?B)\/s\b/);
    const inverseRate = line.match(/(\d+(?:\.\d+)?)\s*s\/(?:it|steps?|samples?)\b/);
    if (rate) {
      t.stats.rate = rate[0];
      // Byte prefixes are retained verbatim, rather than silently changing units.
      if (!/[kMGT]B/.test(rate[2]!)) t.rate = numeric(rate[1]);
    } else if (inverseRate) {
      t.stats.rate = inverseRate[0];
      const duration = numeric(inverseRate[1]);
      if (duration) t.rate = 1 / duration;
    }
    const stats = line.match(/\s-\s(.+)$/);
    if (stats) t.stats.details = stats[1]!;
    result.push(finish(t));
  }
  return result;
}
