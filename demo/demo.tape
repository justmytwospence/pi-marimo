# The demo video. Run through `npm run demo` (demo/record.sh), which stages /tmp/pi-marimo-demo.
# foley v0.1.0 cannot send Ctrl chords to Pi, so the tape never uses them; cells are selected with /name.
Output demo.mp4
Output demo.txt
Set Shell bash
Set Width 1400
Set Height 800
Set FontSize 14
Set TypingSpeed 45ms
Set Framerate 30
Set WaitTimeout 120s

Hide
Type "./launch.sh"
Enter
Wait+Screen /scripted/
Show
Sleep 800ms

# Open the notebook docked beside the chat, and run it.
Type "/marimo edit demo.py"
Sleep 400ms
Enter
Sleep 300ms
Enter
Wait+Screen /Notebook demo\.py/
Sleep 1s
Type "AA"
Sleep 3s
Wait+Screen /demo\.py  idle/
Sleep 1s
Type "/rides_chart"
Sleep 300ms
Enter
Sleep 2500ms
Screenshot beat1_chart.png

# Drive the slider.
Type "/smoothing_control"
Sleep 300ms
Enter
Sleep 800ms
Type "w"
Sleep 600ms
Type "L"
Sleep 1200ms
Escape
Sleep 400ms
Type "/rides_chart"
Sleep 300ms
Enter
Sleep 2500ms
Screenshot beat2_smoothed.png

# Select two days in the table; the chart marks them.
Type "/daily_table"
Sleep 300ms
Enter
Sleep 1s
Type "t"
Sleep 800ms
Type "jj"
Space
Sleep 400ms
Type "jjj"
Space
Sleep 1200ms
Screenshot beat3_table.png
Escape
Sleep 400ms
Type "/rides_chart"
Sleep 300ms
Enter
Sleep 3s
Screenshot beat4_marked.png

# Ask the agent from the chart cell.
Type "a"
Sleep 600ms
Type "compare weekdays and weekends"
Sleep 500ms
Enter
Wait+Screen /more rides than weekday/
Sleep 1500ms
Screenshot beat5_agent.png

# Jump to its change, then its diff.
Type "c"
Sleep 3s
Screenshot beat6_change.png
# Hide the output so the diff has room.
Type `\`
Sleep 800ms
Type "d"
Sleep 3s
Screenshot beat7_diff.png
