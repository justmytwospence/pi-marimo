# Compatibility

## Tested with

| marimo | status |
|---|---|
| 0.25.2 (released) | full: the legacy session stream and `/api/kernel/*` endpoints |
| `main` at c74e9e4 (unreleased) | followed through the new host events; run, interrupt and agent attachment use the host protocol |

pi-marimo needs Node 22.19 or later and Pi. Charts need a terminal with Kitty graphics. A weekly CI job runs the live tests against the released marimo and against marimo main.

## How each feature talks to marimo

| feature | 0.25.x | main |
|---|---|---|
| follow a notebook | `/sse` message events | `/sse` `event: marimo`, plus host `cell` and `document` events for the cell list |
| run cells | `/api/kernel/run` | host `runtime.run` |
| interrupt | `/api/kernel/interrupt` | host `runtime.interrupt` |
| widgets | `set_ui_element_value` | same |
| tables | `function_call` | same |
| Lens | `set_model_value` | same |
| scratchpad and edits | `/api/kernel/execute` and code mode | same |
| discovery | `servers/` registry (only servers started with `--no-token`) | same, plus `hosts-v1` host records |
| notebook messages to Pi | not available | host notebook events, attached as `kind=agent` |

The host API is found through the private record marimo writes under `hosts-v1`. pi-marimo uses a record only when it is private to your user, belongs to a running process and points at a loopback address.

## Known gaps on main

- Stale markers are missing: the session stream no longer reports `stale_inputs`. Host freshness (`code_fingerprint`, `depends_on`) is the replacement and is on the roadmap.
- Edits made before pi-marimo connected show no "edited" marker: `last_executed_code` is gone from `kernel-ready`.
- A git build of marimo has no frontend assets, so skew-protected `/api/kernel/*` calls (widgets, tables) fail there; use a released marimo or `--no-skew-protection`.

## What would help from marimo

pi-marimo is a third-party client and uses a few things marimo marks as internal. These would let it use only supported surfaces:

1. Host-API operations for interact-tier calls (UI values, function calls such as table search, model messages), so clients need no `/api/kernel/*` or skew-token scraping.
2. Attachment headers honored on the `/sse` and `/ws` session streams, so one connection both follows and attaches.
3. A stable staleness signal on the session stream until clients adopt host freshness.
4. `hosts-v1` records for released `marimo edit`, so token-protected servers are discoverable.
5. The marimo-pair skill's "wait for a browser" step relaxed where `runtime.start` or headless attach exists.
6. A versioned or changelogged code-mode surface.

## Roadmap

- Native host-protocol state: freshness, event cursors, input prompts.
- Discovery of token-protected servers through host records.
- A standalone viewer that runs beside any agent.
- A half-block image fallback for terminals without Kitty graphics.
- `@cell` and `@var` mentions in Pi's editor, and output diffs across runs.
