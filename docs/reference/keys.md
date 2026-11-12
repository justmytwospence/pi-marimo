# Keys

Generated from `src/ui/keys.ts`; do not edit. The `?` cheat sheet in the view shows the same list, and `ctrl+p` searches it.

## Navigation

| Keys | Action | Where |
|---|---|---|
| `j` / `↓` | next cell | notebook |
| `k` / `↑` | previous cell | notebook |
| `Ctrl+D` / `]` | next section: Next section, or next filtered cell during search | notebook |
| `Ctrl+U` / `[` | previous section: Previous section, or previous filtered cell during search | notebook |
| `n` | next part | notebook |
| `p` | previous part | notebook |
| `g` / `Home` | first cell | notebook |
| `G` / `End` | last cell | notebook |
| `PageUp` | page up | notebook |
| `PageDown` / `Space` | page down | notebook |
| `f` | follow running cell | notebook |
| `F` | jump to running cell: Jump to the running cell once without following later execution | notebook |
| `/` | find cell: Filter cells; Enter goes to the match and clears search; Escape restores selection | notebook |
| `?` | help: Open searchable context help | notebook, variables, packages, table, widget, chart |
| `Ctrl+P` | command palette: Fuzzy-find actions available in this view | notebook, variables, packages, table, widget, chart |
| `<` | upstream cell | notebook |
| `>` | downstream cell | notebook |
| `e` | next error | notebook |
| `E` | previous error | notebook |
| `c` | next agent change | notebook |
| `C` | previous agent change | notebook |
| `@` | run chain: Show only the cells in the latest run, with their run steps; @ or Escape shows all | notebook |
| `~` | chain order: Switch the run chain between file order and run order | notebook |

## Display

