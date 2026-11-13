# Changelog

## Unreleased

- `marimo_execute` waits up to 30s (was 5s) for its `marimo pair execute --help` check, so a busy machine no longer fails it, and a timeout now says it is transient and safe to retry instead of pointing at `execution.command`.

## 0.6.0

- `marimo_chart` gives the agent the chart's picture (up to 4 for a cell with several figures), and `show: false` lets it look without showing you, instead of saving figures to files to read them.
- When the agent changes cells and does not run them, the result of its notebook call says which, so it runs them or tells you instead of leaving stale output.
- Agents are steered to `marimo_execute` instead of the marimo-pair skill's `execute-code.sh` (tool description, a prompt rule, and a one-time note on the first bash call).
- The Lens that marimo 0.25 mounts in every code-mode scratch run no longer shows up as HTML in the agent's results.

## 0.5.1

- The view follows the running cell again on its own when the agent starts a turn or runs cells during one, after you moved away to read; it waits until you have left the keys alone for five seconds and never takes over an editor, prompt or widget. The header says `not following · f` while a run goes on without it. `view.follow` sets it: `"agent"` (default), `"always"` (any run) or `"manual"` (only `f`, as before).

## 0.5.0

- Widget changes, runs and interrupts from the Pi view no longer fail with "marimo answered 403" after the agent runs Python: watching the run no longer evicts the notebook's own session.
- The agent's changes stay marked (`c`, `d`, `u`, "agent: N new") when a background run's completion resumes the agent; only your next prompt clears them.
- `view.icons: false` drops Nerd Font icons and symbols that some fonts lack, for terminals and recordings without a Nerd Font.
- `examples/demo.py` replaces the quickstart notebook: dark charts, a headline, and table selections marked on the chart.
- `examples/testing.py` replaces the coffee notebook: the same coverage on bike-share data, with a checklist in each section.
- A scripted, reproducible demo video: `npm run demo`.

## 0.4.0

- Works with marimo's upcoming host protocol as well as 0.25.x. Notebooks are followed on marimo main, and run and interrupt go through `/api/marimo/v1` when the server publishes a host record.
- Pi attaches to host-capable notebooks as an agent: marimo shows it in the notebook footer, and notebook agent messages arrive as prompts (`pair.inbox`, `/marimo attach`).
- `u` reverts the agent's change to a cell, or deletes a cell it created, after a confirmation that names the downstream cells it affects. The diff (`d`) shows the same.
- Section view shows output above code. Cells with hidden code start folded. Hub cells no longer draw a dataflow bar through the whole outline. Help starts with navigation. The palette lists common actions first. The agent's snapshot keeps every cell up to 150.
- Mermaid downloads and is verified on first use instead of being installed, saving about 120 MB.
- New documentation site, a 60-second quickstart notebook (`examples/quickstart.py`), and Node 22.19+.

## 0.3.1

- Published from GitHub Actions with npm provenance. The coffee demo gains a roast pipeline section, a longer, slower dataflow chain for trying the run chain view.

## 0.3.0

- The outline draws the selected cell's direct inputs and dependents in a gutter, and marks the cells of the current run. `@` shows only the latest run's cells, in file order with run steps or in run order with file position (`~`, `view.chain.order`); `view.chain.follow: "wave"` shows it automatically.

## 0.2.1

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
