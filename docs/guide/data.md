# Tables, widgets and charts

Drive marimo's tables and controls from the keyboard or mouse, see charts inline, and inspect variables and packages.

## Tables

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

## Widgets

Sliders, range sliders, numbers, dropdowns, radios, multiselects, checkboxes, switches, text, dates and buttons. With the keyboard: `w` (or Enter on a control cell), then Tab/Shift+Tab or `j`/`k` traverse controls across notebook cells, including folded sections; `h`/`l` change a value (`H`/`L` or Shift+Left/Right change ten steps). Space toggles, presses or switches the range handle; Enter types a numeric slider value, a `lower, upper` range, text or a date. Esc leaves control mode; `o` opens unsupported controls in the browser. Disabled controls can be focused but not changed. With the mouse: press on a slider's bar and drag; click a checkbox, switch, button, multiselect option, or a number's or choice's `‹` `›`; click text or a date to type it; the wheel steps the focused widget. Each change reaches the kernel as it does from the browser, so dependent cells rerun, and the agent's next context says what you set.

## Charts

On terminals with Kitty graphics (Ghostty, Kitty, herdr) charts draw inline at the pane's full width:

- PNG figures (matplotlib, PIL) as they are.
- Vega-Lite and Altair, drawn with `uv run --with vl-convert-python` (needs `uv`).
- Plotly, live: hover for tooltips, drag to zoom or pan, and `i` enters explicit chart inspection. In section view, the wheel over a live chart scrolls the detail by default and zooms only during chart inspection; cell view is unchanged. Pi downloads a sandboxed headless Chrome for Testing once into `~/.cache/pi-marimo/chrome`; it never uses your own Chrome. `"liveCharts": false` draws pictures instead.

Clipped image and chart placeholders stay visible even when the image's top is above the viewport.

In live-chart mode, `h`/`j`/`k`/`l` or arrows move the pointer; uppercase or shifted arrows move farther. Space or Enter starts or ends a drag, `+`/`-` zoom, `0` resets, and `i`, `q` or Esc leaves chart mode.

`/marimo chart <cell>` puts a cell's chart into the chat; the agent can do the same with its `marimo_chart` tool. The tool also hands the agent the chart's picture, so it can check a figure (with `show: false`, without putting it in the chat).

## Variables and packages

`v` opens variables; `j`/`k` move, `/` filters, `s` cycles name/type/definition sort, Enter opens the preview, `d` goes to the definition, `>` selects a use, `y`/`Y` copy name/value, `a` asks the agent, and `t` opens the defining cell's table when available. Esc backs out. Values are marimo-supplied repr previews, not deep object evaluation.

`P` opens packages for the selected notebook's kernel. Tab cycles Installed, Missing and Operations; `/` filters, `j`/`k` move, PgUp/PgDn and `g`/`G` scroll, Enter opens or expands dependency details, `r` refreshes, and `a` installs, `u` upgrades or `x` removes. Esc backs out. Mutations require an explicit cancel-first confirmation showing the notebook and kernel fingerprint. The environment may be shared with the server or other notebooks. Unsupported marimo versions, managers or tools make actions unavailable; a required restart is manual, never automatic. If an operation's outcome is unknown, do not repeat it; reconcile first.
