// The demo video's model: Pi's faux provider replays three scripted turns; the tool calls run for real. Loaded only by demo/launch.sh.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

const CELL = `_frame = station_rides.reset_index()
_frame["day type"] = _frame["hour"].dt.dayofweek.map(lambda d: "weekend" if d >= 5 else "weekday")
px.box(_frame, x="day type", y="rides", color="day type", title=f"{station.value}: rides per hour, weekday vs weekend")`;

const ADD_CELL = `import marimo._code_mode as cm
async with cm.get_context() as ctx:
    cid = ctx.create_cell('''${CELL}''', after="rides_chart", name="weekday_chart")
    ctx.run_cell(cid)
print("added weekday_chart")`;

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({
    provider: "demo",
    models: [{ id: "scripted", name: "Scripted" }],
    tokensPerSecond: 60,
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking("station_rides is hourly rides for the selected station. Split its hours into weekdays and weekends and compare their distributions with a box plot."),
        fauxText("I'll add a weekday vs weekend comparison right below the rides chart."),
        fauxToolCall("marimo_execute", { code: ADD_CELL, label: "add weekday chart", yield_ms: 0 }, { id: "call_demo_1" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("It's running in the notebook; I'll check the result when it finishes."),
    fauxAssistantMessage("Added **weekday_chart** below `rides_chart`. At Harbor, weekend hours average about 35% more rides than weekday hours."),
  ]);
  pi.registerProvider(faux.provider);
}
