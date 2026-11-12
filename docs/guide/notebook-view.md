# The notebook view

The outline, the detail, the keys, the run chain, and docking beside the chat.

`ctrl+'` docks it beside the chat; `/marimo view` opens it full screen; `|` switches between the two. One key press toggles once: held repeats and release do nothing. With pi-sidebar installed, an already-open Sidebar keeps the key; otherwise an eligible notebook takes it before Sidebar, regardless of extension load order. `/sidebar` explicitly opens Sidebar.

The **outline** lists sections and cells. A cell is named by its name, or what it defines that other cells use, or what it shows (`imports`, `daily, smooth`, `chart`, `controls`); ids are never shown. A cell has a glyph only when it needs attention:

| glyph | |
|---|---|
| spinner | running, with its elapsed time on the right |
| `◌` | queued |
| `✗` | failed, or blocked by a failed ancestor |
| `•` | stale, or edited but not rerun |

Status chips can show execution state and agent changes together. With a Nerd Font, their icons distinguish ` wait` (queued), ` err` (error), ` block` (failed ancestor), ` old` (stale), ` edit` (edited, not rerun), ` agent` (changed by the agent), ` new` (agent-created) and ` off` (disabled). Short labels remain readable without a Nerd Font; the detail retains complete error messages. The **detail** shows Markdown, output, diagnostics, widgets and source without redundant type captions; `n`/`p` move between parts, with a small `▸` marking the focused part. The layout uses whitespace instead of decorative rules. Source sits in a padded, full-width panel. `O` stacks the whole section: each cell's output, then its Python source (open by default, folded for cells whose code marimo hides). `B` folds only the selected cell to a source preview; each cell’s choice survives navigation, switching views and docking. Prose uses the available width. Expanded source and fenced code retain every line and scroll horizontally rather than wrapping or truncating; `H`/`L` scroll the focused block, `0` resets it, and `#` toggles line numbers. `B` folds or unfolds source.

Mermaid fences and `mo.mermaid` render as diagrams when image support is available. If rendering or images are unavailable, the view explains why and shows the complete diagram source; `s` switches a focused diagram to or from source.

With a dataflow graph, a one-column gutter joins the selected cell to its direct neighbours: `●` is the selected cell, `┌├└` are the cells it uses (accent) and the cells that use it (green), and `│` marks the span between them. While a run is active, cells outside it are dimmed, finished ones show `✓`, and the header shows `step 3/6`.

From 100 columns the outline and detail sit side by side. Narrower, as when docked, they stack like a mail app: a few outline rows centered on the selected cell, the detail below.

## Essential keys

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
| `@` / `~` | show only the latest run (the run chain) / switch it between file order and run order |
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
| `d` | the agent's change as a diff, with the cells it reruns |
| `u` | revert the agent's change to the cell (or delete a cell it created), after a confirmation |
| `<` / `>` | a cell this one uses / one that uses it |
| `@`, `~` | the run chain: only the latest run's cells; flip between file and run order |
| `v`, `P` | variables; packages |
| `/` | find a cell or variable by name, variable, code or error; Enter goes there, Esc goes back |
| `f` | follow the running cell and subsequent execution |
| `F` (Shift+F) | jump to the running cell once and turn following off |
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

`F` jumps to the current notebook's running document cell, clearing a retained filter and opening its hiding section folds without unfolding unrelated sections. It stays on that cell when execution moves elsewhere; lowercase `f` resumes continuous follow. Queued or last-run cells are not jump targets. Background scratchpad Python has no document cell to jump to, so `F` explains that instead of moving the selection.

The mouse works too: the wheel scrolls the pane under it, a click selects a cell or part, and a double click acts on it. Help starts in the current mode, with aligned keys and actions and a category rail when there is room. `j`/`k` and ↑/↓ scroll one row when a category overflows; when it fits they select the adjacent category (stopping at the ends). PgUp/PgDn, `g`/`G` and the wheel scroll; `/` searches keys, actions and descriptions across categories; Tab/Shift+Tab wraps through categories; Esc clears search then closes, and `?` or F1 closes when not typing. The footer prioritizes the contextual action, `? help`, nondefault visibility (`! errors`/`! warnings`/`! hidden`, `\ output off`), then `O cell`/`O section` and position. With room left, it adds `! diagnostics`, `\ output` and `# lines` (`# lines on` when enabled). Hints are always whole; a longer hint that does not fit can yield to a shorter one. Editor, widget, prompt and help footers keep their own context-specific controls.

