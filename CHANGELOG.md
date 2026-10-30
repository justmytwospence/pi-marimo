# Changelog

## Unreleased

- Expanded source and fenced code remain complete and scroll horizontally, with optional line numbers; Markdown prose uses the available width. Mermaid diagrams render inline or show their complete source and a reason when unavailable.
- Edit Python and eligible literal Markdown in an isolated Neovim 0.10+ buffer. Save without running, save and run, or revert explicitly; conflicting changes are not overwritten and unexpected editor exits retain an in-memory draft.
- Filter diagnostics independently of output, and display native marimo, PyMC, Rich and tqdm progress where supported. Console redraws show the current display rather than a lossless log.
- Inspect variables using marimo's supplied previews, and inspect or manage kernel packages with cancel-first, environment-aware confirmation.
- Add searchable, scrollable context-aware help, a compact contextual footer, and view/editor preferences. Transient messages preview in up to three rows, reserving four body rows when possible; F8 opens the full message read-only, with scroll controls and Esc/F8 to return. Editor and prompt drafts are retained and ordinary keys remain unchanged.

## 0.2.0

pi-marimo is its own package again (npm: `pi-marimo`), after developing inside Pi Plugins. Since 0.1:
- A notebook view: an outline beside the selected cell's detail, or stacked when narrow; docked beside the chat (`ctrl+'`, `|`, `/marimo split`) or full screen.
- Cells by title (never ids), with a status glyph, one badge, and a spinner and elapsed time while they run.
- Interactive tables through marimo's own table functions: paging, sorting, search, filters, selection, summaries, row and column cards, copy and CSV.
- Widgets driven by keyboard and mouse; live Plotly charts; inline images.
- Parts of a cell (`n`/`p`), code blocks open by default (`view.code`), editable markdown cells, `/` to find a cell.
- Run, interrupt, scratchpad, Lens marks and widgets act through Pi's own session when the browser's is gone.
