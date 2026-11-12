# Editing cells

Edit Python and Markdown in an embedded Neovim buffer.

Enter on source or Markdown, or `b`, opens an embedded, isolated Neovim buffer. Eligible literal `mo.md(...)` cells open as Markdown; dynamic or otherwise unsafe-to-decode Markdown opens as Python source. Neovim runs with a clean built-in runtime, without your personal init, plugins or autocommands. Its normal editing keys, including Escape, Enter, `?`, `#`, `q`, `!`, `\`, `H`/`L`, motions, visual mode, registers, macros and Ex commands, belong to Neovim while editing.

| editor key or command | action |
|---|---|
| F1 | help |
| F2, `:w` | save only, without running |
| F3, `:MarimoRun` | save, then run the saved cell |
| F4, `:MarimoClose` | leave; dirty drafts require a decision |
| F5 | switch dock/full screen |
| F6, `:MarimoRevert` | revert to the last saved base, with confirmation if dirty |
| F7 | toggle line numbers |
| F8 | read the full transient message, retaining the editor draft |
| `:wq` | save only and close |
| `:q!` | deliberately discard and close |

A failed save keeps the draft. If the browser or agent changes the cell, saving detects the conflict rather than overwriting it: compare current source and draft, continue editing, copy the draft, or discard and reload. Unexpected Neovim exit retains the latest draft in memory for reopening, copying or discarding; it is not persistent recovery across Pi restarts. Dock transfers and chat focus preserve the editor. A save-and-run can save successfully but fail to run; the view reports that separately.
