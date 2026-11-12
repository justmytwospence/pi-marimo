# Working with the agent

Ask about a cell, review what the agent changed, and see what the agent sees.

## Pairing with the agent

- **Ask (`a`).** A prompt docks at the bottom of the view. Your message goes to the agent with the notebook, cell and section you were looking at, and with the marimo-pair flags for the notebook. While the agent works it goes in as a follow-up.
- **The agent's changes.** Cells changed since your last message are marked `changed` or `new`, counted in the header, and removed cells are listed. `c`/`C` jump to them and `d` shows the diff. They clear with your next prompt.
- **Scratchpad (`:`).** Run Python against the notebook's globals without changing a cell; what it prints streams above the prompt.
- **Lens marks (`m`).** With [marimo-lens](https://marimo-team.github.io/marimo-lens/) in the notebook, `m` marks the cell with a note, as pointing at it in the browser does; the agent's Lens skill reads it.

## Reverting the agent's changes

`c` / `C` jump between the cells the agent changed since your last message, and `d` shows the change as a diff. Under the diff, pi-marimo lists the cells that rerun when the cell runs (its dataflow descendants).

`u` puts the cell's code back to what it was before the agent's change. It asks first, naming the downstream cells it affects, and offers **Revert** or **Revert and run**. For a cell the agent created, `u` offers to delete it. The revert goes through marimo's code mode as a single attempt: if the cell changed elsewhere in the meantime, nothing is overwritten. Moves, renames and deletions are not reverted from here.

## Messages from the notebook

On a host-capable marimo (currently marimo main), pi-marimo attaches to each notebook the session uses as an agent named **Pi**: marimo's own editor lists it in the notebook footer, the way it lists Claude Code or Codex. When the notebook sends its agent a message (the marimo pair UI, or `POST /api/pair/notebooks/<id>/messages`), the message arrives in Pi as a prompt starting `Agent message from marimo (notebook <path>).`, a follow-up if the agent is busy.

If you detach Pi in marimo, it stays detached; `/marimo attach` reattaches. `"pair": { "inbox": false }` turns this off. Released marimo (0.25.x) does not publish a host record, so nothing happens there. See [Compatibility](../compatibility.md).

## What the agent sees

When you send a prompt, pi-marimo places the state of the notebooks this session uses right after it, for every model request of that turn:

- the current notebook in full: its headings, one line per code cell with what it defines, and what needs attention (running, queued, errors, stale, edited, changed in the browser, widgets you set);
- every other notebook the agent worked in during the last three prompts, also in full; the rest as short outlines;
- each notebook's `marimo-pair --url … --file …` flags, and open Lens selections.

The block is never stored in the session and stays in the same place during the turn, so it does not invalidate the model's thinking. `/marimo show` prints it; `"context": false` turns it off.
