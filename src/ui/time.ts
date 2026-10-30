// Shared timing text; callers supply now so the view needs only its existing timer.
const seconds = (ms: number) => Math.max(0, ms) / 1000;

export function duration(ms: number): string {
  const s = seconds(ms);
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

function parts(at: number, timeZone?: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((p) => [p.type, p.value]));
}

/** Local calendar labels, optionally pinned to a timezone for deterministic inspection/tests. */
export function runTime(at: number, now: number, timeZone?: string): string {
  const age = seconds(now - at);
  if (age < 10) return "just now";
  if (age < 60) return `${Math.floor(age)}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
  const p = parts(at, timeZone);
  const n = parts(now, timeZone);
  const clock = `${p.hour}:${p.minute}`;
  const day = (v: Record<string, string>) => Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day));
  if (day(n) - day(p) === 86400000) return `yesterday ${clock}`;
  if (age < 7 * 86400) return `${new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at)} ${clock}`;
  if (p.year === n.year) return `${new Intl.DateTimeFormat("en-US", { timeZone, month: "short" }).format(at)} ${Number(p.day)} ${clock}`;
  return `${p.year}-${p.month}-${p.day} ${clock}`;
}

/** Exact local wall time with an explicit timezone offset (including DST at that instant). */
export function exactTime(at: number, timeZone?: string): string {
  const p = parts(at, timeZone);
  const detail = new Intl.DateTimeFormat("en-US", { timeZone, second: "2-digit", timeZoneName: "longOffset" }).formatToParts(at);
  const second = detail.find((v) => v.type === "second")!.value.padStart(2, "0");
  const zone = detail.find((v) => v.type === "timeZoneName")!.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${second} ${zone}`;
}
