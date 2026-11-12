# pi-marimo

**The [marimo](https://marimo.io) notebook your agent is editing, live in your terminal beside the chat.**

pi-marimo is an extension for the [Pi](https://pi.dev) coding agent. Your agent edits a marimo notebook through [marimo pair](https://docs.marimo.io/guides/generate_with_ai/marimo_pair/); you watch it run, read it, and steer it from the terminal, without leaving the conversation.

- **The notebook beside the chat.** `ctrl+'` docks a notebook view next to the conversation: an outline of sections and cells, and the selected cell's output, error and code.
- **Real outputs in the terminal.** Tables you can page, sort, search and filter. Matplotlib, Vega-Lite and live Plotly charts on Kitty-graphics terminals. Widgets you drive with keys or the mouse.
- **What runs, as it runs.** A spinner and elapsed time on the running cell, the dataflow it belongs to, the queue, and errors with their tracebacks.
- **The agent knows the notebook.** Each prompt carries the notebook's current state (cells, what they define, what is stale or broken).
- **What the agent changed, and undo.** Cells it changed since your last message are marked, with a diff, the cells it reruns, and one key to revert.
- **A native pair agent.** On marimo's host protocol, Pi attaches as an agent and receives the notebook's messages.

## Why marimo makes this possible

A marimo notebook is a dataflow graph with a live kernel, not a list of cells to run in order. That is what the view shows: which cells depend on which, which are stale or blocked, and what a run will touch next. Because the agent works through marimo's code mode against the running kernel, edits pass the same checks as edits in the browser, and the terminal view stays in step.

## Next

- [Getting started](getting-started.md): install and a 60-second tour with a small notebook.
- [The notebook view](guide/notebook-view.md) and [all keys](reference/keys.md).
- [Compatibility](compatibility.md): marimo versions, what main changes, and what would help.
- [How it works](how-it-works.md).
