// Find running marimo servers and the notebooks open on them.
//
// Servers started with --no-token register a JSON file under
// $XDG_STATE_HOME/marimo/servers (marimo/_server/server_registry.py). A
// token-protected server is reached with MARIMO_TOKEN.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerEntry {
  serverId: string;
  url: string;
  pid?: number;
  version?: string;
}

export interface NotebookSession {
  url: string;
  sessionId: string;
  path: string;
}

export type Fetch = typeof fetch;

export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return join(homedir(), ".marimo", "servers");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "marimo", "servers");
}

export function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function hostFor(host: unknown): string {
  if (typeof host !== "string" || host === "" || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function alive(pid: number | undefined): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function listServers(dir = registryDir()): Promise<ServerEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const servers: ServerEntry[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const entry = JSON.parse(await readFile(join(dir, name), "utf8")) as Record<string, unknown>;
      const pid = typeof entry.pid === "number" ? entry.pid : undefined;
      if (!alive(pid) || typeof entry.port !== "number") continue;
      const base = typeof entry.base_url === "string" ? entry.base_url.replace(/\/$/, "") : "";
      servers.push({
        serverId: typeof entry.server_id === "string" ? entry.server_id : name,
        url: `http://${hostFor(entry.host)}:${entry.port}${base}`,
        pid,
        version: typeof entry.version === "string" ? entry.version : undefined,
      });
    } catch {
      // A file being written or removed; skip it this round.
    }
  }
  return servers;
}

export async function listSessions(url: string, options: { token?: string; fetch?: Fetch; timeoutMs?: number } = {}): Promise<NotebookSession[]> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${url}/api/sessions`, {
      headers: authHeaders(options.token),
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });
    if (!response.ok) return [];
    const body = await response.json() as Record<string, Record<string, unknown>>;
    return Object.entries(body ?? {}).flatMap(([sessionId, info]) => {
      const path = typeof info?.path === "string" ? info.path : typeof info?.filename === "string" ? info.filename : "";
      return path ? [{ url, sessionId, path }] : [];
    });
  } catch {
    return [];
  }
}

/** Every notebook session open on every live registered server, plus any extra server URLs. */
export async function findNotebooks(options: { token?: string; fetch?: Fetch; extraUrls?: string[]; dir?: string } = {}): Promise<NotebookSession[]> {
  const urls = new Set((await listServers(options.dir)).map((s) => s.url));
  for (const url of options.extraUrls ?? []) urls.add(url.replace(/\/$/, ""));
  const lists = await Promise.all([...urls].map((url) => listSessions(url, options)));
  return lists.flat();
}
