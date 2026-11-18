# The demo video. Run through `npm run demo` (demo/record.sh), which stages /tmp/pi-marimo-demo.
# The window is wide enough (about 190 columns) for the notebook pane to show its outline beside
# the detail; narrower, the outline stacks above it.
# foley v0.1.0 cannot send Ctrl chords to Pi, so the tape never uses them; cells are selected with /name.
# Insert inside Hide/Show cues the next caption. `# demo: show <keys>` puts the next command's keys on
# screen; other typing (commands, cell names, the prompt) stays off it. demo/annotate.py draws both.
Output take.mp4
Output take.cast
Output demo.txt
Set Shell bash
Set Width 1900
Set Height 1000
Set FontSize 14
Set TypingSpeed 35ms
Set Framerate 30
Set WaitTimeout 120s

Hide
Type "./launch.sh"
Enter
Wait+Screen /scripted/
Show
Sleep 2s

# Open the notebook docked beside the chat, and run it.
Hide
Insert
Show
Sleep 1200ms
Type "/marimo edit demo.py"
Sleep 300ms
Enter
Sleep 300ms
Enter
Wait+Screen /Notebook demo\.py/
Sleep 1s
Hide
Insert
Show
Sleep 1200ms
# demo: show A A
Type "AA"
Sleep 2s
Wait+Screen /demo\.py  idle/
Sleep 500ms
# demo: show /
Type "/"
Type "rides_chart"
Sleep 300ms
Enter
Sleep 1800ms
Screenshot beat1_chart.png

# Ask the agent from the chart cell; it edits one cell and adds another.
Hide
Insert
Show
Sleep 1200ms
# demo: show a
Type "a"
Sleep 500ms
Type "how do weekends compare?"
Sleep 400ms
# demo: show Enter
Enter
Wait+Screen /look at the chart/
Screenshot beat2_running.png
Hide
Insert
Show
Wait+Screen /sits below/
Sleep 2s
Screenshot beat3_agent.png

# Drive the slider.
Hide
Insert
Show
Sleep 1200ms
# demo: show /
Type "/"
Type "smoothing_control"
Sleep 300ms
Enter
Sleep 700ms
# demo: show w
Type "w"
Sleep 600ms
# demo: show L
Type "L"
Sleep 1200ms
# demo: show Esc
Escape
Sleep 400ms
# demo: show /
Type "/"
Type "rides_chart"
Sleep 300ms
Enter
Sleep 1800ms
Screenshot beat4_smoothed.png

# Select two days in the table; the chart marks them.
Hide
Insert
Show
Sleep 1200ms
# demo: show /
Type "/"
Type "daily_table"
Sleep 300ms
Enter
Sleep 800ms
# demo: show t
Type "t"
Sleep 700ms
# demo: show j j
Type "jj"
# demo: show Space
Space
Sleep 400ms
# demo: show j j j
Type "jjj"
# demo: show Space
Space
Sleep 1200ms
Screenshot beat5_table.png
# demo: show Esc
Escape
Sleep 400ms
# demo: show /
Type "/"
Type "rides_chart"
Sleep 300ms
Enter
Sleep 1800ms
Screenshot beat6_marked.png

# The agent's changes: the new chart, then the changed headline and its diff.
Hide
Insert
Show
Sleep 1200ms
# demo: show c
Type "c"
Sleep 2s
Screenshot beat7_new.png
# demo: show c
Type "c"
Sleep 2s
Screenshot beat8_changed.png
Hide
Insert
Show
Sleep 1200ms
# demo: show d
Type "d"
Sleep 2s
Screenshot beat9_diff.png

# Undo it.
Hide
Insert
Show
Sleep 1200ms
# demo: show u
Type "u"
Sleep 1500ms
Screenshot beat10_confirm.png
# demo: show ↓ ↓
Down 2
Sleep 600ms
# demo: show Enter
Enter
Sleep 2s
Screenshot beat11_reverted.png
