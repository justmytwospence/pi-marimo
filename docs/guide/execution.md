# Background execution and completion

Run long computations without blocking the conversation.

pi-marimo supervises the official `marimo pair execute` CLI; marimo remains responsible for Python execution and code mode. This works standalone, without pi-bg or Herdr, and requires a compatible marimo CLI (verified with 0.25.0). The marimo-pair workflow still applies: inspect `help(cm)` first, use its scratchpad for exploration, and make durable notebook changes through code mode rather than editing the `.py` file.

| tool | purpose |
|---|---|
| `marimo_execute` | run Python through the official CLI; return a result within the foreground window or a background execution handle |
| `marimo_watch` | subscribe to the currently observed notebook execution wave, including its queued descendants; executes no Python |
| `marimo_execution` | list execution records, inspect one result, or unsubscribe without interrupting Python |

A typical workflow is: ask Pi to start a fit, receive a subscribed execution handle, chat about something else, then receive a completion follow-up when the execution finishes. Pi queues that follow-up if it is already answering you; it does not overwrite your draft or interrupt the response.

Completion notices, execution status replies and native tool results show a compact summary by default: notebook, task label, outcome and known elapsed time. Use Pi's configured expand/collapse action to reveal the full captured message, including execution IDs, paths, output, errors and omission notices. The hint shows your actual keybinding. This presentation also applies to older completion messages after reload; it does not shorten the model-visible result or change output retention. For longer retained per-task output tails, use `marimo_execution` with the execution ID.

`marimo_execute` defaults to a 1000 ms foreground window (`yield_ms`, range 0–1000) and subscribes by default. Short results return inline without a redundant wake-up. Long execution stays owned by pi-marimo after the tool returns or its wait is interrupted. `subscribe:false` disables continuation for that execution even in `all` mode. A busy kernel rejects additional native Python requests: use `marimo_watch` or the status tool instead of queueing an inspection behind a fit. Notebook selection must be unambiguous; the optional `url` distinguishes the same file on different servers.

| `completion.mode` | behavior |
|---|---|
| `subscribed` (default) | resume Pi for subscribed native executions and explicit watches; ordinary notebook exploration stays quiet |
| `all` | additionally resume Pi after observed execution waves in notebooks this session uses, including runs started in the notebook UI |
| `off` | retain execution tracking and results, but never automatically continue the agent |

Use `/marimo watch [file]` to subscribe, `/marimo executions` to inspect records, and `/marimo unwatch <id>` to stop watching. Sending chat messages, unsubscribing, dismissing a notebook row, and changing completion mode do not interrupt Python. These controls prevent future notifications; a completion already accepted into Pi's follow-up queue is not withdrawn. The existing two-press interrupt controls remain separate.

Native execution clients and subscriptions survive `/reload` and switching away from the originating Pi session. Results belong to their original session and branch; they wait there rather than waking another conversation. A full Pi process exit is different: closing the official execution client can interrupt scratch execution. This package is not a durable execution daemon, and after a restart it reports unconfirmed work as `unknown`, never silently rerunning it.

Passive watches require a real completion boundary, not merely a briefly idle cell list. Disconnects, session replacement, and missed completion events can make an outcome unknown; inspect the notebook before continuing in that case. Native CLI success confirms the Python request, not that every notebook cell it triggered succeeded; newly observed notebook errors are reported separately. Output tails are bounded and indicate truncation.

The CLI command is selected from `execution.command`, then a Pi-owned server's remembered command and project directory, then `server.command` with its normal uv/PATH fallback. Source goes on stdin; authentication stays in the inherited environment. Unsupported CLI capabilities fail before submitting code; pi-marimo neither installs marimo nor falls back to a private execution API.
