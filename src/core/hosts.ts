// marimo's host protocol: a running `marimo edit` that serves `/api/marimo/v1` publishes a private record
// (`hosts-v1/<uuid>.json`: url, bearer token, process) so local clients can find it. The record grants
// access to the host, so it is trusted only when it is private to this user and its process is alive.
// Never log a record: it holds the token.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { alive, hostsDir } from "./node-io.js";
import { sameServer } from "./touch.js";

export interface HostRecord {
  /** The API base, e.g. `http://127.0.0.1:2718/api/marimo/v1`. */
  url: string;
  token: string;
  pid: number;
  file: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export async function readHostRecords(dir: string = hostsDir(), isAlive: (pid: number) => boolean = alive): Promise<HostRecord[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const out: HostRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) continue;
      const json = JSON.parse(await readFile(file, "utf8")) as { version?: unknown; url?: unknown; token?: unknown; process?: { pid?: unknown } };
      const pid = json.process?.pid;
      if (json.version !== 1 || typeof json.url !== "string" || typeof json.token !== "string" || typeof pid !== "number" || !isAlive(pid)) continue;
      if (!LOOPBACK.has(new URL(json.url).hostname)) continue;
      out.push({ url: json.url.replace(/\/+$/u, ""), token: json.token, pid, file });
    } catch { /* unreadable or malformed: not a record */ }
  }
  return out;
}

/** The host record serving a marimo server (its base URL), when there is one. */
export function hostForServer(records: HostRecord[], serverUrl: string): HostRecord | undefined {
  return records.find((r) => sameServer(`${serverUrl.replace(/\/+$/u, "")}/api/marimo/v1`, r.url));
}

let cache: { at: number; records: Promise<HostRecord[]> } | undefined;

export async function findHost(serverUrl: string): Promise<HostRecord | undefined> {
  if (!cache || Date.now() - cache.at > 2000) cache = { at: Date.now(), records: readHostRecords() };
  return hostForServer(await cache.records, serverUrl);
}

export function resetHostCache(): void { cache = undefined; }
