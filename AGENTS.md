# pi-marimo

Pi package for live marimo notebooks (npm: `pi-marimo`, repo `justmytwospence/pi-marimo`).

## Checks

- `npm ci`, then `npm run check`.
- Live e2e (needs `marimo` on PATH): `PI_MARIMO_LIVE_TEST=1 npx vitest run test/e2e.test.ts test/e2e-actions.test.ts`
- Demo: `uvx --with pandas,numpy,matplotlib,plotly marimo edit examples/coffee.py`

## Contract copies

These files are copies shared with Pi Plugins (`~/Projects/pi-plugins/packages/...`) and must stay byte-identical to the suite's copies (pill.ts and frame.ts differ only in the header sentence naming the other side). After changing either side, compare with `diff`:
- `src/activity.ts`: `packages/pi-bg/src/activity.ts` and three more copies.
- `src/pill.ts`, `src/frame.ts`: pi-bg.
- `src/config.ts`: pi-tool-gate and others.
- `src/editor-contract.ts`: pi-plan-mode, pi-compact-plan.

## Completion and rollout

Finishing a change means check, a conventional commit, and a push. Then set `git:github.com/justmytwospence/pi-marimo@<full sha>` in `~/Projects/dotfiles/home/private_dot_pi/private_agent/settings.managed.json`, commit and push only that. Then `chezmoi apply`, then `ssh spencer@nuc '~/.local/bin/chezmoi update --no-tty'`, and verify with `git -C ~/.pi/agent/git/github.com/justmytwospence/pi-marimo rev-parse HEAD` on both machines. Read `~/Projects/dotfiles/AGENTS.md` first.

## Releases

Bump `version` in `package.json` (and the lock with `npm install --package-lock-only --ignore-scripts`), add a `## <version>` section to `CHANGELOG.md`, commit, push, then `gh release create v<version> --title v<version> --notes-file <(awk '/^## <version>/{f=1;next} /^## /{f=0} f' CHANGELOG.md)`. The release workflow publishes to npm with provenance. Never `npm publish` by hand after 0.2.0.

## Remote clients

herdr-web-ui and Collie read the rows under the prompt and Pi dialogs; keep the row format `name:port · state` stable.
