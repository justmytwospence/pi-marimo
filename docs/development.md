# Development

```sh
npm ci && npm run check
```

- Live tests (need `marimo` on PATH): `PI_MARIMO_LIVE_TEST=1 npx vitest run test/e2e.test.ts test/e2e-actions.test.ts test/e2e-host.test.ts`.
- Against marimo main: `PI_MARIMO_LIVE_TEST=1 PI_MARIMO_LIVE_MARIMO="uvx --from git+https://github.com/marimo-team/marimo@main marimo" npx vitest run test/e2e-host.test.ts`.
- The documentation: `npm run docs` serves it, `npm run docs:build` builds it strictly. [`reference/keys.md`](reference/keys.md) is generated from `src/ui/keys.ts`: after changing a key, run `UPDATE_DOCS=1 npx vitest run test/docs.test.ts`.
- The testing notebook, every surface the view draws: `uvx --with pandas,numpy,matplotlib,plotly,altair,vl-convert-python,rich,tqdm,marimo-lens marimo edit --no-token examples/testing.py`. If it is already running, `/marimo edit examples/testing.py` opens its Pi view using that server.
- To try changes in Pi before releasing them, add a project `.pi/settings.json` to the checkout that turns off the installed package and loads the checkout, then start Pi there and `/reload` after edits:

  ```json
  { "packages": [{ "source": "npm:pi-marimo", "extensions": [] }, "../"] }
  ```

Table design references (interaction ideas, not copied implementations): [Textual DataTable](https://textual.textualize.io/widgets/data_table/) for pinned headers and focus, [Harlequin](https://harlequin.sh/docs/bindings) for column navigation and full values, [VisiData](https://www.visidata.org/docs/columns/) for sizing and feedback, and [Ratatui table](https://ratatui.rs/examples/apps/table/) for position indicators.

## Recording the demo

Charts use Kitty graphics, which VHS and asciinema cannot record, so record the real terminal.

1. Ghostty, 140x40, dark theme, a fresh `pi` in a scratch copy of `examples/`.
2. Script: `/marimo edit quickstart.py`; `ctrl+'` docks; prompt "add a weekday vs weekend comparison chart"; watch the spinner and the run chain (`@`); `c` jumps to the agent's change, `d` shows the diff, `u` reverts; `w` drives the slider and the chart updates; `t` pages and sorts the table, Space selects rows; on marimo main, show "Pi" in the browser footer and send a message from the notebook.
3. Record with macOS screen recording, then `ffmpeg -i demo.mov -vf "fps=15,scale=1280:-1" docs/assets/demo.mp4`.
