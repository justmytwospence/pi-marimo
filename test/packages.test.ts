import { execFileSync } from "node:child_process";
import { expect, test, vi } from "vitest";
import { PackageClient, type PackageClientOptions, type PackageConfirmation } from "../src/core/packages.js";
import { NotebookState } from "../src/core/notebook.js";
import { pythonJson, type ScratchExecute } from "../src/core/edit-cell.js";

// Pure fake kernel, using only Python's stdlib. No installed marimo modules,
// package commands, environment mutations or developer notebook files are used.
const FAKE_KERNEL = `import asyncio, contextlib, inspect, json, os, sys, types
calls = []
config = CONFIG
os.getpid = lambda: config.get("pid", 123)
def module(name, **values):
    mod = types.ModuleType(name)
    for key, value in values.items(): setattr(mod, key, value)
    sys.modules[name] = mod
    return mod
class Manager:
    name = "fake"
    restart_required = False
    def is_manager_installed(self): return not config.get("unavailable", False)
    async def install(self, package, version, upgrade=False, group=None, log_callback=None):
        calls.append(["install", package, version, upgrade])
        if log_callback: log_callback("log\\n")
        self.restart_required = config.get("restart", False)
        return not config.get("failed", False) and not self.restart_required
    async def uninstall(self, package, group=None):
        calls.append(["uninstall", package])
        return True
    def update_notebook_script_metadata(self, filepath, *, packages_to_add=None, packages_to_remove=None, upgrade):
        calls.append(["metadata", filepath, packages_to_add, packages_to_remove, upgrade])
        if config.get("metadata_error", False): raise OSError("disk full")
        return True
    def dependency_tree(self, filename=None):
        calls.append(["tree", filename])
        return config.get("tree")
pm = Manager()
if config.get("missing_method"): pm.uninstall = None
class Packages:
    def list(self):
        calls.append(["list"])
        return [{"name": "example", "version": "1.0"}]
class Context:
    packages = Packages()
    _kernel = types.SimpleNamespace(packages_callbacks=types.SimpleNamespace(package_manager=pm), app_metadata=types.SimpleNamespace(filename=config.get("filename", "/fixture.py")), stream=object())
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
class Reporter:
    def update(self, logs=None, *, replace=False): calls.append(["update", logs, replace])
@contextlib.contextmanager
def environment_operation(action, packages, source, notify):
    calls.append(["operation", action, source])
    yield Reporter()
    calls.append(["statuses", packages])
def broadcast_notification(notification, *, stream): pass
def split_packages(spec): return [spec]
module("marimo", __version__=config.get("version", "0.25.0"))
module("marimo._code_mode", get_context=Context)
module("msgspec", to_builtins=lambda value: value)
module("marimo._runtime.packages.operations", environment_operation=environment_operation)
module("marimo._messaging.notification_utils", broadcast_notification=broadcast_notification)
module("marimo._runtime.packages.utils", split_packages=split_packages)
module("marimo._config.settings", GLOBAL_SETTINGS=types.SimpleNamespace(MANAGE_SCRIPT_METADATA=True))
`;
// Run top-level-await scripts in an explicitly mocked code-mode kernel.
const fakeHarness = FAKE_KERNEL + `try:
    result = eval(compile(SCRIPT, "<fake-kernel>", "exec", flags=__import__("ast").PyCF_ALLOW_TOP_LEVEL_AWAIT), {})
    asyncio.run(result)
except Exception as exc:
    print("fake-error:" + str(exc))
finally:
    print("fake-calls:" + json.dumps(calls))
`;

function fixture() {
  const notebook = new NotebookState();
  notebook.apply("kernel-ready", { cell_ids: ["a"], codes: ["x = 1"] });
  const config: Record<string, unknown> = {};
  const calls: unknown[][] = [];
  const scripts: string[] = [];
  let transportFailure = false;
  const executeOnce: ScratchExecute = vi.fn(async (_target, code, _token, event) => {
    scripts.push(code);
    const output = execFileSync("python3", ["-c", `import json\nCONFIG = ${pythonJson(config)}\nSCRIPT = ${pythonJson(code)}\n${fakeHarness}`], { encoding: "utf8" });
    let success = true;
    for (const line of output.trimEnd().split("\n")) {
      if (line.startsWith("fake-calls:")) calls.push(...JSON.parse(line.slice(11)) as unknown[][]);
      else if (line.startsWith("fake-error:")) { success = false; event({ stream: "stderr", text: line.slice(11) }); }
      else event({ stream: "stdout", text: line });
    }
    if (transportFailure && code.includes("success = await")) throw new Error("HTTP 500 after application");
    return { success };
  });
  const options: PackageClientOptions = {
    target: { url: "http://fixture", sessionId: "session" }, filename: "/fixture.py", notebook,
    isCurrent: () => true, isConnected: () => true, executeOnce, reconcile: vi.fn(),
  };
  return { notebook, config, calls, scripts, executeOnce, options, client: new PackageClient(options), failTransport: () => { transportFailure = true; } };
}

