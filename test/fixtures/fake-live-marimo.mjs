// A loopback stand-in with independently gated registry, session and kernel events.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, ...args] = process.argv.slice(2);
if (mode === "early-exit") {
  writeSync(2, `start-of-stderr ${"x".repeat(6000)}\nlast line from marimo\n`);
  process.exit(3);
}
if (args[0] === "pair") {
  if (args[args.indexOf("--session") + 1] !== "stable-browser" || !args.includes("--stream")) {
    console.error("expected --session stable-browser --stream");
    process.exit(2);
  }
  process.stdin.resume();
  process.stdin.once("end", () => {
    writeFileSync("pair.tmp", String(process.pid));
    renameSync("pair.tmp", "pair");
  });
  setInterval(() => {}, 1000);
} else if (mode === "wrapped") {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "registered", ...args], { stdio: "inherit" });
  // Only signaling the wrapper would leave its server alive.
  process.on("SIGTERM", () => {});
  child.once("exit", () => process.exit(0));
} else {
  const port = Number(args[args.indexOf("--port") + 1]);
  const gated = mode === "gated";
  const file = args[args.indexOf("edit") + 1];
  const sessions = new Map();
  const registry = join(process.env.XDG_STATE_HOME, "marimo", "servers");
  const register = () => {
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, "server.json"), JSON.stringify({ pid: process.pid, host: "127.0.0.1", port }));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/health") return res.end("ok");
    if (url.pathname === "/api/sessions") {
      return res.end(JSON.stringify(!gated || existsSync("register-session") ? Object.fromEntries(sessions) : {}));
    }
    if (url.pathname === "/sse") {
      const id = url.searchParams.get("session_id");
      if (url.searchParams.get("kiosk") !== "true") {
        sessions.set(id, { path: url.searchParams.get("file"), session_id: `stable-${id}` });
        writeFileSync("stream-open", "");
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": connected\n\n");
      const ready = setInterval(() => {
        if (gated && !existsSync("kernel-ready")) return;
        clearInterval(ready);
        res.write(`data: ${JSON.stringify({ op: "kernel-ready", data: { cell_ids: ["cell"], codes: ["x = 1"], names: ["_"], configs: [{}] } })}\n\n`);
        writeFileSync("kernel-sent", "");
      }, 20);
      res.once("close", () => clearInterval(ready));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1", () => {
    console.error("fixture listening");
    if (!gated) register();
    else {
      const poll = setInterval(() => {
        if (!existsSync("register-server")) return;
        clearInterval(poll);
        register();
      }, 20);
    }
    writeFileSync("server", JSON.stringify({ port, pid: process.pid, file }));
  });
}
