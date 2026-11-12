# Troubleshooting

- **A notebook does not show up.** pi-marimo finds servers through marimo's registry, which only servers started with `--no-token` write to. It follows notebooks under Pi's working directory, not in hidden directories or other Git repositories below it. Start it with `/marimo edit`, or pin it with `/marimo`.
- **Charts are blank.** You need a terminal with Kitty graphics. In herdr, set `experimental.kitty_graphics = true` and open a new pane.
- **`ctrl+'` does nothing.** Your terminal has to report the key (the kitty keyboard protocol does). `/marimo split` does the same.
- **"read-only" or 403 when running cells.** The browser tab that opened the notebook has closed. pi-marimo opens the notebook itself and retries, so this should not reach you; if it does, run `/marimo edit <file>`.
- **The agent edits the wrong notebook.** Several notebooks on one server: the context gives each one's marimo-pair flags, and pi-marimo warns on calls that could mean more than one.
- **Nothing follows my notebook on marimo main.** Check [Compatibility](compatibility.md) for the tested commit. `/marimo show` prints what pi-marimo sees.
- **Mermaid diagrams say they could not download.** The first diagram downloads a pinned, checksum-verified Mermaid bundle (about 5 MB) from jsDelivr into `~/.cache/pi-marimo/mermaid`. The diagram source is shown meanwhile; check your network and retry.
