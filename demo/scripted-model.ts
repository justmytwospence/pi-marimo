// The demo video's model: Pi's faux provider replays four scripted turns; the tool calls run for real. Loaded only by demo/launch.sh.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

const HEADLINE = `_hourly = station_rides.groupby(station_rides.index.hour).mean()
_weekend = station_rides.index.dayofweek >= 5
_lift = station_rides[_weekend].mean() / station_rides[~_weekend].mean() - 1
mo.hstack([
    mo.stat(f"{int(station_rides.sum()):,}", label="Rides", caption=f"{station.value}, four weeks"),
    mo.stat(f"{_hourly.idxmax():02d}:00", label="Busiest hour", caption=f"{_hourly.max():.0f} rides on average"),
    mo.stat(f"{station_rides.mean():.0f}", label="Rides per hour", caption="every hour of the day"),
    mo.stat(f"{_lift:+.0%}", label="Weekend lift", caption="rides per hour, vs weekdays", direction="increase" if _lift > 0 else "decrease"),
], justify="start", gap=2)`;

const CHART = `_frame = station_rides.reset_index()
_frame["day type"] = _frame["hour"].dt.dayofweek.map(lambda d: "weekend" if d >= 5 else "weekday")
_fig = px.box(_frame, x="day type", y="rides", color="day type", title=f"{station.value}: rides per hour, weekday vs weekend")
_fig.update_layout(showlegend=False, height=360, margin=dict(l=40, r=20, t=60, b=30))
_fig`;

const EDIT = `import marimo._code_mode as cm
async with cm.get_context() as ctx:
    ctx.cells["headline"].code
    ctx.edit_cell("headline", code='''${HEADLINE}''')
    cid = ctx.create_cell('''${CHART}''', after="rides_chart", name="weekday_chart")
    ctx.run_cell("headline")
    ctx.run_cell(cid)
print("edited headline, added weekday_chart")`;

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
        fauxThinking("station_rides is hourly rides for the selected station. Compare weekend and weekday hours: a box plot under the rides chart, and the lift as a fourth stat in the headline."),
        fauxText("I'll add a weekday vs weekend chart below the rides chart and put the weekend lift in the headline."),
        fauxToolCall("marimo_execute", { code: EDIT, label: "compare weekends", yield_ms: 0 }, { id: "call_demo_1" }),
      ],
      { stopReason: "toolUse" },
    ),
    // The execution outlives the call (yield_ms: 0); its completion resumes the session with the next response.
    fauxAssistantMessage("Both cells are running in the notebook; I'll check the chart when they finish."),
    fauxAssistantMessage(
      [
        fauxText("Both cells ran. Let me look at the chart."),
        fauxToolCall("marimo_chart", { cell: "weekday_chart" }, { id: "call_demo_2" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("At Harbor, weekend hours carry about **35% more rides** than weekday hours, and the whole distribution shifts up, not only the peaks. The headline shows the lift, and `weekday_chart` sits below `rides_chart`."),
  ]);
  pi.registerProvider(faux.provider);
}