| Keys | Action | Where |
|---|---|---|
| `B` | fold code: Fold or unfold selected cell source; retained across cell and section views | notebook |
| `#` / `F7` | line numbers | notebook |
| `H` | code left: Scroll focused code left eight columns | notebook |
| `L` | code right: Scroll focused code right eight columns | notebook |
| `0` | reset code offset | notebook |
| `s` | diagram source: Toggle focused Mermaid diagram and complete source | notebook |
| `!` | diagnostics: Cycle All / Errors / Warnings / None independently of output | notebook, variables, packages, table, widget, chart |
| `\` | output visibility: Toggle stdout and results; source, progress and run state stay visible | notebook, variables, packages, table, widget, chart |
| `T` | exact timing: Inspect local start/end timezone and duration | notebook |
| `O` | section / cell view | notebook |
| `z` / `Tab` | fold section | notebook |
| `Z` / `Shift+Tab` | fold all sections | notebook |
| `d` | agent diff | notebook |

## Execution

| Keys | Action | Where |
|---|---|---|
| `r` | run cell | notebook |
| `R` | run stale: Press twice to run stale cells | notebook |
| `A` | run all: Press twice to run all cells | notebook |
| `x` | interrupt: Press twice to interrupt the kernel | notebook |
| `:` | kernel Python: Open a docked Python prompt | notebook |
| `a` | ask agent | notebook |
| `m` | Lens mark | notebook |
| `M` | remove Lens mark: Press twice to remove the latest selection | notebook |

## Editing

| Keys | Action | Where |
|---|---|---|
| `F1` | help: Open help; other Vim keys remain native | editor |
| `Enter` / `l` | edit / activate: Edit source or Markdown; activate a focused table, widget or chart | notebook |
| `b` | edit source: Edit selected Python or literal Markdown inline with Neovim | notebook |
| `u` | revert agent change: Restore the cell's code from before the agent's change, or delete a cell the agent created; asks first | notebook |
| `F2` | save: Save only; native :w and :wq also save without running | editor |
| `F3` | save + run: Save then run the canonical saved cell | editor |
| `F4` | leave editor: Dirty drafts offer Save / Discard / Keep editing | editor |
| `F5` | dock / fullscreen: Retain live editor and draft | editor |
| `F6` | revert: Confirm dirty revert to last saved base as an undoable edit | editor |
| `F7` | line numbers: Toggle source and editor line numbers | editor |
| `:w` / `:wq` | native save: Save only; conflicts and failures retain your draft | Pi |
| `:q!` | discard draft: A deliberate native quit discards; crashes retain recovery drafts | Pi |
| `:MarimoRun` | save then run: Save before requesting execution; no automatic mutation retries | Pi |
| `:MarimoRevert` | revert saved base: Restore the last saved base as one undoable edit | Pi |
| `:MarimoClose` | close editor: Unsaved drafts require Save / Discard / Keep editing | Pi |
| `Vim input` | native editing: Neovim owns ordinary punctuation, Enter, Escape, motions, operators, registers and undo | Pi |

## Variables

| Keys | Action | Where |
|---|---|---|
| `v` | variables | notebook |
| `j` / `↓` | next / scroll down | variables |
| `k` / `↑` | previous / scroll up | variables |
| `g` / `Home` | first / top | variables |
| `G` / `End` | last / bottom | variables |
| `PageUp` | scroll up | variables |
| `PageDown` / `Space` | scroll down | variables |
| `Ctrl+U` | half page up: Half page in list; full page in value detail | variables |
| `Ctrl+D` | half page down: Half page in list; full page in value detail | variables |
| `Esc` | back: Close detail first, then return to cells | variables |
| `v` / `q` / `h` / `←` | close variables | variables |
| `Ctrl+C` | back to Pi | variables |
| `Enter` / `l` / `→` | detail: Open scrollable marimo value preview, not arbitrary object evaluation | variables |
| `s` | sort: Cycle name / type / definition | variables |
| `/` | filter: Search name, type and supplied value | variables |
| `d` | definition | variables |
| `>` | use sites: Choose among all use sites | variables |
| `y` | copy name | variables |
| `Y` | copy value | variables |
| `t` | defining table | variables |
| `a` | ask about variable | variables |

## Packages

| Keys | Action | Where |
|---|---|---|
| `P` | packages | notebook, variables |
| `Esc` | back: Close dependency detail first, then return to cells | packages |
| `P` / `q` | close packages | packages |
| `/` | filter packages | packages |
| `Tab` | category: Cycle Installed / Missing / Operations | packages |
| `j` / `↓` | next package | packages |
| `k` / `↑` | previous package | packages |
| `PageDown` | page down | packages |
| `PageUp` | page up | packages |
| `g` | top | packages |
| `G` | bottom | packages |
| `Enter` | dependency tree: Open detail or expand/collapse; never mutate on Enter | packages |
| `r` | refresh | packages |
| `a` | install requirement: Review kernel environment and confirm before installation | packages |
| `u` | upgrade: Confirm selected installed package upgrade | packages |
| `x` | remove: Confirm selected installed package removal | packages |

## Tables

| Keys | Action | Where |
|---|---|---|
| `t` | table | notebook |
| `Esc` / `q` / `Ctrl+C` | back: Close card first, then leave table | table |
| `j` / `↓` | row down | table |
| `k` / `↑` | row up | table |
| `h` / `←` | column left | table |
| `l` / `→` | column right | table |
| `]` / `PageDown` | next page | table |
| `[` / `PageUp` | previous page | table |
| `g` | first page | table |
| `G` | last page | table |
| `+` | larger page | table |
| `-` | smaller page | table |
| `s` | sort column | table |
| `S` | add sort column | table |
| `/` | search | table |
| `f` | filter column | table |
| `F` | clear filters | table |
| `Space` / `x` | select row | table |
| `Enter` | row detail | table |
| `i` | column detail | table |
| `c` | summaries | table |
| `H` | shrink column: Shrink current column two terminal columns | table |
| `L` | grow column: Grow current column two terminal columns | table |
| `=` | fit column: Fit the current column to loaded values | table |
| `Ctrl+G` | choose column: Pick a column from the current table | table |
| `v` | full value: Inspect the complete current cell value | table |
| `y` | copy cell | table |
| `Y` | copy row | table |
| `D` | save CSV | table |
| `r` | refresh | table |

## Widgets

| Keys | Action | Where |
|---|---|---|
| `w` | controls: Drive the cell's controls across notebook cells with Tab or j/k | notebook |
| `Esc` / `w` / `q` | done | widget |
| `j` / `↓` / `Tab` | next widget | widget |
| `k` / `↑` / `Shift+Tab` | previous widget | widget |
| `h` / `←` | decrease | widget |
| `l` / `→` | increase | widget |
| `H` / `Shift+←` | decrease ×10 | widget |
| `L` / `Shift+→` | increase ×10 | widget |
| `Space` | toggle / press / handle: Space toggles a switch, presses a button or changes a range handle | widget |
| `Enter` | enter value: Enter types a slider, range, text or date value; toggles buttons and switches | widget |
| `o` | open browser: Open unsupported controls in marimo's browser | widget |

## Charts

| Keys | Action | Where |
|---|---|---|
| `i` | inspect chart | notebook |
| `Esc` / `q` / `i` | done | chart |
| `h` / `←` | pointer left | chart |
| `l` / `→` | pointer right | chart |
| `k` / `↑` | pointer up | chart |
| `j` / `↓` | pointer down | chart |
| `H` / `Shift+←` | pointer far left | chart |
| `L` / `Shift+→` | pointer far right | chart |
| `K` / `Shift+↑` | pointer far up | chart |
| `J` / `Shift+↓` | pointer far down | chart |
| `Space` / `Enter` | start / end drag | chart |
| `+` / `=` | zoom in | chart |
| `-` / `_` | zoom out | chart |
| `0` | reset chart | chart |

## Dock/Mouse

| Keys | Action | Where |
|---|---|---|
| `\|` | dock / fullscreen | notebook, variables, packages, chart |
| `{` | previous notebook | notebook, variables |
| `}` | next notebook | notebook, variables |
| `Esc` / `Ctrl+C` / `q` / `h` / `←` | back to Pi: Escape focuses docked chat; q closes a docked notebook | notebook |
| `o` | open browser | notebook |
| `S` | stop server: Press twice to stop the notebook server | notebook |
| `Ctrl+]` | chat / notebook focus: Host shortcut; click a pane to focus it | Pi |
| `Ctrl+'` | dock / close notebook: Host shortcut; drag divider to resize; wheel scrolls; double-click edits source | Pi |

## Help

| Keys | Action | Where |
|---|---|---|
| `F8` | message: Read the full captured message; prompt and editor drafts are kept | notebook, variables, packages, table, widget, chart, editor, help |
| `Esc` / `F8` | back: Restore prior focus and scroll without rearming actions | message |
| `j` / `↓` | scroll down: Mouse wheel also scrolls the message | message |
| `k` / `↑` | scroll up | message |
| `PageDown` | page down | message |
| `PageUp` | page up | message |
| `g` / `Home` | message top | message |
| `G` / `End` | message bottom | message |
| `?` / `F1` | close help: Close when not typing a search | help |
| `Esc` | clear / close: Clear search first, then close help | help |
| `/` | search help: Search key names and descriptions across all categories | help |
| `Tab` | next category: Switch category and leave search | help |
| `Shift+Tab` | previous category: Switch category and leave search | help |
| `j` / `↓` | scroll help down: Mouse wheel also scrolls help | help |
| `k` / `↑` | scroll help up | help |
| `PageDown` / `Ctrl+D` / `Space` | help page down | help |
| `PageUp` / `Ctrl+U` | help page up | help |
| `g` / `Home` | help top | help |
| `G` / `End` | help bottom | help |
