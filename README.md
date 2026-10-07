# pi-marimo

A [Pi](https://pi.dev) extension that follows the [marimo](https://marimo.io) notebook you are
working in, so Pi knows what it looks like and what it is doing without being asked.

- **Footer:** `marimo: fit.py · running Data loading › Model fit (12s) · 2 queued · 1 error · +2 open`.
  The running part is the markdown section (heading path) the running cell sits under, so you can
  tell roughly what is running; `+2 open` counts the other notebooks it follows.
- **Context:** before every model request, the notebook's current state is appended as the last
  message: its outline (markdown headings), one line per code cell with what it defines, and what
  needs attention (running, queued, errors, stale, edited but not rerun, changed by you in the
  browser since Pi's last turn). The block is never stored in the session, so the model only ever
  sees the latest copy and old copies never pile up.
- **`/marimo`:** pick which notebook to follow; `/marimo auto`, `/marimo off`; `/marimo show`
  prints the block the model sees.

It pairs with the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill, which is how the
agent inspects and changes the notebook; this extension only reads.

## How it works

marimo streams every kernel message to the browser over `/ws`, and the same stream over `/sse`.
pi-marimo subscribes to the session's `/sse` stream as a *kiosk* consumer: a read-only viewer that
cannot run or edit code and never takes the notebook over from your browser. On connect marimo
replays the session (`kernel-ready`, then each cell's latest messages), and from then on it receives
the cell document (`notebook-document-transaction`), each cell's status and errors (`cell-op`) and
the dataflow graph (`variables`). Outputs are dropped. Nothing runs in the kernel, so it keeps
working while a long cell runs.

**Which notebook.** By default (`auto`) it follows every notebook open under Pi's working directory
(up to eight), found through marimo's server registry (`$XDG_STATE_HOME/marimo/servers`, written by
servers started with `--no-token`) and each server's `/api/sessions`. Notebooks in a hidden
directory there (`.worktrees/`, `.claude/worktrees/`: other checkouts) are left out. The current one,
shown in the footer and in context, is the one used most recently: a running cell first, then the
latest cell run (replayed on connect, so history counts) or edit; the others are named in the state
block. `/marimo` pins one instead, remembered in the Pi session and followed across page reloads and
server restarts. Token-protected servers are reached with `MARIMO_TOKEN`.

**Browser edits.** marimo does not echo an edit back to the consumer whose session id sent it, so
pi-marimo connects under its own id and lets marimo find the session by file. When several sessions
hold the same file (a closed tab's session can linger), that lookup would take the oldest, so it
connects by the exact session id instead and does not see edits typed in the browser until they run.

**Prompt cache.** Pi marks the last message as Anthropic's cache breakpoint, which is now the state
block, replaced on the next request, so the conversation before it would never be read from cache
again. pi-marimo moves that mark to the block just before the state block (Pi already uses all four
breakpoints Anthropic allows). The conversation stays cached and only the state block (a few hundred
tokens) is processed fresh on each request. Providers with automatic prefix caching (OpenAI) need
nothing.

## Footer integration

The status is published with `ctx.ui.setStatus("marimo", text)`, so it appears in Pi's built-in
footer and in any footer that shows extension statuses. Its shape is stable for footers that want
to lay it out themselves: `marimo: <file>` followed by ` · `-separated parts, `running <a › b>
(<elapsed>)`, `<n> queued`, `<n> error(s)`, `+<n> open`, or a connection note (`connecting`,
`disconnected`, `not open`). [pi-status-footer](https://github.com/justmytwospence/pi-status-footer) gives it its own
row under the context row, shortening the section to its deepest heading when narrow; any other
shape stays in its status row.

## Install

```sh
pi install git:github.com/justmytwospence/pi-marimo
```

or add a checkout's path to `packages` in `~/.pi/agent/settings.json`.

## Development

```sh
npm ci
npm run check   # typecheck, unit tests, and an end-to-end test against a real marimo server
```

The end-to-end test starts `marimo edit --headless` on a scratch notebook and is skipped when
`marimo` is not on `PATH`. `src/core/` is plain ECMAScript behind a small `Io` interface (`node-io.ts` for Node and Bun), so the [opencode](https://github.com/justmytwospence/opencode-marimo) and [Claude Code](https://github.com/justmytwospence/claude-marimo) ports copy it unchanged.
