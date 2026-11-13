# Commands and tools

The `/marimo` command and the tools the agent can call.

## `/marimo`

| command | |
|---|---|
| `/marimo` | pick which open notebooks to follow, or Auto or Off |
| `/marimo new <file.py>` | create a notebook, start it and open it |
| `/marimo edit [file]` | open a notebook, starting its server when none serves it |
| `/marimo view [file]` | the busiest notebook, or the one named, full screen (docked with `view.split`) |
| `/marimo split [file]` | dock the busiest notebook, or the one named; again with no file, close it |
| `/marimo stop [file]` | stop a server Pi started |
| `/marimo open` | open a notebook that waits in no browser, in the browser |
| `/marimo auto`, `/marimo off` | follow every notebook under the working directory (default); follow none |
| `/marimo show` | print what the agent sees |
| `/marimo watch [file]` | subscribe to the notebook's currently observed execution wave |
| `/marimo executions` | list this session/branch's execution records |
| `/marimo unwatch <id>` | unsubscribe without interrupting Python |
| `/marimo attach` | reattach Pi to notebook messages after you detached it in marimo |
| `/marimo lens` | open and recently addressed Lens selections |
| `/marimo chart <cell>`, `/marimo inspect` | a cell's chart in the chat; drive the newest one |

A server Pi starts keeps running across `/reload` and stops when Pi exits, with `/marimo stop`, or with `S` twice in its view.

## Tools the agent can call

| tool | purpose |
|---|---|
| `marimo_execute` | run Python through the official CLI; return a result within the foreground window or a background execution handle |
| `marimo_watch` | subscribe to the currently observed notebook execution wave, including its queued descendants; executes no Python |
| `marimo_execution` | list execution records, inspect one result, or unsubscribe without interrupting Python |

| `marimo_chart` | show a chart from a followed notebook in the chat transcript (live when it is Plotly) and give the agent its picture; `show: false` lets the agent look without showing it |

