// Presentation of retained execution evidence only. Never consult a live session.
import { keyHint, type ExtensionAPI, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { basename } from "../core/io.js";
import { elapsed } from "../core/render.js";
import { clean, oneLine } from "./text.js";

type State = "starting" | "running" | "reconnecting" | "succeeded" | "failed" | "interrupted" | "unknown";
type Tone = "accent" | "success" | "error" | "warning" | "dim";
interface Descriptor {
  label: string;
  notebook?: string;
  state: State;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  errors: string[];
  subscribed?: boolean;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const timestamp = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const states: readonly string[] = ["starting", "running", "reconnecting", "succeeded", "failed", "interrupted", "unknown"];
const firstLine = (text: string): string => text.split("\n").map(oneLine).find(Boolean) ?? "";

/** Only textual blocks are evidence; do not stringify arbitrary notebook objects. */
function originalText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => {
    const item = object(block);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

function descriptor(value: unknown, body: string): Descriptor | undefined {
  const data = object(value);
  if (!data || !string(data.state)) return undefined;
  const state: State = states.includes(data.state as string) ? data.state as State : "unknown";
  let label = string(data.label);
  // Persisted demo v1 metadata has no label/times. Match the original body line,
  // not the headline, stdout, or a guessed duration in prose.
  if (!label && typeof data.id === "string" && !/[\r\n]/u.test(data.id)) {
    const prefix = `${data.id}: `;
    const suffix = ` · ${data.state}`;
    const line = body.split("\n").find(line => line.startsWith(prefix) && line.endsWith(suffix) && line.length > prefix.length + suffix.length);
    if (line) label = line.slice(prefix.length, -suffix.length);
  }
  const target = object(data.target);
  const path = string(target?.canonicalPath) ?? string(target?.path) ?? string(data.notebook);
  return {
    label: oneLine(label ?? (data.kind === "watch" ? "Notebook execution" : "Python execution")),
    notebook: path ? basename(oneLine(path)) : undefined,
    state,
    startedAt: timestamp(data.startedAt), endedAt: timestamp(data.endedAt),
    summary: typeof data.summary === "string" ? data.summary : undefined,
    errors: Array.isArray(data.errors) ? data.errors.filter((error): error is string => typeof error === "string").map(firstLine).filter(Boolean) : [],
    subscribed: typeof data.subscribed === "boolean" ? data.subscribed : undefined,
  };
}

function descriptors(details: unknown, body: string): Descriptor[] {
  const data = object(details);
  if (!data || (data.version !== undefined && data.version !== 1 && data.version !== 2)) return [];
  const values = Array.isArray(data.executions) ? data.executions : Array.isArray(data.records) ? data.records : [data];
  return values.flatMap(value => {
    const item = descriptor(value, body);
    return item ? [item] : [];
  });
}

function tone(state: State): Tone {
  if (state === "succeeded") return "success";
  if (state === "failed") return "error";
  if (state === "starting" || state === "running") return "accent";
  return "warning";
}

function heading(record: Descriptor, theme: Theme, expanded: boolean, error = false): string {
  const duration = record.startedAt !== undefined && record.endedAt !== undefined && record.endedAt >= record.startedAt
    ? ` · ${elapsed(record.endedAt - record.startedAt)}` : "";
  return `${expanded ? "▾" : "▸"} ${theme.fg("accent", record.notebook ?? "Marimo execution")} · ${record.label} · ${theme.fg(error ? "error" : tone(record.state), error ? "failed" : record.state)}${theme.fg("dim", duration)}`;
}

interface CardOptions {
  expanded: boolean;
  outputPad?: number;
  partial?: boolean;
  error?: boolean;
  unsubscribe?: boolean;
}

/** Recompute all styles/hints on render: invalidate needs no cached state. */
function card(body: string, records: Descriptor[], options: CardOptions, theme: Theme): Component {
  return {
    invalidate() {},
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      width = Math.floor(width);
      const requestedPad = options.outputPad;
      const pad = typeof requestedPad === "number" && Number.isFinite(requestedPad) ? Math.min(Math.max(0, Math.floor(requestedPad)), Math.floor((width - 1) / 2)) : 0;
      const inner = width - 2 * pad;
      const lines: string[] = [];
      const first = records[0];
      if (records.length > 1 && !options.error) {
        const counts = states.flatMap(state => {
          const count = records.filter(record => record.state === state).length;
          return count ? [theme.fg(tone(state as State), `${count} ${state}`)] : [];
        });
        lines.push(`${options.expanded ? "▾" : "▸"} ${theme.fg("accent", `${records.length} marimo executions`)} · ${counts.join(" · ")}`);
        if (!options.expanded) for (const record of records.slice(0, 2)) lines.push(`  ${heading(record, theme, false)}`);
      } else if (first) {
        lines.push(`${options.unsubscribe ? theme.fg("accent", "Stopped watching") + " · " : ""}${heading(first, theme, options.expanded, options.error)}`);
        if (!options.expanded && (options.error || ["failed", "interrupted", "unknown", "reconnecting"].includes(first.state))) {
          const preview = first.errors[0] || firstLine(first.summary ?? "") || (options.error ? firstLine(body) : "Outcome uncertain; inspect retained details before continuing. Do not retry automatically.");
          lines.push(theme.fg(options.error ? "error" : tone(first.state), `  ${preview || "Inspect retained error details before continuing."}`));
        }
      } else {
        const title = options.unsubscribe ? "Stopped watching" : "Marimo execution";
        const preview = options.error ? "failed" : options.partial ? "in progress" : firstLine(body) || "no details available";
        lines.push(`${options.expanded ? "▾" : "▸"} ${theme.fg(options.error ? "error" : options.partial ? "accent" : "warning", title)} · ${preview}`);
        if (options.error && !options.expanded) lines.push(theme.fg("error", `  ${firstLine(body) || "Inspect retained error details before continuing."}`));
      }
      const fitted = lines.map(line => truncateToWidth(line, inner));
      if (options.expanded) {
        // Text is inert, soft-wrapped, and has no extra preview/retention limit.
        fitted.push(...new Text(clean(body), 0, 0).render(inner).map(line => truncateToWidth(line, inner, "")));
      } else {
        const more = records.length > 2 && !options.error ? `${records.length - 2} more · ` : "";
        fitted.push(truncateToWidth(`  ${theme.fg("dim", more)}${keyHint("app.tools.expand", "expand output and details")}`, inner));
      }
      return fitted.map(line => `${" ".repeat(pad)}${line}${" ".repeat(pad)}`);
    },
  };
}

/** Factory-safe registration, independent of execution ownership or session state. */
export function registerExecutionMessageRenderers(pi: Pick<ExtensionAPI, "registerMessageRenderer">, completionType: string, statusType: string): void {
  for (const type of [completionType, statusType]) pi.registerMessageRenderer(type, (message, options, theme) => {
    const body = originalText(message.content);
    const data = object(message.details);
    const unsubscribe = type === statusType && (data?.action === "unsubscribe" || (data?.subscribed === false && body.startsWith("Stopped watching ")));
    return card(body, descriptors(message.details, body), { ...options, unsubscribe }, theme);
  });
}

export function executionToolRenderers(kind: "execute" | "watch" | "execution"): ToolRenderers {
  return {
    renderCall(args: unknown, theme, context) {
      const data = object(args);
      const notebook = string(data?.notebook);
      const id = string(data?.id);
      const unsubscribe = kind === "execution" && data?.action === "unsubscribe";
      const title = kind === "execute" ? `Execute Python · ${oneLine(string(data?.label) ?? "Python execution")} · ${notebook ? basename(oneLine(notebook)) : "selected notebook"}`
        : kind === "watch" ? `Watch execution · ${notebook ? basename(oneLine(notebook)) : "selected notebook"}`
          : `${unsubscribe ? "Stop watching execution" : "Execution status"}${id ? ` · ${oneLine(id).slice(0, 8)}` : ""}`;
      const source = kind === "execute" && typeof data?.code === "string" ? data.code : "";
      return {
        invalidate() {},
        render(width) {
          if (!Number.isFinite(width) || width < 1) return [];
          width = Math.floor(width);
          const lines = [truncateToWidth(theme.fg("accent", title), width)];
          if (context.expanded && source) lines.push(...new Text(clean(source), 0, 0).render(width).map(line => truncateToWidth(line, width, "")));
          return lines;
        },
      };
    },
    renderResult(result, options, theme, context) {
      const body = originalText(result.content);
      return card(body, descriptors(result.details, body), {
        expanded: options.expanded, partial: options.isPartial,
        error: context.isError || object(result)?.isError === true,
        unsubscribe: kind === "execution" && object(context.args)?.action === "unsubscribe",
      }, theme);
    },
  };
}
