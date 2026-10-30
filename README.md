# pi-marimo

[![npm](https://img.shields.io/npm/v/pi-marimo)](https://www.npmjs.com/package/pi-marimo) [![checks](https://github.com/justmytwospence/pi-marimo/actions/workflows/check.yml/badge.svg)](https://github.com/justmytwospence/pi-marimo/actions/workflows/check.yml)

**Live [marimo](https://marimo.io) notebooks inside [Pi](https://pi.dev).** Your agent edits the notebook; you watch it run, read it and steer it from the terminal, docked beside the chat. You need the browser much less.

What you get:

- **The notebook beside the chat.** `ctrl+'` docks a notebook view next to the conversation: an outline of sections and cells, and the selected cell's output, error and code.
- **Real outputs in the terminal.** Tables you can page, sort, search and filter. Matplotlib, Vega-Lite and live Plotly charts on Kitty-graphics terminals. Widgets you drive with keys or the mouse.
- **What runs, as it runs.** A spinner and elapsed time on the running cell, the queue, and errors with their tracebacks.
- **The agent knows the notebook.** Each prompt carries the notebook's current state (cells, what they define, what is stale or broken), so the agent does not have to go and look.
- **What the agent changed.** Cells it changed since your last message are marked, with a diff.

Cells are changed by the agent only, through the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill. What you do in the view (run, interrupt, set widgets, page tables) goes through marimo's own kernel endpoints, as the browser's buttons do.

## Install

```sh
pi install npm:pi-marimo
```

Or pin the repository: `pi install git:github.com/justmytwospence/pi-marimo@<commit>`.

You need:

- Pi in a terminal. Docking beside the chat needs `"tuiMode": "fullscreen"` in Pi's settings.
- Node 22 or later.
- marimo (verified with 0.25).
- For the agent to edit cells: the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill.

If you use [Pi Plugins](https://pi-plugins.vercel.app) pinned to a version from before pi-marimo left it, do not also install this package: Pi would load it twice.

## Quick start

1. Open a notebook from Pi: `/marimo new analysis.py`, or `/marimo edit analysis.py` for an existing one. Pi starts the marimo server if none is running. No browser needed.
2. Ask the agent to work in it: "load sales.csv and chart revenue by month".
3. Press `ctrl+'`. The notebook docks beside the chat and follows the running cell.
4. Press `ctrl+]` to switch between the chat and the notebook, and `?` in the notebook for every key.

A notebook you already have open in the browser (started with `marimo edit --no-token`) is followed automatically when it is under Pi's working directory.

## The notebook view

`ctrl+'` docks it beside the chat; `/marimo view` opens it full screen; `|` switches between the two.

The **outline** lists sections and cells. A cell is named by its name, or what it defines that other cells use, or what it shows (`imports`, `daily, smooth`, `chart`, `controls`); ids are never shown. A cell has a glyph only when it needs attention:

| glyph | |
|---|---|
| spinner | running, with its elapsed time on the right |
| `◌` | queued |
| `✗` | failed, or blocked by a failed ancestor |
| `•` | stale, or edited but not rerun |

At the end of each line is one badge: the error's type (`KeyError`), `changed` or `new` by the agent, else the output's shape (`450×4`, `chart`, `4 inputs`).

The **detail** shows the selected cell: rendered markdown, the output at full width, the error with its traceback, its widgets, and its code as a block on a grey background. Nothing is labeled; each part has a bar in its first column, and `n`/`p` move a focus bar between them. `O` stacks the whole section, the way the notebook reads in a browser.

From 100 columns the outline and detail sit side by side. Narrower, as when docked, they stack like a mail app: a few outline rows centered on the selected cell, the detail below.

### Essential keys

| key | |
|---|---|
| `j` / `k` | next / previous cell |
| `ctrl+j` / `ctrl+k` | next / previous section |
| `n` / `p` | next / previous part of the cell (error, printed output, output, widgets, code) |
| Enter | act on the focused part, else fold or open the code, or edit a markdown cell |
| `r` | run the cell (`R` stale cells, `A` all, each twice) |
| `x` twice | interrupt the kernel |
| `/` | find a cell: type, `ctrl+j`/`ctrl+k` through matches, Enter goes there |
| Tab / Shift+Tab | fold the section / fold all |
| `t` | drive the cell's table |
| `w` | drive the cell's widgets |
| `v` | the kernel's variables |
| `a` | ask the agent about this cell |
| `ctrl+]` | docked: switch between chat and notebook |
| `ctrl+'` | dock or close |
| Esc | back to the chat |

<details>
<summary>Every key</summary>

| key | |
|---|---|
| `j`/`k`, `↑`/`↓` | next or previous cell |
| `ctrl+j`/`ctrl+k`, `]`/`[` | next or previous section |
| `n`/`p` | next or previous part of the cell |
| `^D`/`^U`, PgDn/PgUp, Space | scroll the detail |
| `g`/`G` | first or last cell |
| Enter, `l` | act on the focused part: open a table, a live chart or the widgets, fold the code; with no part focused, fold or open the code, or edit a markdown cell |
| `O` | the whole section in the detail, or the cell alone |
| Tab (`z`) | fold or unfold the section |
| Shift+Tab (`Z`) | fold every section; again, unfold all |
| `e`/`E` | next or previous failed cell |
| `c`/`C` | next or previous cell the agent changed |
| `d` | the agent's change as a diff |
| `<` / `>` | a cell this one uses / one that uses it |
| `v` | variables: name, type, value, defining cell, uses (Enter goes to the cell, `>` to the first use) |
| `/` | find a cell or variable by name, variable, code or error; Enter goes there, Esc goes back |
| `f` | follow the running cell again |
| `r`, `R`, `A` | run the cell; stale cells; all cells (the last two need a second press) |
| `x` | twice: interrupt the kernel |
| `t` | drive the cell's table |
| `w` | drive the cell's widgets |
| `:` | run Python in the kernel's scratchpad |
| `a` | ask the agent about the cell |
| `m`, `M` | mark the cell for the agent through Lens; `M` twice removes the mark |
| `i` | drive a live chart from the keyboard |
| `o` | open the notebook in the browser |
| `S` | twice: stop the marimo server |
| `}` / `{` | next or previous notebook |
| `\|` | docked or full screen |
| `ctrl+]` | docked: switch focus between chat and notebook |
| `ctrl+'` | dock the notebook this session uses, or close the docked one |
| `?` | every key |
| Esc, `q`, `h` | back (docked: Esc goes to the chat, `q` closes) |

</details>

The mouse works too: the wheel scrolls the pane under it, a click selects a cell or part, a double click acts on it, and a click on the code folds or opens it.

### Docked beside the chat

The chat reflows into its half, so you keep typing while the notebook runs. The notebook takes 55% of the width; drag the divider to resize. A click in a half focuses it. While a Pi dialog is up, the split steps aside so the dialog has the full width.

The notebook also docks by itself, without taking focus, when the agent starts running its cells (`view.autoSplit`). It does not when you closed the split since your last message, or when [pi-sidebar](https://pi-plugins.vercel.app/plugins/pi-sidebar/) is open: they share the right-hand side, and opening one closes the other. With no notebook in use, `ctrl+'` stays pi-sidebar's key.

### Tables

`t` (or Enter on a table) drives a `mo.ui.table` through the table's own kernel functions, as the browser does, so paging, sorting, search and filters work on tables of any size. The grid shows frozen, hidden, justified and wrapped columns, data types and cell styles. Each table keeps its page, sort and filters until its cell reruns.

| key | |
|---|---|
| `h` `j` `k` `l` | move; past the page's edge the page turns |
| `]` `[`, `g` `G`, `+` `-` | next or previous page; first or last page; page size |
| `s`, `S` | sort by the column (off, ascending, descending); `S` adds a sort |
| `/` | search; empty clears |
| `f`, `F` | filter the column; clear all filters |
| Space | select the row or cell; the selection goes to the kernel, so cells reading it rerun |
| Enter, `i` | the row as a card; the column's statistics and top values |
| `c` | column summaries with sparklines |
| `y`, `Y` | copy the cell or the row (OSC 52) |
| `D` | save the table as CSV in Pi's working directory (never overwrites) |
| `r`, Esc | refresh; close the card, then leave |

Filters: `> 5`, `<= 2.5`, `1..10`, `in a, b`, `null`, `!null`, `~regex`, `^starts`, `ends$`, plain `text` (contains), and `!` in front negates.

### Widgets

Sliders, range sliders, numbers, dropdowns, radios, multiselects, checkboxes, switches, text, dates and buttons. With the keyboard: `w`, then `j`/`k` pick, `h`/`l` change (`H`/`L` ten steps), Space toggles or presses, Enter types a value, Esc is done. With the mouse: press on a slider's bar and drag; click a checkbox, switch, button, multiselect option, or a number's or choice's `‹` `›`; click text or a date to type it; the wheel steps the focused widget. Each change reaches the kernel as it does from the browser, so dependent cells rerun, and the agent's next context says what you set.

### Markdown

Markdown cells show as rendered markdown. Enter edits one in Pi's editor (vim keys when [pi-vim](https://pi-plugins.vercel.app/plugins/pi-vim/) is loaded); Enter saves, Esc cancels. The edit goes through marimo, so the browser shows it at once, and it is not counted as an agent change. Markdown built in Python (`mo.md(f"...")`) cannot be edited here; Enter shows its code instead.

### Charts

On terminals with Kitty graphics (Ghostty, Kitty, herdr) charts draw inline at the pane's full width:

- PNG figures (matplotlib, PIL) as they are.
- Vega-Lite and Altair, drawn with `uv run --with vl-convert-python` (needs `uv`).
- Plotly, live: hover for tooltips, drag to zoom or pan, the wheel zooms, and `i` drives it from the keyboard. Pi downloads a sandboxed headless Chrome for Testing once into `~/.cache/pi-marimo/chrome`; it never uses your own Chrome. `"liveCharts": false` draws pictures instead.

`/marimo chart <cell>` puts a cell's chart into the chat; the agent can do the same with its `marimo_chart` tool.

### Pairing with the agent

- **Ask (`a`).** A prompt docks at the bottom of the view. Your message goes to the agent with the notebook, cell and section you were looking at, and with the marimo-pair flags for the notebook. While the agent works it goes in as a follow-up.
- **The agent's changes.** Cells changed since your last message are marked `changed` or `new`, counted in the header, and removed cells are listed. `c`/`C` jump to them and `d` shows the diff. They clear with your next prompt.
- **Scratchpad (`:`).** Run Python against the notebook's globals without changing a cell; what it prints streams above the prompt.
- **Lens marks (`m`).** With [marimo-lens](https://marimo-team.github.io/marimo-lens/) in the notebook, `m` marks the cell with a note, as pointing at it in the browser does; the agent's Lens skill reads it.

## Rows under the prompt

Every notebook this session uses is a row under Pi's prompt:

```text
 prep.py:2718 · idle
 ● fit.py:2718 · running Data loading › Model fit 0:12 · 2 queued
```

`↓` at the bottom of the prompt selects them; Enter opens the notebook, `x` twice interrupts it. A row shows `✗` after a run broke cells, until your next message. Outside the TUI (RPC, print) the same appears as footer lines under the status keys `marimo`, `marimo-2`, and so on.

## What the agent sees

When you send a prompt, pi-marimo places the state of the notebooks this session uses right after it, for every model request of that turn:

- the current notebook in full: its headings, one line per code cell with what it defines, and what needs attention (running, queued, errors, stale, edited, changed in the browser, widgets you set);
- every other notebook the agent worked in during the last three prompts, also in full; the rest as short outlines;
- each notebook's `marimo-pair --url … --file …` flags, and open Lens selections.

The block is never stored in the session and stays in the same place during the turn, so it does not invalidate the model's thinking. `/marimo show` prints it; `"context": false` turns it off.

## `/marimo`

| command | |
|---|---|
| `/marimo` | pick which open notebooks to follow, or Auto or Off |
| `/marimo new <file.py>` | create a notebook, start it and open it |
| `/marimo edit [file]` | open a notebook, starting its server when none serves it |
| `/marimo view [file]` | the busiest notebook, or the one named, full screen (docked with `view.split`) |
| `/marimo split [file]` | dock the busiest notebook, or the one named; again with no file, close it |
| `/marimo stop [file]` | stop a server Pi started |
| `/marimo open` | open a notebook that waits in no browser, in the browser |
| `/marimo auto`, `/marimo off` | follow every notebook under the working directory (default); follow none |
| `/marimo show` | print what the agent sees |
| `/marimo lens` | open and recently addressed Lens selections |
| `/marimo chart <cell>`, `/marimo inspect` | a cell's chart in the chat; drive the newest one |

A server Pi starts keeps running across `/reload` and stops when Pi exits, with `/marimo stop`, or with `S` twice in its view.

## Configuration

`marimo.json`, merged in this order: `~/.config/agents/marimo.json`, `~/.pi/agent/marimo.json`, then the project's `.agents/marimo.json` and `.pi/marimo.json`.

```json
{
  "maxNotebooks": 8,
  "context": true,
  "liveCharts": true,
  "view": { "code": "open", "outputs": false, "split": false, "autoSplit": true },
  "server": { "command": [] }
}
```

| key | default | |
|---|---|---|
| `maxNotebooks` | `8` | notebooks followed at once in auto mode (1 to 32) |
| `context` | `true` | put the notebooks' state in the agent's context |
| `liveCharts` | `true` | run Plotly charts live; `false` draws pictures |
| `view.code` | `"open"` | cells' code open, or `"folded"` to its first line |
| `view.outputs` | `false` | start with the whole section in the detail |
| `view.split` | `false` | open the view docked instead of full screen |
| `view.autoSplit` | `true` | dock a notebook when the agent starts running it |
| `server.command` | `[]` | how Pi starts marimo; empty means `uv run marimo` in a uv project, else `marimo` |

`MARIMO_TOKEN` is sent to token-protected servers.

## Troubleshooting

- **A notebook does not show up.** pi-marimo finds servers through marimo's registry, which only servers started with `--no-token` write to. It follows notebooks under Pi's working directory, not in hidden directories or other Git repositories below it. Start it with `/marimo edit`, or pin it with `/marimo`.
- **Charts are blank.** You need a terminal with Kitty graphics. In herdr, set `experimental.kitty_graphics = true` and open a new pane.
- **`ctrl+'` does nothing.** Your terminal has to report the key (the kitty keyboard protocol does). `/marimo split` does the same.
- **"read-only" or 403 when running cells.** The browser tab that opened the notebook has closed. pi-marimo opens the notebook itself and retries, so this should not reach you; if it does, run `/marimo edit <file>`.
- **The agent edits the wrong notebook.** Several notebooks on one server: the context gives each one's marimo-pair flags, and pi-marimo warns on calls that could mean more than one.

## Integrations

Each is optional and talks over Pi's event bus. Without the other package nothing changes.

- [pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/): notebooks are listed in `/tasks`, and `bg_wait` can wait on `marimo:<path>` until the notebook's cells finish. A marimo server pi-bg runs is shown with its notebook's state, and stopping a marimo-pair job interrupts the cells it started.
- [pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/): the notebook rows join its panel under the prompt.
- [pi-sidebar](https://pi-plugins.vercel.app/plugins/pi-sidebar/): shares the right-hand side.
- [pi-status-footer](https://pi-plugins.vercel.app/plugins/pi-status-footer/): notebook rows in the footer.
- [pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/): in a [Herdr](https://herdr.dev) pane, a notebook still running after the turn ends shows in the `$marimo` pane token, with a notification when it finishes.
- [pi-next-prompt](https://pi-plugins.vercel.app/plugins/pi-next-prompt/): a new Lens selection offers "Use Lens to address S1" as the next prompt.
- [pi-vim](https://pi-plugins.vercel.app/plugins/pi-vim/): vim keys in the view's prompts.

## How it works

pi-marimo subscribes to each notebook session's message stream (`/sse`) as a read-only kiosk viewer, so it never takes the notebook over from your browser. marimo replays the session on connect; after that pi-marimo receives every cell's code, status, output and errors, the dataflow graph and the variable values. Actions from the view are separate requests to marimo's kernel endpoints, sent through Pi's own session when the browser's is gone. Servers are found through marimo's registry (`$XDG_STATE_HOME/marimo/servers`) and each server's `/api/sessions`.

Limits:

- The view never edits code cells; only the agent does, through marimo-pair. It does edit markdown cells.
- Widget values changed in a browser show in the view after a reconnect.
- "Changed by the agent" means any code-mode change; marimo cannot tell agents apart.
- The rows and the view exist only in Pi's terminal UI.

## Development

```sh
npm ci && npm run check
```

- Live tests (need `marimo` on PATH): `PI_MARIMO_LIVE_TEST=1 npx vitest run test/e2e.test.ts test/e2e-actions.test.ts`
- The demo notebook: `uvx --with pandas,numpy,matplotlib,plotly marimo edit examples/coffee.py`
- Releases and rollout: `AGENTS.md`.

## License

MIT. See [LICENSE](./LICENSE).
