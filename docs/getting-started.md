# Getting started

## Install

You need [Pi](https://pi.dev) in a terminal, Node 22.19 or later, and marimo (verified with 0.25.2 and marimo main).

```sh
# Pi: the installer from pi.dev, or npm
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

pi install npm:pi-marimo

# Lets the agent edit cells; add -g for every project
npx skills add marimo-team/marimo-pair -s marimo-pair -a pi
```

Docking the notebook beside the chat needs `"tuiMode": "fullscreen"` in Pi's settings. Charts need a terminal with Kitty graphics (Ghostty, Kitty, herdr). Inline editing needs Neovim 0.10 or later.

## A 60-second tour

The repository ships a small bike-share notebook with a dropdown, a slider, a live Plotly chart and a selectable table: [`examples/quickstart.py`](https://github.com/justmytwospence/pi-marimo/blob/main/examples/quickstart.py). Its dependencies are declared in the file. Download it, then start Pi next to it:

```sh
pi
```

1. In Pi, open it: `/marimo edit quickstart.py`. Pi starts a marimo server if none is running; no browser is needed.
2. Press `ctrl+'`. The notebook docks beside the chat. `ctrl+]` switches between the chat and the notebook, and `?` lists every key.
3. Press `r` on a cell to run it, or `A` twice to run them all. `w` drives the controls; `t` drives the table.
4. Ask the agent: "add a weekday versus weekend comparison chart". Watch the cell run; press `c` to jump to what it changed, `d` for the diff, `u` to revert.

!!! tip
    A notebook you already have open in the browser (started with `marimo edit --no-token`) is followed automatically when it is under Pi's working directory.

## If something does not show up

See [Troubleshooting](troubleshooting.md).
