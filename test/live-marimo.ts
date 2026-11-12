// Live tests run marimo from PATH, or from `PI_MARIMO_LIVE_MARIMO` (a command, e.g. `uvx --from git+... marimo`).
import { execFileSync } from "node:child_process";

export const MARIMO: string[] = process.env.PI_MARIMO_LIVE_MARIMO?.split(" ").filter(Boolean) ?? ["marimo"];

export function marimoAvailable(): boolean {
  if (process.env.PI_MARIMO_LIVE_TEST !== "1") return false;
  try {
    execFileSync(MARIMO[0]!, [...MARIMO.slice(1), "--version"], { stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}
