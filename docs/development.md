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

`npm run demo` records `docs/assets/demo.mp4` and `docs/assets/demo.gif` with [foley](https://github.com/GH-Jaider/foley), which renders the tape (`demo/demo.tape`) headlessly, Kitty graphics included. It needs `pi`, `uvx`, `ffmpeg`, `ffprobe`, `curl` and `node` on PATH, on macOS or Linux, and downloads a checksummed foley 0.1.0 into `~/.cache/pi-marimo/`.

The model is scripted (`demo/scripted-model.ts`, Pi's faux provider); the notebook (`examples/demo.py`), its kernel and pi-marimo are real. `demo/annotate.py` draws captions (`demo/captions.json`) above the window and shortcut keys below it, in Inter (downloaded, checksummed). `demo/captions.ts` writes an invisible marker into the take's asciicast for every key Pi receives, and the script matches them in order to the tape's keys: an Insert pressed inside `Hide`/`Show` starts the next caption, and a command after a `# demo: show <keys>` line shows `<keys>` as keycaps. Typing that is not marked (commands, cell names, the prompt) never shows. A take fails, leaving `docs/assets` untouched, when its final screen differs from `demo/expected.txt` or shows an error. After an intended change, run `UPDATE_EXPECTED=1 npm run demo`, review the beat screenshots it prints, and commit `demo/expected.txt` with the assets.

Tape rules:

- No Ctrl or Alt chords: foley 0.1.0 cannot send them to Pi once Pi enables the Kitty keyboard protocol (Alt arrives as the bare key).
- Select cells with `/name` then Enter; where the cursor lands after a run depends on timing.
- Slash commands need Enter twice: the first accepts the completion.
- Keep `yield_ms: 0` in scripted executions, so every take takes the same path.