test("list and tree use only a resolved session's execute route and never mutate", async () => {
  const f = fixture();
  expect((await f.client.list()).packages).toEqual([{ name: "example", version: "1.0" }]);
  await expect(f.client.dependencyTree()).rejects.toThrow("Dependency tree unavailable");
  f.config.tree = { name: "root", dependencies: [] };
  expect(await f.client.dependencyTree()).toEqual(f.config.tree);
  expect(f.calls).toContainEqual(["tree", "/fixture.py"]);
  expect(f.calls.some(call => ["install", "uninstall"].includes(String(call[0])))).toBe(false);
  expect(f.scripts.join("\n")).not.toMatch(/\/api\/packages|subprocess|os\.system/);
  expect(f.scripts[0]).toContain("ctx.packages.list()");
  expect(f.scripts[1]).toContain("dependency_tree(filename=ctx._kernel.app_metadata.filename)");
});

test.each(["install", "upgrade", "remove"] as const)("%s exact private adapter, notification source and metadata preservation", async action => {
  const f = fixture();
  const spec = 'example[extra]>=1; python_version >= "3.10"';
  const confirm = vi.fn(async (question: PackageConfirmation) => {
    expect(question.defaultChoice).toBe("cancel");
    expect(question.warning).toMatch(/shared/);
    expect(question.fingerprint).toMatchObject({ filename: "/fixture.py", pid: 123, manager: "fake", version: "0.25.0" });
    expect(question.fingerprint.executable.startsWith("/")).toBe(true);
    return true;
  });
  expect(await f.client.mutate(action, spec, confirm)).toEqual({ status: "succeeded" });
  expect(f.calls).toContainEqual(action === "remove" ? ["uninstall", spec] : ["install", spec, null, action === "upgrade"]);
  expect(f.calls).toContainEqual(["metadata", "/fixture.py", action === "remove" ? null : [spec], action === "remove" ? [spec] : null, action === "upgrade"]);
  expect(f.calls).toContainEqual(["operation", action === "remove" ? "remove" : "install", "kernel"]);
  expect(f.calls.filter(c => c[0] === "list")).toHaveLength(2);
});

test("cancellation has no implicit actions; untrusted requirements remain data", async () => {
  const f = fixture();
  expect(await f.client.mutate("install", "example", async () => false)).toEqual({ status: "cancelled" });
  expect(f.calls.filter(c => c[0] === "install")).toHaveLength(0);
  const spec = 'bad\"\n__import__("os").system("not a command")\n☃';
  await f.client.mutate("install", spec, async () => true);
  expect(f.calls).toContainEqual(["install", spec, null, false]);
});

test.each(["--no-config", "example --exclude-newer 0", "example -r requirements.txt", 'example "--no-config"'])("requirements cannot inject manager policy flags: %s", async spec => {
  const f = fixture();
  await expect(f.client.mutate("install", spec, async () => true)).rejects.toThrow(/command-line options/);
  expect(f.executeOnce).not.toHaveBeenCalled();
});

test.each([{ unavailable: true }, { version: "0.26.0" }, { missing_method: true }])("capability/version failures precede confirmation and mutation: %j", async config => {
  const f = fixture(); Object.assign(f.config, config);
  const confirm = vi.fn(async () => true);
  await expect(f.client.mutate("install", "example", confirm)).rejects.toThrow(/unavailable/);
  expect(confirm).not.toHaveBeenCalled();
  expect(f.calls.some(c => c[0] === "install")).toBe(false);
});

test.each(["pid", "filename", "version", "missing_method"])("fingerprint %s changed during confirmation fails before mutation", async key => {
  const f = fixture();
  await expect(f.client.mutate("upgrade", "example", async () => {
    f.config[key] = { pid: 456, filename: "/other.py", version: "0.26.0", missing_method: true }[key];
    return true;
  })).rejects.toThrow(/changed/);
  expect(f.calls.some(c => c[0] === "install")).toBe(false);
  expect(f.client.outcomeUnknown).toBe(false); // Explicit rejection was before any mutation.
});

test("filename is verified for read requests too", async () => {
  const f = fixture(); f.config.filename = "/other.py";
  await expect(f.client.list()).rejects.toThrow(/filename changed/);
  expect(f.calls).toEqual([]);
});

