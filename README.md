# pi-marimo

A [Pi](https://pi.dev) extension that follows the [marimo](https://marimo.io) notebooks you are
working in, so Pi knows what they look like and what they are doing without being asked.

- **Footer:** `marimo: fit.py · running Data loading › Model fit (12s) · 2 queued · 1 error · also prep.py, plots.py`.
  It names every notebook it follows. The first is the current one (used most recently), with what
  its kernel is doing: the running part is the markdown section (heading path) the running cell sits
  under, so you can tell roughly what is running. `also` names the others.
- **Context:** when you send a prompt, the state of every followed notebook is taken once and
  placed right after that prompt for every model request of the turn. The current notebook comes
  first and in full: its outline (markdown headings), one line per code cell with what it defines,
  and what needs attention (running, queued, errors, stale, edited but not rerun, changed by you in
  the browser since Pi's last turn). The others follow as short outlines (headings down to `##`)
  with only the cells that need attention. The block is never stored in the session, so the model
  sees only the current turn's copy and old copies never pile up.
- **`/marimo`:** a checklist of open notebooks to pin (any number, from anywhere); `/marimo auto`,
  `/marimo off`; `/marimo show` prints the block the model sees.
- **herdr:** when a turn ends while a cell the agent started is still running, the pane says what
  runs until the kernel goes quiet, then a notification says it finished (see below).

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
first in the footer and in full in context, is the one this session's agent last worked in: Pi's
tool calls are read for marimo-pair commands (`execute-code.sh` or `marimo pair execute`, by
`--file`, `--session`, or `--url` when only one followed notebook is on that server), including
calls made from codemode scripts. Two Pi sessions in two notebooks therefore each keep their own
current notebook, whatever the other session or the browser does. Before the agent has touched
any, it is the one used most recently by anyone: a running cell first, then the latest cell run
(replayed on connect, so history counts) or edit. `/marimo` pins a set instead, remembered in the Pi session and followed across page reloads
and server restarts. Token-protected servers are reached with `MARIMO_TOKEN`.

**Browser edits.** marimo does not echo an edit back to the consumer whose session id sent it, so
pi-marimo connects under its own id and lets marimo find the session by file. When several sessions
hold the same file (a closed tab's session can linger), that lookup would take the oldest, so it
connects by the exact session id instead and does not see edits typed in the browser until they run.

**Thinking and the prompt cache.** Anthropic signs each thinking block against everything before
it and drops the block (`prefix_binding_mismatch`) when that changes. A state block refreshed on
every request would sit before each step's thinking and change on the next request, so the model
would lose its reasoning from the previous step every time. Taken once per prompt and kept in the
same place through the turn, the block changes nothing the model has already thought after, and the
whole turn stays cached. At the next prompt the old copy is gone, which drops that earlier turn's
thinking once and re-reads the conversation after it uncached once. The state can be a turn old
while the agent runs cells; it sees their results through marimo-pair.

## Footer integration

The status is published with `ctx.ui.setStatus("marimo", text)`, so it appears in Pi's built-in
footer and in any footer that shows extension statuses. Its shape is stable for footers that want
to lay it out themselves: `marimo: <file>` followed by ` · `-separated parts, `running <a › b>
(<elapsed>)`, `<n> queued`, `<n> error(s)`, or a connection note (`connecting`, `disconnected`,
`not open`) about the current notebook, and last `also <file>, <file>` naming the others. [pi-status-footer](https://github.com/justmytwospence/pi-status-footer) gives it its own
row under the context row, shortening the section to its deepest heading when narrow; any other
shape stays in its status row.

## herdr

Inside a [herdr](https://herdr.dev) pane, a turn that ends while a notebook the agent worked in
during that turn is still running or has cells queued starts a *kernel hold*. It lasts until every
such notebook is quiet (or disconnects), or until the next prompt. During it the pane token
`marimo` names the file and what runs (`fit.py: Model fit`, or `fit.py: 3 queued`); add `$marimo` to
a row in `[ui.sidebar.agents]` to show it. At the end the token is cleared and a herdr notification
(`fit.py finished`, `ran 4m12s · 1 error`) plays the done sound, unless the pane is focused.

The pane's state stays `idle`. herdr (0.9) lets no one but an agent's own integration change it:
the pi and opencode integrations number their reports from a counter set at load, so a report
wedged between them either is dropped or shuts the integration out, and for Claude Code herdr
ignores state reported under its integration's source and refuses other sources once the session
is known. So every port adds only the token and the notification.

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
