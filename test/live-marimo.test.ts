import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { liveMarimoFixture, marimoEnabled } from "./live-marimo.js";

const fake = fileURLToPath(new URL("./fixtures/fake-live-marimo.mjs", import.meta.url));
const fixtureFor = (mode: string) => liveMarimoFixture([process.execPath, fake, mode]);
const posixTest = test.skipIf(process.platform === "win32");

afterEach(() => { vi.unstubAllEnvs(); });

test("live tests are opt-in", () => {
  vi.stubEnv("PI_MARIMO_LIVE_TEST", "0");
  vi.stubEnv("PI_MARIMO_LIVE_MARIMO", "/definitely/missing/marimo");
  expect(marimoEnabled()).toBe(false);
});

posixTest("an opted-in missing executable fails rather than skipping", async () => {
  vi.stubEnv("PI_MARIMO_LIVE_TEST", "1");
  vi.stubEnv("PI_MARIMO_LIVE_MARIMO", "/definitely/missing/marimo");
  expect(marimoEnabled()).toBe(true);
  const fixture = liveMarimoFixture();
  await expect(fixture.start(fixture.dir)).rejects.toThrow(/live marimo waiting.*could not run .* ENOENT/);
});

posixTest("HTTP, a registered session, and kernel readiness are distinct phases", async () => {
  const fixture = fixtureFor("gated");
  const file = join(fixture.dir, "fixture.py");
  writeFileSync(file, "# synthetic path, not a notebook\n");
  const marker = (name: string) => join(fixture.dir, name);
  let listening = false;
  const start = fixture.start(file, 10_000).then((url) => { listening = true; return url; });
  await expect.poll(() => existsSync(marker("server"))).toBe(true);
  expect((await fetch(`${fixture.url}/health`)).ok).toBe(true);
  expect(listening).toBe(false);
  writeFileSync(marker("register-server"), "");
  await start;

  let opened = false;
  const session = fixture.openBrowser(file, "browser").then(() => { opened = true; });
  await expect.poll(() => existsSync(marker("stream-open"))).toBe(true);
  writeFileSync(marker("register-session"), "");
  await expect.poll(async () => Object.keys(await (await fetch(`${fixture.url}/api/sessions`)).json())).toEqual(["browser"]);
  expect(opened).toBe(false);
  writeFileSync(marker("kernel-ready"), "");
  await session;
  fixture.watch();
  const followed = await fixture.follow(file, "browser");
  expect(followed.notebook.ordered().map((cell) => cell.code)).toEqual(["x = 1"]);
});

posixTest("early exit includes only the bounded stderr tail", async () => {
  const fixture = fixtureFor("early-exit");
  const error = await fixture.start(fixture.dir, 10_000).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toMatch(/exit 3[\s\S]*last line from marimo/);
  expect(message).not.toContain("start-of-stderr");
  expect(message.length).toBeLessThan(4300);
});

posixTest("an HTTP server without a registry entry times out with stderr", async () => {
  const fixture = fixtureFor("gated");
  await expect(fixture.start(fixture.dir, 1000)).rejects.toThrow(/HTTP and server registry: readiness timed out[\s\S]*fixture listening/);
  expect((await fetch(`${fixture.url}/health`)).ok).toBe(true);
});

posixTest("a ready kernel without the exact session registration times out", async () => {
  const fixture = fixtureFor("gated");
  const file = join(fixture.dir, "fixture.py");
  writeFileSync(join(fixture.dir, "register-server"), "");
  writeFileSync(join(fixture.dir, "kernel-ready"), "");
  await fixture.start(file, 1500);
  await expect(fixture.openBrowser(file, "unregistered")).rejects.toThrow(/file\/session registration.*readiness timed out/);
  expect(existsSync(join(fixture.dir, "kernel-sent"))).toBe(true);
});

posixTest("disposal closes streams and owned server and pair children, leaving another fixture alone", async () => {
  const fixture = fixtureFor("wrapped");
  const other = fixtureFor("registered");
  const file = join(fixture.dir, "fixture.py");
  const [url, otherUrl] = await Promise.all([fixture.start(file), other.start(other.dir)]);
  const { pid } = JSON.parse(readFileSync(join(fixture.dir, "server"), "utf8")) as { pid: number };
  await fixture.openBrowser(file, "browser");
  const watcher = fixture.watch();
  await fixture.follow(file, "browser");
  await expect(fixture.runPair("not-registered", "pass")).rejects.toThrow(/no stable session id for not-registered/);
  const pair = fixture.runPair("browser", "pass").catch((error: Error) => error);
  const pairFile = join(fixture.dir, "pair");
  await expect.poll(() => existsSync(pairFile)).toBe(true);
  const pairPid = Number(readFileSync(pairFile, "utf8"));

  const dispose = fixture.dispose();
  expect(fixture.dispose()).toBe(dispose);
  await dispose;
  expect(fixture.signal.aborted).toBe(true);
  expect(watcher.followed()).toEqual([]);
  expect(existsSync(fixture.dir)).toBe(false);
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  expect(() => process.kill(pairPid, 0)).toThrow(/ESRCH/);
  expect(await pair).toMatchObject({ message: expect.stringContaining("pair execute failed: signal SIGTERM") });
  await expect(fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  expect((await fetch(`${otherUrl}/health`, { signal: AbortSignal.timeout(1000) })).ok).toBe(true);
});
