# pi-marimo

Pi package for live marimo notebooks (npm: `pi-marimo`, repo `justmytwospence/pi-marimo`).

## Checks

- `npm ci`, then `npm run check`.
- Live e2e (needs `marimo` on PATH): `PI_MARIMO_LIVE_TEST=1 npx vitest run test/e2e.test.ts test/e2e-actions.test.ts`
- Demo: `uvx --with pandas,numpy,matplotlib,plotly,altair,vl-convert-python,rich,tqdm,marimo-lens marimo edit --no-token examples/coffee.py`

## Browser-free pairing

With pi-marimo active, open an existing notebook via `/marimo edit <file>`: it reuses a running server or starts one, connects a headless kernel session and opens the Pi view without a browser. Discover and reuse the server before starting another, especially for the coffee demo with its `uvx --with ...` dependencies. A marimo-pair `execute-code.sh --url URL --file FILE` call to a waiting server also makes pi-marimo attach without a browser; use the exact notebook file when multiple are available. The pinned marimo-pair skill's instruction to wait for a browser applies only without pi-marimo's headless-session support. Suggest a browser only if headless attachment fails, never as a prerequisite.

## Contract copies

These files are copies shared with Pi Plugins (`~/Projects/pi-plugins/packages/...`) and must stay byte-identical to the suite's copies (pill.ts and frame.ts differ only in the header sentence naming the other side). After changing either side, compare with `diff`:
- `src/activity.ts`: `packages/pi-bg/src/activity.ts` and three more copies.
- `src/pill.ts`, `src/frame.ts`: pi-bg.
- `src/config.ts`: pi-tool-gate and others.
- `src/editor-contract.ts`: pi-plan-mode, pi-compact-plan.

## Completion and rollout

Finishing a change means check, a conventional commit, and a push. Then cut a rollout tag: bump the patch `version` (package.json + lock as in Releases), rename `## Unreleased` in `CHANGELOG.md` to `## <version>` (with a fresh `## Unreleased` above it), commit `chore: release <version>`, `git tag v<version>`, `git push origin main v<version>`. Then, in a dotfiles worktree, set `git:github.com/justmytwospence/pi-marimo@v<version>` in `~/Projects/dotfiles/home/private_dot_pi/private_agent/settings.managed.json` and its commit (`git rev-parse v<version>^{commit}`) in `home/.chezmoidata/pi_tag_commits.json`, commit only those, and `bin/land` (it applies and syncs the NUC). Verify with `git -C ~/.pi/agent/git/github.com/justmytwospence/pi-marimo rev-parse HEAD` equal to the tag's commit on both machines. Read `~/Projects/dotfiles/AGENTS.md` first.

## Releases

Bump `version` in `package.json` (and the lock with `npm install --package-lock-only --ignore-scripts`), add a `## <version>` section to `CHANGELOG.md`, commit, push, then `gh release create v<version> --title v<version> --notes-file <(awk '/^## <version>/{f=1;next} /^## /{f=0} f' CHANGELOG.md)`. The release workflow publishes to npm with provenance. Never `npm publish` by hand after 0.2.0. A rollout tag is a plain `git tag`; it does not publish. To publish an already-tagged version, run the `gh release create v<version> ...` command above, which reuses the existing tag.

## Remote clients

herdr-web-ui and Collie read the rows under the prompt and Pi dialogs; keep the row format `name:port · state` stable.