Transient messages preview in up to three rows, reserving four body rows when possible. When there is room, an overflowing preview shows `F8 more` and the number of hidden lines; F8 opens the full captured message in a read-only view. Scroll with `j`/`k` or arrows, PgUp/PgDn, `g`/`G` or Home/End, or the mouse wheel; Esc or F8 returns to the prior view and scroll position. Editor and prompt drafts are retained, and ordinary keys keep their normal behavior outside the message view.

## The run chain

The kernel announces every cell it will run before it runs any, so the outline can show the latest run. `@` filters the outline to those cells; Esc or `@` shows everything again. The view stays after the run ends, so you can review what ran and what broke, until the next run replaces it. A cell outside the chain that you jump to (for example with `<`) leaves the view.

`~` switches the order, and each order shows the other as a column:

- **File order** (default): rows follow the notebook, with each cell's run step on the left. Finished steps are plain, the running one is accented, and predicted steps are dim; a step that runs after a cell placed below it is tinted as a warning. `⋯ 3 cells` stands in for cells outside the chain. Predictions assume marimo's rule (dependencies first, ties broken by notebook order) and are replaced by the real step as each cell starts.
- **Run order**: rows follow the run, with a strip `▏▎▍▌▋▊▉█` showing how far into the file each cell is (a dip means the run went back up the file) and the section name on the right.

In a lazy runtime, cells that went stale but are not in the run are listed at the end under `stale · not in this run`. The header shows `chain · 3/6 · 0:42`, then the cell count and total time once it ends.

`view.chain.order` sets the starting order and `view.chain.follow: "wave"` turns the view on when a run starts while you are following it.

## Docked beside the chat

The chat reflows into its half, so you keep typing while the notebook runs. The notebook takes 55% of the width; drag the divider to resize. A click in a half focuses it. While a Pi dialog is up, the split steps aside so the dialog has the full width.

The notebook also docks by itself, without taking focus, when the agent starts running its cells (`view.autoSplit`). It does not when you closed the split since your last message, or when [pi-sidebar](https://pi-plugins.vercel.app/plugins/pi-sidebar/) is open: they share the right-hand side, and opening one closes the other. With no notebook in use, `ctrl+'` stays pi-sidebar's key.

## Diagnostics and progress

`!` cycles **All → Errors → Warnings → None**; `\` independently toggles stdout and result output. Errors and warnings appear in compact, severity-tinted, code-like panels with their traceback indentation intact. Source, Markdown prose, status and active progress remain visible. Headers retain execution/error state and indicate hidden content.

Native marimo progress, PyMC's HTML chain tables, Rich terminal bars and tqdm terminal progress are recognized where their data is available. Nutpie's 0.16.8 sampler output appears as a compact aggregate and per-chain panel, using only the producer's supplied counts, timing and diagnostics; customized or unknown templates fall back to readable HTML. Native HTML `<progress>` from fastprogress is supported when that HTML reaches the view. Common unambiguous text counts and percentages may also become bars; unknown formats remain readable rather than receiving invented progress. Arbitrary IPython widgets and legacy fastprogress display-handle transports are not guaranteed. Console output is the current terminal display, including redraws, not a lossless log.

## Rows under the prompt

Every notebook this session uses is a row under Pi's prompt:

```text
 prep.py:2718 · idle
 ● fit.py:2718 · running Data loading › Model fit 0:12 · 2 queued
```

`↓` at the bottom of the prompt selects them; Enter opens the notebook, `x` twice interrupts it. A row shows `✗` after a run broke cells, until your next message. Outside the TUI (RPC, print) the same appears as footer lines under the status keys `marimo`, `marimo-2`, and so on.
