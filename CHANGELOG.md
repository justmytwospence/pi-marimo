# Changelog

## 0.2.0

pi-marimo is its own package again (npm: `pi-marimo`), after developing inside Pi Plugins. Since 0.1:
- A notebook view: an outline beside the selected cell's detail, or stacked when narrow; docked beside the chat (`ctrl+'`, `|`, `/marimo split`) or full screen.
- Cells by title (never ids), with a status glyph, one badge, and a spinner and elapsed time while they run.
- Interactive tables through marimo's own table functions: paging, sorting, search, filters, selection, summaries, row and column cards, copy and CSV.
- Widgets driven by keyboard and mouse; live Plotly charts; inline images.
- Parts of a cell (`n`/`p`), code blocks open by default (`view.code`), editable markdown cells, `/` to find a cell.
- Run, interrupt, scratchpad, Lens marks and widgets act through Pi's own session when the browser's is gone.