test.each(["metadata", "transport"])("possibly applied %s failure is unknown, reconciles without replay", async failure => {
  const f = fixture();
  if (failure === "metadata") f.config.metadata_error = true;
  else f.failTransport();
  await expect(f.client.mutate("install", "example", async () => true)).rejects.toThrow(/outcome unknown.*do not repeat/);
  expect(f.calls.filter(c => c[0] === "install")).toHaveLength(1);
  expect(f.options.reconcile).toHaveBeenCalledOnce();
  expect(f.client.outcomeUnknown).toBe(true);
  await expect(f.client.mutate("install", "example", async () => true)).rejects.toThrow(/unknown/);
  await f.client.reconcile();
  expect(f.client.outcomeUnknown).toBe(true); // A list alone is not proof of completion.
  f.notebook.apply("environment-operation", { operation_id: "new", source: "kernel", action: "install", packages: { example: "succeeded" }, status: { kind: "succeeded" } });
  await f.client.reconcile();
  expect(f.client.outcomeUnknown).toBe(false);
  expect(f.calls.filter(c => c[0] === "install")).toHaveLength(1);
});

test("restart-required and failed outcomes do not replay or write metadata", async () => {
  for (const status of ["restart-required", "failed"] as const) {
    const f = fixture(); f.config[status === "failed" ? "failed" : "restart"] = true;
    expect(await f.client.mutate("upgrade", "example", async () => true)).toEqual({ status });
    expect(f.calls.some(c => c[0] === "metadata")).toBe(false);
    expect(f.calls.filter(c => c[0] === "install")).toHaveLength(1);
  }
});

test("missing/stale/disconnected/busy sessions cannot submit requests", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.options.target.sessionId = ""; },
    (f: ReturnType<typeof fixture>) => { f.options.isCurrent = () => false; },
    (f: ReturnType<typeof fixture>) => { f.options.isConnected = () => false; },
    (f: ReturnType<typeof fixture>) => { f.notebook.cells.get("a")!.status = "running"; },
    (f: ReturnType<typeof fixture>) => { f.notebook.cells.get("a")!.status = "queued"; },
  ]) {
    const f = fixture(); change(f);
    await expect(f.client.list()).rejects.toThrow();
    await expect(f.client.mutate("install", "example", async () => true)).rejects.toThrow();
    expect(f.executeOnce).not.toHaveBeenCalled();
  }
});

test("session identity is checked after execution as well as before submission", async () => {
  const f = fixture();
  const execute = f.options.executeOnce;
  f.options.executeOnce = vi.fn(async (...args) => {
    const result = await execute(...args);
    f.options.isCurrent = () => false;
    return result;
  });
  await expect(f.client.list()).rejects.toThrow(/session changed/);
  expect(f.options.executeOnce).toHaveBeenCalledOnce();
});

test("session switched during confirmation cannot submit a mutation", async () => {
  const f = fixture();
  await expect(f.client.mutate("upgrade", "example", async () => {
    f.options.isCurrent = () => false;
    return true;
  })).rejects.toThrow(/session changed/);
  expect(f.scripts).toHaveLength(1);
  expect(f.calls.some(c => c[0] === "install")).toBe(false);
});

test("concurrent confirmations and streamed kernel operations block mutation, server source stays distinct", async () => {
  const f = fixture();
  let release!: (confirmed: boolean) => void;
  let entered!: () => void;
  const confirming = new Promise<void>(resolve => { entered = resolve; });
  const pending = f.client.mutate("install", "example", () => { entered(); return new Promise(resolve => { release = resolve; }); });
  await confirming;
  await expect(f.client.mutate("install", "other", async () => true)).rejects.toThrow(/active/);
  release(false); await pending;
  f.notebook.apply("environment-operation", { source: "kernel", operation_id: "x", action: "sync", status: { kind: "running" } });
  await expect(f.client.mutate("install", "other", async () => true)).rejects.toThrow(/active/);
  f.notebook.apply("environment-state", { source: "kernel", state: { operations: [], restart_required: false } });
  f.notebook.apply("environment-operation", { source: "server", operation_id: "x", action: "install", status: { kind: "running" } });
  expect(await f.client.mutate("install", "example", async () => false)).toEqual({ status: "cancelled" });
});

test("timeout after submission is unknown with exactly one write and no replay", async () => {
  const f = fixture();
  const execute = f.options.executeOnce;
  f.options.timeoutMs = 20;
  f.options.executeOnce = vi.fn((target, script, token, event, signal) => script.includes("success = await") ? new Promise(() => {}) : execute(target, script, token, event, signal));
  await expect(f.client.mutate("install", "example", async () => true)).rejects.toThrow(/outcome unknown/);
  expect(vi.mocked(f.options.executeOnce).mock.calls.filter(([, script]) => script.includes("success = await"))).toHaveLength(1);
});
