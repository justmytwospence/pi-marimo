# pi-marimo

Pi package for live marimo notebooks (npm: `pi-marimo`, repo `justmytwospence/pi-marimo`).

## Checks

- `npm ci`, then `npm run check`.
- Live e2e (needs `marimo` on PATH): `PI_MARIMO_LIVE_TEST=1 npx vitest run test/e2e.test.ts test/e2e-actions.test.ts test/e2e-host.test.ts`
- Live against marimo main (host protocol): `PI_MARIMO_LIVE_TEST=1 PI_MARIMO_LIVE_MARIMO="uvx --from git+https://github.com/marimo-team/marimo@main marimo" npx vitest run test/e2e-host.test.ts`
- Docs: `npm run docs:build` (strict). `docs/reference/keys.md` is generated: after changing `src/ui/keys.ts`, run `UPDATE_DOCS=1 npx vitest run test/docs.test.ts`.
- Testing notebook: `uvx --with pandas,numpy,matplotlib,plotly,altair,vl-convert-python,rich,tqdm,marimo-lens marimo edit --no-token examples/testing.py`
- Demo video: `npm run demo` (see docs/development.md).

## Browser-free pairing

With pi-marimo active, open an existing notebook via `/marimo edit <file>`: it reuses a running server or starts one, connects a headless kernel session and opens the Pi view without a browser. Discover and reuse the server before starting another, especially for the testing notebook with its `uvx --with ...` dependencies. A marimo-pair `execute-code.sh --url URL --file FILE` call to a waiting server also makes pi-marimo attach without a browser; use the exact notebook file when multiple are available. The pinned marimo-pair skill's instruction to wait for a browser applies only without pi-marimo's headless-session support. Suggest a browser only if headless attachment fails, never as a prerequisite.

## Contract copies

These files are copies shared with Pi Plugins (`~/Projects/pi-plugins/packages/...`) and must stay byte-identical to the suite's copies (pill.ts and frame.ts differ only in the header sentence naming the other side). After changing either side, compare with `diff`:
- `src/activity.ts`: `packages/pi-bg/src/activity.ts` and three more copies.
- `src/pill.ts`, `src/frame.ts`: pi-bg.
- `src/config.ts`: pi-tool-gate and others.
- `src/editor-contract.ts`: pi-plan-mode, pi-compact-plan.

## Developing in Pi

Test changes in the Pi session that makes them, before any release. A project `.pi/settings.json` (kept out of Git through `.git/info/exclude`) turns off the installed package and loads this checkout:

```json
{ "packages": [{ "source": "npm:pi-marimo", "extensions": [] }, "../"] }
```

Pi identifies an npm package by its name, and a project entry replaces the personal one, so a session started in this repo or one of its worktrees runs that checkout's code. `/reload` picks up edits; nothing needs committing, releasing or deploying first. A new worktree needs its own copy of the file. When the global pin's source changes (for example from `git:` to `npm:`), change `source` here to match, or both copies load.

## Completion and rollout

Finishing a change means check, a conventional commit, and a push. Rolling it out means a release (below), then pinning it: in a dotfiles worktree, set `npm:pi-marimo@<version>` in `~/Projects/dotfiles/home/private_dot_pi/private_agent/settings.managed.json`, add `"pi-marimo@<version>"` to `cooldownAllow` in `home/.chezmoidata/cooldown.json` (a release younger than seven days is otherwise held back), commit only those, and `bin/land` (it applies and syncs the NUC). Verify with `grep '"version"' ~/.pi/agent/npm/node_modules/pi-marimo/package.json` on both machines. Read `~/Projects/dotfiles/AGENTS.md` first.

## Releases

Bump `version` in `package.json` (and the lock with `npm install --package-lock-only --ignore-scripts`), rename `## Unreleased` in `CHANGELOG.md` to `## <version>` (with a fresh `## Unreleased` above it when there is more to come), commit `chore: release <version>`, push, then `gh release create v<version> --title v<version> --notes-file <(awk '/^## <version>/{f=1;next} /^## /{f=0} f' CHANGELOG.md)`. Publishing the release runs `.github/workflows/release.yml`, which checks, verifies the tag names the version and publishes to npm with provenance through npm trusted publishing (OIDC; no token). The trusted publisher is configured on npmjs.com under pi-marimo's settings: GitHub Actions, repository `justmytwospence/pi-marimo`, workflow `release.yml`. If the publish step fails with a 404, that configuration is missing or wrong: fix it there and rerun the workflow (`gh run rerun <id>`); the workflow skips a version already on npm. Never `npm publish` by hand (0.3.0, the first npm release, was the one exception, made to create the package).

## Remote clients

herdr-web-ui and Collie read the rows under the prompt and Pi dialogs; keep the row format `name:port · state` stable.
