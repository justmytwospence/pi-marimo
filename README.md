# pi-marimo

[![npm](https://img.shields.io/npm/v/pi-marimo)](https://www.npmjs.com/package/pi-marimo) [![checks](https://github.com/justmytwospence/pi-marimo/actions/workflows/check.yml/badge.svg)](https://github.com/justmytwospence/pi-marimo/actions/workflows/check.yml)

**Live [marimo](https://marimo.io) notebooks inside [Pi](https://pi.dev).** Your agent edits the notebook; you watch it run, read it and steer it from the terminal, docked beside the chat. You need the browser much less.

What you get:

- **The notebook beside the chat.** `ctrl+'` docks a notebook view next to the conversation: an outline of sections and cells, and the selected cell's output, error and code.
- **Real outputs in the terminal.** Tables you can page, sort, search and filter. Matplotlib, Vega-Lite and live Plotly charts on Kitty-graphics terminals. Widgets you drive with keys or the mouse.
- **What runs, as it runs.** A spinner and elapsed time on the running cell, the queue, and errors with their tracebacks.
- **Chat while a fit runs.** Native background supervision of the official `marimo pair execute` CLI, with completion subscriptions that resume Pi without blocking the conversation or requiring another extension.
- **The agent knows the notebook.** Each prompt carries the notebook's current state (cells, what they define, what is stale or broken), so the agent does not have to go and look.
- **What the agent changed.** Cells it changed since your last message are marked, with a diff.

The agent edits through the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill; you can also edit cells in place with embedded Neovim. View actions go through marimo's session and kernel endpoints.

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
- For inline editing: Neovim 0.10 or later, available as `nvim` or configured with `view.editor.command`.

If you use [Pi Plugins](https://pi-plugins.vercel.app) pinned to a version from before pi-marimo left it, do not also install this package: Pi would load it twice.

## Quick start

1. Open a notebook from Pi: `/marimo new analysis.py`, or `/marimo edit analysis.py` for an existing one. Pi starts the marimo server if none is running. No browser needed.
2. Ask the agent to work in it: "load sales.csv and chart revenue by month".
3. Press `ctrl+'`. The notebook docks beside the chat and follows the running cell.
4. Press `ctrl+]` to switch between the chat and the notebook, and `?` in the notebook for every key.

A notebook you already have open in the browser (started with `marimo edit --no-token`) is followed automatically when it is under Pi's working directory. A server with no browser session is reusable too: `/marimo edit <file>` opens its notebook in Pi without starting another server. A marimo-pair call to that server attaches a headless session without a browser; pass `--url` and `--file` to target the right notebook.

## The notebook view

`ctrl+'` docks it beside the chat; `/marimo view` opens it full screen; `|` switches between the two. One key press toggles once: held repeats and release do nothing. With pi-sidebar installed, an already-open Sidebar keeps the key; otherwise an eligible notebook takes it before Sidebar, regardless of extension load order. `/sidebar` explicitly opens Sidebar.

The **outline** lists sections and cells. A cell is named by its name, or what it defines that other cells use, or what it shows (`imports`, `daily, smooth`, `chart`, `controls`); ids are never shown. A cell has a glyph only when it needs attention:

| glyph | |
|---|---|
| spinner | running, with its elapsed time on the right |
| `◌` | queued |
| `✗` | failed, or blocked by a failed ancestor |
| `•` | stale, or edited but not rerun |

Status chips can show execution state and agent changes together. With a Nerd Font, their icons distinguish ` wait` (queued), ` err` (error), ` block` (failed ancestor), ` old` (stale), ` edit` (edited, not rerun), ` agent` (changed by the agent), ` new` (agent-created) and ` off` (disabled). Short labels remain readable without a Nerd Font; the detail retains complete error messages. The **detail** shows Markdown, output, diagnostics, widgets and source without redundant type captions; `n`/`p` move between parts, with a small `▸` marking the focused part. The layout uses whitespace instead of decorative rules. Source sits in a padded, full-width panel. `O` stacks the whole section, with Python source open by default. `B` folds only the selected cell to a source preview; each cell’s choice survives navigation, switching views and docking. Prose uses the available width. Expanded source and fenced code retain every line and scroll horizontally rather than wrapping or truncating; `H`/`L` scroll the focused block, `0` resets it, and `#` toggles line numbers. `B` folds or unfolds source.

Mermaid fences and `mo.mermaid` render as diagrams when image support is available. If rendering or images are unavailable, the view explains why and shows the complete diagram source; `s` switches a focused diagram to or from source.

From 100 columns the outline and detail sit side by side. Narrower, as when docked, they stack like a mail app: a few outline rows centered on the selected cell, the detail below.

### Essential keys

| key | |
|---|---|
| `j` / `k` | next / previous cell |
| `ctrl+d` / `ctrl+u` | next / previous section |
| `n` / `p` | next / previous part of the cell (error, printed output, output, widgets, code) |
| Enter, `b` | act on the focused part, or edit source/Markdown in place |
| `B`, `H`/`L`, `0`, `#` | fold code; scroll left/right; reset horizontal scroll; toggle line numbers |
| `!`, `\` | cycle diagnostics; toggle output independently |
| `r` | run the cell (`R` stale cells, `A` all, each twice) |
| `x` twice | interrupt the kernel |
| `/` | find a cell: type, `ctrl+d`/`ctrl+u` or arrows through matches, Enter goes there |
| Tab / Shift+Tab | fold the section / fold all |
| `t` | drive the cell's table |
| `w` | drive the cell's widgets |
| `v`, `P` | the kernel's variables; packages |
| `ctrl+p` | fuzzy command palette for actions available in this view |
| `a` | ask the agent about this cell |
| `ctrl+]` | docked: switch between chat and notebook |
| `ctrl+'` | dock or close |
| Esc | back to the chat |

The `?` cheat sheet shows all categories. On a wide view, click a category in its left rail; Tab/Shift+Tab move between categories at any width. When every command in the category fits, `j`/`k` and the arrows also move between categories; when it overflows, they scroll its commands. Reopening help returns to the last category and scroll position; a search is cleared. To open the actual Variables or Packages view, close help with `?` or Esc, then press `v` or capital `P` (Shift+P) in the notebook.

With the notebook focused, `ctrl+p` opens a compact floating command palette within the notebook pane, keeping the surrounding notebook visible. Type to fuzzy-search the available actions by name, group, description or shortcut; arrows or Tab select a result, Ctrl+N / Ctrl+J move down, and Ctrl+P / Ctrl+K move up. Plain `j`/`k` remain search text. Enter or a click runs the selection; Esc or a click outside the palette cancels. Running all cells, interrupting, stopping a server and changing packages retain their normal confirmations; selecting one does not bypass them. Low-level widget/chart motions and file export are not palette actions. With Pi chat focused, `ctrl+p` still cycles models.

<details>
<summary>Every key</summary>

| key | |
|---|---|
| `j`/`k`, `↑`/`↓` | next or previous cell |
| `ctrl+d`/`ctrl+u`, `]`/`[` | next or previous section |
| `n`/`p` | next or previous part of the cell |
| PgDn/PgUp, Space | scroll the detail |
| `g`/`G` | first or last cell |
| Enter, `l` | act on the focused part; on source or editable Markdown, edit in place |
| `b`, `B` | edit source; fold or unfold code |
| `H`/`L`, `0`, `#`, F7 | scroll focused code left/right; reset; toggle line numbers |
| `!`, `\` | cycle diagnostics; toggle output |
| `s`, `T` | toggle focused diagram source; exact run timing |
| `O` | the whole section in the detail, or the cell alone |
| Tab (`z`) | fold or unfold the section |
| Shift+Tab (`Z`) | fold every section; again, unfold all |
| `e`/`E` | next or previous failed cell |
| `c`/`C` | next or previous cell the agent changed |
| `d` | the agent's change as a diff |
| `<` / `>` | a cell this one uses / one that uses it |
| `v`, `P` | variables; packages |
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
| `?` | searchable, scrollable context-aware help |
| F8 | read the full transient message |
| Esc, `q`, `h` | back (docked: Esc goes to the chat, `q` closes) |

</details>

The mouse works too: the wheel scrolls the pane under it, a click selects a cell or part, and a double click acts on it. Help starts in the current mode, with aligned keys and actions and a category rail when there is room. `j`/`k` and ↑/↓ scroll one row when a category overflows; when it fits they select the adjacent category (stopping at the ends). PgUp/PgDn, `g`/`G` and the wheel scroll; `/` searches keys, actions and descriptions across categories; Tab/Shift+Tab wraps through categories; Esc clears search then closes, and `?` or F1 closes when not typing. The footer prioritizes the contextual action, `? help`, nondefault visibility (`! errors`/`! warnings`/`! hidden`, `\ output off`), then `O cell`/`O section` and position. With room left, it adds `! diagnostics`, `\ output` and `# lines` (`# lines on` when enabled). Hints are always whole; a longer hint that does not fit can yield to a shorter one. Editor, widget, prompt and help footers keep their own context-specific controls.

Transient messages preview in up to three rows, reserving four body rows when possible. When there is room, an overflowing preview shows `F8 more` and the number of hidden lines; F8 opens the full captured message in a read-only view. Scroll with `j`/`k` or arrows, PgUp/PgDn, `g`/`G` or Home/End, or the mouse wheel; Esc or F8 returns to the prior view and scroll position. Editor and prompt drafts are retained, and ordinary keys keep their normal behavior outside the message view.

### Docked beside the chat

The chat reflows into its half, so you keep typing while the notebook runs. The notebook takes 55% of the width; drag the divider to resize. A click in a half focuses it. While a Pi dialog is up, the split steps aside so the dialog has the full width.

The notebook also docks by itself, without taking focus, when the agent starts running its cells (`view.autoSplit`). It does not when you closed the split since your last message, or when [pi-sidebar](https://pi-plugins.vercel.app/plugins/pi-sidebar/) is open: they share the right-hand side, and opening one closes the other. With no notebook in use, `ctrl+'` stays pi-sidebar's key.

### Tables

`t` (or Enter on a table cell) drives a `mo.ui.table` through the table's own kernel functions, as the browser does, so paging, sorting, search and filters work on tables of any size. The table fills the detail pane with a pinned header and page-local scrollbar, a focused cell distinct from selected rows/cells, frozen columns, readable types, explicit nulls and full-value inspection. Click a cell to focus its row and column; click a header to sort (Shift-click adds a sort), or wheel through loaded rows. A static table without a live object id remains a preview, not a fake remote table. Each live table keeps its page, sort, filters and column widths until its cell reruns.

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
| `H`, `L`, `=` | shrink/grow the current column by two; fit loaded values |
| `ctrl+g` | choose a column from a cancel-first list |
| `v` | inspect the complete raw cell value; Esc returns to the table |
| `y`, `Y` | copy the cell or the row (OSC 52) |
| `D` | save the table as CSV in Pi's working directory (never overwrites) |
| `r`, Esc | refresh; close the card, then leave |

Filters: `> 5`, `<= 2.5`, `1..10`, `in a, b`, `null`, `!null`, `~regex`, `^starts`, `ends$`, plain `text` (contains), and `!` in front negates.

### Widgets

Sliders, range sliders, numbers, dropdowns, radios, multiselects, checkboxes, switches, text, dates and buttons. With the keyboard: `w` (or Enter on a control cell), then Tab/Shift+Tab or `j`/`k` traverse controls across notebook cells, including folded sections; `h`/`l` change a value (`H`/`L` or Shift+Left/Right change ten steps). Space toggles, presses or switches the range handle; Enter types a numeric slider value, a `lower, upper` range, text or a date. Esc leaves control mode; `o` opens unsupported controls in the browser. Disabled controls can be focused but not changed. With the mouse: press on a slider's bar and drag; click a checkbox, switch, button, multiselect option, or a number's or choice's `‹` `›`; click text or a date to type it; the wheel steps the focused widget. Each change reaches the kernel as it does from the browser, so dependent cells rerun, and the agent's next context says what you set.

### Editing cells

Enter on source or Markdown, or `b`, opens an embedded, isolated Neovim buffer. Eligible literal `mo.md(...)` cells open as Markdown; dynamic or otherwise unsafe-to-decode Markdown opens as Python source. Neovim runs with a clean built-in runtime, without your personal init, plugins or autocommands. Its normal editing keys, including Escape, Enter, `?`, `#`, `q`, `!`, `\`, `H`/`L`, motions, visual mode, registers, macros and Ex commands, belong to Neovim while editing.

| editor key or command | action |
|---|---|
| F1 | help |
| F2, `:w` | save only, without running |
| F3, `:MarimoRun` | save, then run the saved cell |
| F4, `:MarimoClose` | leave; dirty drafts require a decision |
| F5 | switch dock/full screen |
| F6, `:MarimoRevert` | revert to the last saved base, with confirmation if dirty |
| F7 | toggle line numbers |
| F8 | read the full transient message, retaining the editor draft |
| `:wq` | save only and close |
| `:q!` | deliberately discard and close |

A failed save keeps the draft. If the browser or agent changes the cell, saving detects the conflict rather than overwriting it: compare current source and draft, continue editing, copy the draft, or discard and reload. Unexpected Neovim exit retains the latest draft in memory for reopening, copying or discarding; it is not persistent recovery across Pi restarts. Dock transfers and chat focus preserve the editor. A save-and-run can save successfully but fail to run; the view reports that separately.

### Diagnostics and progress

`!` cycles **All → Errors → Warnings → None**; `\` independently toggles stdout and result output. Errors and warnings appear in compact, severity-tinted, code-like panels with their traceback indentation intact. Source, Markdown prose, status and active progress remain visible. Headers retain execution/error state and indicate hidden content.

Native marimo progress, PyMC's HTML chain tables, Rich terminal bars and tqdm terminal progress are recognized where their data is available. Nutpie's 0.16.8 sampler output appears as a compact aggregate and per-chain panel, using only the producer's supplied counts, timing and diagnostics; customized or unknown templates fall back to readable HTML. Native HTML `<progress>` from fastprogress is supported when that HTML reaches the view. Common unambiguous text counts and percentages may also become bars; unknown formats remain readable rather than receiving invented progress. Arbitrary IPython widgets and legacy fastprogress display-handle transports are not guaranteed. Console output is the current terminal display, including redraws, not a lossless log.

### Variables and packages

`v` opens variables; `j`/`k` move, `/` filters, `s` cycles name/type/definition sort, Enter opens the preview, `d` goes to the definition, `>` selects a use, `y`/`Y` copy name/value, `a` asks the agent, and `t` opens the defining cell's table when available. Esc backs out. Values are marimo-supplied repr previews, not deep object evaluation.

`P` opens packages for the selected notebook's kernel. Tab cycles Installed, Missing and Operations; `/` filters, `j`/`k` move, PgUp/PgDn and `g`/`G` scroll, Enter opens or expands dependency details, `r` refreshes, and `a` installs, `u` upgrades or `x` removes. Esc backs out. Mutations require an explicit cancel-first confirmation showing the notebook and kernel fingerprint. The environment may be shared with the server or other notebooks. Unsupported marimo versions, managers or tools make actions unavailable; a required restart is manual, never automatic. If an operation's outcome is unknown, do not repeat it; reconcile first.

### Charts

On terminals with Kitty graphics (Ghostty, Kitty, herdr) charts draw inline at the pane's full width:

- PNG figures (matplotlib, PIL) as they are.
- Vega-Lite and Altair, drawn with `uv run --with vl-convert-python` (needs `uv`).
- Plotly, live: hover for tooltips, drag to zoom or pan, and `i` enters explicit chart inspection. In section view, the wheel over a live chart scrolls the detail by default and zooms only during chart inspection; cell view is unchanged. Pi downloads a sandboxed headless Chrome for Testing once into `~/.cache/pi-marimo/chrome`; it never uses your own Chrome. `"liveCharts": false` draws pictures instead.

Clipped image and chart placeholders stay visible even when the image's top is above the viewport.

In live-chart mode, `h`/`j`/`k`/`l` or arrows move the pointer; uppercase or shifted arrows move farther. Space or Enter starts or ends a drag, `+`/`-` zoom, `0` resets, and `i`, `q` or Esc leaves chart mode.

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

## Background execution and completion

pi-marimo supervises the official `marimo pair execute` CLI; marimo remains responsible for Python execution and code mode. This works standalone, without pi-bg or Herdr, and requires a compatible marimo CLI (verified with 0.25.0). The marimo-pair workflow still applies: inspect `help(cm)` first, use its scratchpad for exploration, and make durable notebook changes through code mode rather than editing the `.py` file.

| tool | purpose |
|---|---|
| `marimo_execute` | run Python through the official CLI; return a result within the foreground window or a background execution handle |
| `marimo_watch` | subscribe to the currently observed notebook execution wave, including its queued descendants; executes no Python |
| `marimo_execution` | list execution records, inspect one result, or unsubscribe without interrupting Python |

A typical workflow is: ask Pi to start a fit, receive a subscribed execution handle, chat about something else, then receive a completion follow-up when the execution finishes. Pi queues that follow-up if it is already answering you; it does not overwrite your draft or interrupt the response.

Completion notices, execution status replies and native tool results show a compact summary by default: notebook, task label, outcome and known elapsed time. Use Pi's configured expand/collapse action to reveal the full captured message, including execution IDs, paths, output, errors and omission notices. The hint shows your actual keybinding. This presentation also applies to older completion messages after reload; it does not shorten the model-visible result or change output retention. For longer retained per-task output tails, use `marimo_execution` with the execution ID.

`marimo_execute` defaults to a 1000 ms foreground window (`yield_ms`, range 0–1000) and subscribes by default. Short results return inline without a redundant wake-up. Long execution stays owned by pi-marimo after the tool returns or its wait is interrupted. `subscribe:false` disables continuation for that execution even in `all` mode. A busy kernel rejects additional native Python requests: use `marimo_watch` or the status tool instead of queueing an inspection behind a fit. Notebook selection must be unambiguous; the optional `url` distinguishes the same file on different servers.

| `completion.mode` | behavior |
|---|---|
| `subscribed` (default) | resume Pi for subscribed native executions and explicit watches; ordinary notebook exploration stays quiet |
| `all` | additionally resume Pi after observed execution waves in notebooks this session uses, including runs started in the notebook UI |
| `off` | retain execution tracking and results, but never automatically continue the agent |

Use `/marimo watch [file]` to subscribe, `/marimo executions` to inspect records, and `/marimo unwatch <id>` to stop watching. Sending chat messages, unsubscribing, dismissing a notebook row, and changing completion mode do not interrupt Python. These controls prevent future notifications; a completion already accepted into Pi's follow-up queue is not withdrawn. The existing two-press interrupt controls remain separate.

Native execution clients and subscriptions survive `/reload` and switching away from the originating Pi session. Results belong to their original session and branch; they wait there rather than waking another conversation. A full Pi process exit is different: closing the official execution client can interrupt scratch execution. This package is not a durable execution daemon, and after a restart it reports unconfirmed work as `unknown`, never silently rerunning it.

Passive watches require a real completion boundary, not merely a briefly idle cell list. Disconnects, session replacement, and missed completion events can make an outcome unknown; inspect the notebook before continuing in that case. Native CLI success confirms the Python request, not that every notebook cell it triggered succeeded; newly observed notebook errors are reported separately. Output tails are bounded and indicate truncation.

The CLI command is selected from `execution.command`, then a Pi-owned server's remembered command and project directory, then `server.command` with its normal uv/PATH fallback. Source goes on stdin; authentication stays in the inherited environment. Unsupported CLI capabilities fail before submitting code; pi-marimo neither installs marimo nor falls back to a private execution API.

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
| `/marimo watch [file]` | subscribe to the notebook's currently observed execution wave |
| `/marimo executions` | list this session/branch's execution records |
| `/marimo unwatch <id>` | unsubscribe without interrupting Python |
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
  "view": {
    "code": "open", "outputs": false, "split": false, "autoSplit": true,
    "lineNumbers": false, "diagnostics": "all", "showOutput": true,
    "editor": {
      "command": "nvim",
      "options": { "tabstop": 4, "shiftwidth": 4, "expandtab": true, "ignorecase": true, "smartcase": true, "scrolloff": 3 }
    }
  },
  "server": { "command": [] },
  "execution": { "command": [] },
  "completion": { "mode": "subscribed" }
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
| `view.lineNumbers` | `false` | line numbers in source, fenced code and editor |
| `view.diagnostics` | `"all"` | `"all"`, `"errors"`, `"warnings"` or `"none"` |
| `view.showOutput` | `true` | show stdout and results; independent of diagnostics and `view.outputs` |
| `view.editor.command` | `"nvim"` | Neovim executable as one nonempty string, not a shell command |
| `view.editor.options` | see above | native allowlist only: `tabstop` and `shiftwidth` integers 1–16, `scrolloff` 0–20, and booleans `expandtab`, `ignorecase`, `smartcase` |
| `server.command` | `[]` | how Pi starts marimo; empty means `uv run marimo` in a uv project, else `marimo` |
| `execution.command` | `[]` | argv prefix for official CLI execution; empty reuses a Pi-owned server's command/directory, then the server-command fallback |
| `completion.mode` | `"subscribed"` | `"subscribed"`, `"all"` or `"off"`; changed on session start/reload, without stopping computation |

Live line-number, diagnostics and output toggles last for the Pi session and do not write the config file. `view.outputs` selects section view; it does not control output visibility. Invalid semantic settings use defaults and generate an aggregated warning; wrong-type values ignored during config merging remain silent.

`MARIMO_TOKEN` is sent to token-protected servers.

## Troubleshooting

- **A notebook does not show up.** pi-marimo finds servers through marimo's registry, which only servers started with `--no-token` write to. It follows notebooks under Pi's working directory, not in hidden directories or other Git repositories below it. Start it with `/marimo edit`, or pin it with `/marimo`.
- **Charts are blank.** You need a terminal with Kitty graphics. In herdr, set `experimental.kitty_graphics = true` and open a new pane.
- **`ctrl+'` does nothing.** Your terminal has to report the key (the kitty keyboard protocol does). `/marimo split` does the same.
- **"read-only" or 403 when running cells.** The browser tab that opened the notebook has closed. pi-marimo opens the notebook itself and retries, so this should not reach you; if it does, run `/marimo edit <file>`.
- **The agent edits the wrong notebook.** Several notebooks on one server: the context gives each one's marimo-pair flags, and pi-marimo warns on calls that could mean more than one.

## Integrations

Each is optional and talks over Pi's event bus. Native execution supervision, completion subscriptions, notebook rows and agent continuation work without any of these packages.

- [pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/): notebooks are listed in `/tasks`, and `bg_wait` can wait on `marimo:<path>` until the notebook's cells finish. A marimo server pi-bg runs is shown with its notebook's state, and stopping a marimo-pair job interrupts the cells it started. Independent services such as sleep prevention remain separate tasks; their count is not duplicated notebook work.
- [pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/): the notebook rows join its panel under the prompt.
- [pi-sidebar](https://pi-plugins.vercel.app/plugins/pi-sidebar/): shares the right-hand side.
- [pi-status-footer](https://pi-plugins.vercel.app/plugins/pi-status-footer/): notebook rows in the footer.
- [pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/): in a [Herdr](https://herdr.dev) pane, a notebook still running after the turn ends shows in the `$marimo` pane token, with a notification when it finishes.
- [pi-next-prompt](https://pi-plugins.vercel.app/plugins/pi-next-prompt/): a new Lens selection offers "Use Lens to address S1" as the next prompt.
- [pi-vim](https://pi-plugins.vercel.app/plugins/pi-vim/): vim keys in the view's prompts.

## How it works

pi-marimo subscribes to each notebook session's message stream (`/sse`) as a read-only kiosk viewer, so it never takes the notebook over from your browser. marimo replays the session on connect; after that pi-marimo receives every cell's code, status, output and errors, the dataflow graph and the variable values. Actions from the view are separate requests to marimo's kernel endpoints, sent through Pi's own session when the browser's is gone. Servers are found through marimo's registry (`$XDG_STATE_HOME/marimo/servers`) and each server's `/api/sessions`.

Limits:

- Widget values changed in a browser show in the view after a reconnect.
- "Changed by the agent" means any code-mode change; marimo cannot tell agents apart.
- The rows and the view exist only in Pi's terminal UI.

## Development

```sh
npm ci && npm run check
```

- Live tests (need `marimo` on PATH): `PI_MARIMO_LIVE_TEST=1 npx vitest run test/e2e.test.ts test/e2e-actions.test.ts`
- To start the demo server from scratch with its dependencies: `uvx --with pandas,numpy,matplotlib,plotly,altair,vl-convert-python,rich,tqdm,marimo-lens marimo edit --no-token examples/coffee.py`. If it is already running, `/marimo edit examples/coffee.py` opens its Pi view using that server without a browser or another server.
- Releases and rollout: `AGENTS.md`.
- Table design references (interaction ideas, not copied implementations): [Textual DataTable](https://textual.textualize.io/widgets/data_table/) for pinned headers and focus, [Harlequin](https://harlequin.sh/docs/bindings) for column navigation and full values, [VisiData](https://www.visidata.org/docs/columns/) for sizing and feedback, and [Ratatui table](https://ratatui.rs/examples/apps/table/) for position indicators.

The coffee demo includes selectable tables, every supported widget family, Matplotlib, live Plotly plots (including a heatmap and 3D surface), Altair/Vega-Lite and Vega, Mermaid, rich output, gated progress and intentional diagnostics. Its tour covers editing, agent changes, Lens marks, variables, packages, docking and notebook lifecycle actions. Plotly gestures work in the terminal; Altair brushing runs in the browser, while the terminal shows its rendered image. Slow runs and errors are opt-in. Package mutations, exports and server shutdowns are left for you to invoke deliberately.

## License

MIT. See [LICENSE](./LICENSE).
