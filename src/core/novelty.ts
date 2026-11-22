// Does a finished execution tell the agent anything beyond what it was last shown?
// Pure helpers; the host keeps the "shown" mark in memory.
import type { ExecutionRecord, ExecutionState } from "./execution.ts";

/** What a reply last showed the agent of one execution. */
export interface ShownMark { state: ExecutionState; stdoutBytes: number; stderrBytes: number; errors: string[]; blocked: string[] }

const total = (text: string, omitted: number): number => omitted + Buffer.byteLength(text);

export function shownMark(r: ExecutionRecord): ShownMark {
  return { state: r.state, stdoutBytes: total(r.stdout, r.stdoutOmittedBytes), stderrBytes: total(r.stderr, r.stderrOmittedBytes), errors: [...r.errors], blocked: [...r.blocked] };
}

/** The part of a bounded output tail that is newer than `shownBytes` total bytes. */
export function unseenText(text: string, omitted: number, shownBytes: number): string {
  const fresh = total(text, omitted) - shownBytes;
  if (fresh <= 0) return "";
  const bytes = Buffer.from(text);
  return bytes.subarray(Math.max(0, bytes.length - fresh)).toString("utf8");
}

// marimo code mode's own report of what it did (marimo/_code_mode/_context.py), and uv's install summary.
const CONFIRMATIONS = [
  /^created( and ran)? cell .+$/,
  /^edited (code|config|code and config) of cell .+?( and ran)?$/,
  /^(deleted|moved|re-ran) cell .+$/,
  /^(installed|uninstalled) \S+$/,
  /^updated \d+ UI element\(s\)$/,
  /^(Resolved|Prepared|Installed|Uninstalled|Audited) \d+ packages? in [\d.]+m?s$/,
  /^[+-] \S+==\S+$/,
];

export function isConfirmation(line: string): boolean {
  const text = line.trim();
  if (!text || text.endsWith("(error)")) return false;
  return CONFIRMATIONS.some((re) => re.test(text));
}

const hasNewLine = (text: string, omitted: number, shownBytes: number): boolean =>
  unseenText(text, omitted, shownBytes).split("\n").some((line) => line.trim() !== "" && !isConfirmation(line));

/** True when a finished run holds something the agent has not been shown. Unknown wording counts as news. */
export function hasNews(r: ExecutionRecord, mark: ShownMark | undefined): boolean {
  if (!mark || r.state !== "succeeded") return true;
  if (r.errors.some((e) => !mark.errors.includes(e)) || r.blocked.some((b) => !mark.blocked.includes(b))) return true;
  return hasNewLine(r.stdout, r.stdoutOmittedBytes, mark.stdoutBytes) || hasNewLine(r.stderr, r.stderrOmittedBytes, mark.stderrBytes);
}
