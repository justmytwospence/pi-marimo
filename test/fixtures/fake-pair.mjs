// A strict, server-free stand-in for the official CLI. Source is read ONLY
// from stdin; its first comment selects behavior, never an extra execute flag.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] === "--wrapper") {
  // Test a uv-like prefix that does not forward signals. Its child inherits
  // the host's private process group and pipes, not another notebook/server.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.slice(1)], { stdio: "inherit" });
  process.on("SIGTERM", () => {});
  await new Promise(resolve => {
    child.once("error", () => { process.exitCode = 2; resolve(); });
    child.once("exit", code => { process.exitCode = code ?? 1; resolve(); });
  });
} else {
  const help = ["pair", "execute", "--help"];
  const isHelp = args.length === help.length && args.every((arg, i) => arg === help[i]);
  const isExecute = args.length === 9 && args[0] === "pair" && args[1] === "execute"
    && args[2] === "--url" && Boolean(args[3]) && args[4] === "--session" && Boolean(args[5])
    && args[6] === "--code-file" && args[7] === "-" && args[8] === "--stream";

  const write = (stream, text) => new Promise((resolve, reject) => {
    stream.write(text, error => error ? reject(error) : resolve());
  });

  if (isHelp) {
    await write(process.stdout, "Usage: pair execute --url URL --session SESSION --code-file - --stream\n");
  } else if (!isExecute) {
    await write(process.stderr, "fake-pair: expected pair execute --help or pair execute --url URL --session SESSION --code-file - --stream\n");
    process.exitCode = 2;
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const source = Buffer.concat(chunks).toString("utf8");
    const mode = /^# fake-pair: (success|delay|failure|exit2|large-output|echo|hold)(?:\r?\n|$)/u.exec(source)?.[1] ?? "success";
    switch (mode) {
      case "hold":
        await write(process.stdout, `started:${process.pid}\n`);
        await new Promise(resolve => setTimeout(resolve, 60_000));
        break;
      case "delay":
        await new Promise(resolve => setTimeout(resolve, 150));
        await write(process.stdout, "delayed success\n");
        break;
      case "failure":
        await write(process.stderr, "ValueError: failure mentions KeyboardInterrupt and interrupted\n");
        process.exitCode = 1;
        break;
      case "exit2":
        await write(process.stderr, "transport diagnostic (not proof of Python failure)\n");
        process.exitCode = 2;
        break;
      case "large-output":
        await write(process.stdout, Array.from({ length: 360 }, (_, i) => `line-${i}: café 🐍 漢字 ${"🧪".repeat(24)}\n`).join(""));
        await write(process.stderr, Array.from({ length: 320 }, (_, i) => `err-${i}: é🧪\n`).join(""));
        break;
      case "echo":
        await write(process.stdout, JSON.stringify({ argv: args, cwd: process.cwd(), source, env: { PATH: process.env.PATH } }) + "\n");
        break;
      default:
        await write(process.stdout, "success\n");
    }
  }
}
