# Configuration

Settings live in `marimo.json`.

`marimo.json`, merged in this order: `~/.config/agents/marimo.json`, `~/.pi/agent/marimo.json`, then the project's `.agents/marimo.json` and `.pi/marimo.json`.

```json
{
  "maxNotebooks": 8,
  "context": true,
  "liveCharts": true,
  "view": {
    "code": "open", "outputs": false, "split": false, "autoSplit": true,
    "chain": { "order": "file", "follow": "manual" },
    "lineNumbers": false, "diagnostics": "all", "showOutput": true,
    "editor": {
      "command": "nvim",
      "options": { "tabstop": 4, "shiftwidth": 4, "expandtab": true, "ignorecase": true, "smartcase": true, "scrolloff": 3 }
    }
  },
  "server": { "command": [] },
  "execution": { "command": [] },
  "completion": { "mode": "subscribed" },
  "pair": { "inbox": true }
}
```

| key | default | |
|---|---|---|
| `maxNotebooks` | `8` | notebooks followed at once in auto mode (1 to 32) |
| `context` | `true` | put the notebooks' state in the agent's context |
| `liveCharts` | `true` | run Plotly charts live; `false` draws pictures |
| `view.code` | `"open"` | cells' code open, or `"folded"` to its first line |
| `view.outputs` | `false` | start with the whole section in the detail |
| `view.split` | `false` | open the view docked instead of full screen |
| `view.autoSplit` | `true` | dock a notebook when the agent starts running it |
| `view.chain.order` | `"file"` | the run chain's starting order: `"file"` or `"run"` |
| `view.chain.follow` | `"manual"` | `"wave"` shows the run chain when a run starts while you are following |
| `view.lineNumbers` | `false` | line numbers in source, fenced code and editor |
| `view.diagnostics` | `"all"` | `"all"`, `"errors"`, `"warnings"` or `"none"` |
| `view.showOutput` | `true` | show stdout and results; independent of diagnostics and `view.outputs` |
| `view.editor.command` | `"nvim"` | Neovim executable as one nonempty string, not a shell command |
| `view.editor.options` | see above | native allowlist only: `tabstop` and `shiftwidth` integers 1–16, `scrolloff` 0–20, and booleans `expandtab`, `ignorecase`, `smartcase` |
| `server.command` | `[]` | how Pi starts marimo; empty means `uv run marimo` in a uv project, else `marimo` |
| `execution.command` | `[]` | argv prefix for official CLI execution; empty reuses a Pi-owned server's command/directory, then the server-command fallback |
| `pair.inbox` | `true` | attach to host-capable notebooks (marimo main) as an agent and turn notebook agent messages into prompts |
| `completion.mode` | `"subscribed"` | `"subscribed"`, `"all"` or `"off"`; changed on session start/reload, without stopping computation |

Live line-number, diagnostics and output toggles last for the Pi session and do not write the config file. `view.outputs` selects section view; it does not control output visibility. Invalid semantic settings use defaults and generate an aggregated warning; wrong-type values ignored during config merging remain silent.

`MARIMO_TOKEN` is sent to token-protected servers.
