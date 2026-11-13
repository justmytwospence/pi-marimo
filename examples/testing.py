# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
#     "numpy",
#     "pandas",
#     "matplotlib",
#     "plotly",
#     "altair",
#     "vl-convert-python",
#     "rich",
#     "tqdm",
#     "marimo-lens",
# ]
# ///

import marimo

__generated_with = "0.25.2"
app = marimo.App()


@app.cell(hide_code=True)
def imports():
    import marimo as mo
    import numpy as np
    import pandas as pd
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import time
    import plotly.graph_objects as go
    import altair as alt
    import io
    import sys
    import warnings
    from rich.progress import Progress
    from rich.console import Console
    from tqdm import tqdm
    from marimo_lens import Lens

    return (
        Console,
        Lens,
        Progress,
        alt,
        go,
        io,
        mo,
        np,
        pd,
        plt,
        sys,
        time,
        tqdm,
        warnings,
    )


@app.cell(hide_code=True)
def start_here(mo):
    mo.md(r"""
    # pi-marimo testing notebook
    This notebook exercises every surface the Pi view draws, one section each; each section says what to press and what you should see. The data is 90 deterministic days of trips at five bike stations, 450 observations: follow Ferry from winter into spring.

    Tour index: **Data → Controls → Trend → Altair → Rich output → Progress → Maintenance pipeline → Diagnostics → Pairing → Tour**.

    Plotly is live in the terminal: hover, drag, zoom, pan, toggle a legend and reset; `i` opens keyboard inspection. Plotly pointer selections do not flow back into Python. Altair/Vega are static terminal images that recompute with controls; the Altair brush works in the browser only. Without Kitty graphics, images may be unavailable; `liveCharts: false` uses static Plotly fallback. Terminal actions below are invitations for you, not Python output.
    """)
    return


@app.cell(hide_code=True)
def data_heading(mo):
    mo.md(r"""
    ## Data
    The original plain DataFrame follows, then a two-table composition; the docks table includes dates, categories, numbers, booleans and missing values.

    **Check:**
    - `t` or Enter on a table cell → a pinned-header viewport opens
    - click a cell → its row and column take focus
    - click a header → the table sorts
    - wheel → loaded rows scroll
    - `H`/`L` → the current column resizes
    - `=` → the column fits loaded values
    - Ctrl+G → choose a column
    - `v` → its full value is inspected
    - page, sort, search/filter, select, row cards and summaries → still use marimo’s kernel functions
    - select rows in Trips → Selected trips below follows
    - the two tables → are targeted independently as separate leaves
    """)
    return


@app.cell
def trips_data(np, pd):
    rng = np.random.default_rng(7)
    days = pd.date_range("2026-01-01", periods=90, freq="D")
    stations = ["Harbor", "Market", "Ferry", "Campus", "Park"]
    base = {"Harbor": 60, "Market": 35, "Ferry": 20, "Campus": 18, "Park": 25}
    rows = []
    for i, day in enumerate(days):
        weekend = day.day_of_week >= 5
        for d in stations:
            trend = 1 + (0.012 * i if d == "Ferry" else 0.002 * i)
            trips = rng.poisson(base[d] * trend * (1.35 if weekend else 1.0))
            rows.append({"day": day.date().isoformat(), "station": d, "trips": int(trips), "weekend": bool(weekend)})
    trips = pd.DataFrame(rows)
    trips
    return stations, trips


@app.cell(hide_code=True)
def trips_table(mo, trips):
    trips_table = mo.ui.table(trips, pagination=True, page_size=12, selection="multi", initial_selection=[0, 1], freeze_columns_left=["day"], label="Trips · select rows")
    trips_table
    return (trips_table,)


@app.cell(hide_code=True)
def selected_trips(mo, trips_table):
    selected_trips = trips_table.value
    selected_trips_summary = {"selected rows": len(selected_trips), "trips": int(selected_trips["trips"].sum()) if len(selected_trips) else 0}
    mo.vstack([mo.as_html(selected_trips_summary), mo.ui.table(selected_trips, selection=None, label="Selected trips")])
    return


@app.cell(hide_code=True)
def dock_tables(mo, pd, trips):
    docks = trips.head(35).copy()
    docks["day"] = pd.to_datetime(docks["day"]).dt.date
    docks["station"] = docks["station"].astype("category")
    docks["fare"] = docks["station"].astype(str).map({"Harbor": 3.5, "Market": 3.0, "Ferry": 4.0, "Campus": 2.5, "Park": 3.25})
    docks["bikes_available"] = [None if _i % 7 == 0 else 100 + _i for _i in range(len(docks))]
    docks["note"] = "Docks are checked every morning; report damaged bikes to the depot and ask staff about seasonal passes."
    docks["internal_id"] = range(len(docks))
    docks["city"] = "Riverton"
    docks["dock_type"] = "standard"
    docks["operator"] = "City Bikes"
    docks["season"] = "winter-2026"
    docks_table = mo.ui.table(docks, pagination=True, page_size=7, freeze_columns_left=["day", "station"], hidden_columns=["internal_id"], text_justify_columns={"trips": "right", "weekend": "center"}, wrapped_columns=["note"], column_widths={"note": 220}, style_cell=lambda _row, _col, _value: {"background-color": "#e8f3ed"} if _col == "trips" else {}, label="Docks · styled, frozen and wrapped")
    totals = trips.groupby("station")["trips"].agg(["sum", "mean", "max"]).round(1).sort_values("sum", ascending=False)
    totals_table = mo.ui.table(totals.reset_index(), selection=None, label="Station totals")
    mo.vstack([docks_table, totals_table])
    return (totals,)


@app.cell(hide_code=True)
def controls_heading(mo):
    mo.md(r"""
    ## Controls
    Each control has its own definition and rerun boundary; empty or reversed filters are safe.

    **Check:**
    - station, window, weekends and title → retain the original trend story
    - trip range, date bounds and multiselect → filter the shared trips data
    - fare → scales revenue
    - normalization → changes trend units
    - aggregation → changes daily totals
    - annotation and revision → have separate observable outputs
    - `w` or Enter on a control cell → keyboard control mode
    - Tab/Shift+Tab and `j`/`k` → move across controls in notebook order
    - `h`/`l` → adjust
    - Enter → type a slider value or `lower, upper` range
    - Space → toggle/press, or change the range handle
    - `o` → opens unsupported controls in the browser
    - Esc → leaves
    """)
    return


@app.cell(hide_code=True)
def station_control(stations, mo):
    station = mo.ui.dropdown(stations, value="Ferry", label="Trend station")
    station
    return (station,)


@app.cell(hide_code=True)
def window_control(mo):
    window = mo.ui.slider(1, 14, value=7, label="Rolling window (days)")
    window
    return (window,)


@app.cell(hide_code=True)
def weekends_control(mo):
    weekends = mo.ui.checkbox(value=True, label="Include weekends")
    weekends
    return (weekends,)


@app.cell(hide_code=True)
def title_control(mo):
    title = mo.ui.text(value="Winter into spring", label="Chart title")
    title
    return (title,)


@app.cell(hide_code=True)
def trip_range_control(mo):
    trip_range = mo.ui.range_slider(0, 150, value=[0, 150], label="Trips per observation")
    trip_range
    return (trip_range,)


@app.cell(hide_code=True)
def fare_control(mo):
    fare = mo.ui.number(0, 20, step=0.25, value=3.5, label="Estimated fare per trip ($)")
    fare
    return (fare,)


@app.cell(hide_code=True)
def aggregation_control(mo):
    aggregation = mo.ui.radio(["sum", "mean"], value="sum", label="Daily aggregation")
    aggregation
    return (aggregation,)


@app.cell(hide_code=True)
def station_choices_control(stations, mo):
    station_choices = mo.ui.multiselect(stations, value=stations, label="Stations in shared filter")
    station_choices
    return (station_choices,)


@app.cell(hide_code=True)
def normalize_control(mo):
    normalize = mo.ui.switch(value=False, label="Normalize trend to first day")
    normalize
    return (normalize,)


@app.cell(hide_code=True)
def start_date_control(mo):
    start_date = mo.ui.date(start="2026-01-01", stop="2026-03-31", value="2026-01-01", label="Start date")
    start_date
    return (start_date,)


@app.cell(hide_code=True)
def end_date_control(mo):
    end_date = mo.ui.date(start="2026-01-01", stop="2026-03-31", value="2026-03-31", label="End date")
    end_date
    return (end_date,)


@app.cell(hide_code=True)
def annotation_control(mo):
    annotation = mo.ui.text_area(value="Ferry ridership grows as spring approaches.", rows=3, label="Analyst annotation")
    annotation
    return (annotation,)


@app.cell(hide_code=True)
def revision_control(mo):
    revision = mo.ui.button(value=0, on_click=lambda _n: _n + 1, label="Record revision")
    revision
    return (revision,)


@app.cell(hide_code=True)
def filtered_trips(
    aggregation,
    trip_range,
    station_choices,
    end_date,
    mo,
    pd,
    fare,
    trips,
    start_date,
    weekends,
):
    filtered_trips = trips[(trips["station"].isin(station_choices.value)) & trips["trips"].between(*trip_range.value) & trips["day"].between(start_date.value.isoformat(), end_date.value.isoformat())]
    if not weekends.value:
        filtered_trips = filtered_trips[~filtered_trips["weekend"]]
    trips_daily = filtered_trips.groupby("day")["trips"].agg(aggregation.value)
    revenue_estimate = float(filtered_trips["trips"].sum()) * fare.value
    mo.ui.table(pd.DataFrame({"day": trips_daily.index, "daily trips (" + aggregation.value + ")": trips_daily.values}), selection=None, label=f"Filtered trips · {len(filtered_trips)} observations · estimated revenue ${revenue_estimate:,.2f}")
    return (filtered_trips,)


@app.cell(hide_code=True)
def annotation_output(annotation, mo, revision):
    mo.md(f"""
    **Annotation:** {annotation.value}\n\nRevision count: **{revision.value}**
    """)
    return


@app.cell(hide_code=True)
def trend_heading(mo):
    mo.md(r"""
    ## Trend
    Ferry has the strongest built-in seasonal growth. The first two charts follow the selected station and shared filters; totals and heatmap use all filtered stations. The 3D surface uses deterministic local data.

    **Check:**
    - hover → values show
    - drag → zoom
    - choose pan, then drag → pan
    - wheel → zoom
    - legend click → toggles traces
    - double-click → reset
    - drag the 3D surface → it rotates
    - `i` → terminal chart mode
    - arrows → move
    - Space → starts/ends a drag
    - `+`/`-` → zoom
    - `0` → resets
    - Esc → leaves
    """)
    return


@app.cell(hide_code=True)
def trend_data(station, filtered_trips, normalize, pd, window):
    picked = filtered_trips[filtered_trips["station"] == station.value]
    daily = picked.set_index("day")["trips"].astype(float)
    if normalize.value and len(daily):
        daily = daily / max(float(daily.iloc[0]), 1.0)
    smooth = daily.rolling(window.value, min_periods=1).mean()
    trend_frame = pd.DataFrame({"day": pd.to_datetime(daily.index), "daily": daily.values, "smoothed": smooth.values})
    print(f"{station.value}: {len(daily)} days; units: {'relative to first day' if normalize.value else 'trips'}")
    return daily, smooth, trend_frame


@app.cell(hide_code=True)
def matplotlib_trend(daily, station, normalize, pd, plt, smooth, title, window):
    fig, ax = plt.subplots(figsize=(9, 3.5))
    ax.plot(pd.to_datetime(daily.index), daily.values, alpha=0.4, label="daily")
    ax.plot(pd.to_datetime(smooth.index), smooth.values, linewidth=2.5, label=f"{window.value}-day mean")
    ax.set(title=f"{title.value}: {station.value}", xlabel="Date", ylabel="Relative trips" if normalize.value else "Trips")
    ax.legend()
    fig.autofmt_xdate()
    fig.tight_layout()
    plt.close(fig)
    fig
    return


@app.cell(hide_code=True)
def plotly_trend(daily, station, go, normalize, smooth, title, window):
    interactive = go.Figure()
    interactive.add_scatter(x=daily.index.tolist(), y=daily.values.tolist(), mode="markers", name="daily", opacity=0.5, hovertemplate="%{x}<br>%{y:.2f}<extra>Daily</extra>")
    interactive.add_scatter(x=smooth.index.tolist(), y=smooth.values.tolist(), mode="lines", name=f"{window.value}-day mean", line=dict(width=3))
    interactive.update_layout(title=f"{title.value}: {station.value}", xaxis_title="Date", yaxis_title="Relative trips" if normalize.value else "Trips", height=380, margin=dict(l=60,r=25,t=60,b=55), template="plotly_white")
    interactive
    return


@app.cell(hide_code=True)
def plotly_stacked(stations, filtered_trips, go):
    stacked = go.Figure()
    for _station in stations:
        _series = filtered_trips[filtered_trips["station"] == _station].groupby("day")["trips"].sum()
        stacked.add_bar(x=_series.index.tolist(), y=_series.values.tolist(), name=_station)
    stacked.update_layout(barmode="stack", title="Daily trips by station", xaxis_title="Date", yaxis_title="Trips", height=390, margin=dict(l=60,r=25,t=60,b=90), template="plotly_white")
    stacked
    return


@app.cell(hide_code=True)
def plotly_heatmap(stations, filtered_trips, go, pd):
    _heat = filtered_trips.assign(weekday=pd.to_datetime(filtered_trips["day"]).dt.day_of_week).pivot_table(index="station", columns="weekday", values="trips", aggfunc="mean").reindex(index=stations, columns=range(7))
    heatmap = go.Figure(go.Heatmap(z=_heat.to_numpy().tolist(), x=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], y=stations, colorscale="YlGnBu", colorbar=dict(title="Trips"), hovertemplate="%{y} · %{x}<br>%{z:.1f} trips<extra></extra>"))
    heatmap.update_layout(title="Mean trips by weekday and station", height=360, margin=dict(l=90,r=60,t=60,b=65), template="plotly_white")
    heatmap
    return


@app.cell(hide_code=True)
def plotly_surface(go, np):
    _x = np.linspace(0, 1, 24)
    _y = np.linspace(0, 1, 20)
    _xx, _yy = np.meshgrid(_x, _y)
    surface = go.Figure(go.Surface(x=_x.tolist(), y=_y.tolist(), z=(40 + 30*_xx + 15*np.sin(np.pi*_yy)).tolist(), colorscale="Viridis", colorbar=dict(title="Trips")))
    surface.update_layout(title=dict(text="Synthetic trip demand", y=0.94, yanchor="top"), scene=dict(camera=dict(eye=dict(x=1.7,y=1.7,z=1.5)), xaxis_title="Season",yaxis_title="Weekend",zaxis_title="Trips"), height=420, margin=dict(l=15,r=35,t=85,b=65))
    surface
    return


@app.cell(hide_code=True)
def trend_summary(daily, station, mo, smooth):
    mo.md(f"**{station.value}**: {len(daily)} selected days; smoothed change **{((smooth.iloc[-1] / smooth.iloc[0] - 1) * 100):+.0f}%**." if len(smooth) and smooth.iloc[0] else "No matching observations: widen the filters or choose another station.")
    return


@app.cell(hide_code=True)
def altair_heading(mo):
    mo.md(r"""
    ## Altair
    The layered trend follows the same controls. The scatter/histogram shares a Vega-Lite interval selection, and a separate raw Vega MIME object exercises Vega rather than Vega-Lite.

    **Check:**
    - brush in the browser → Selected Altair records inspects the selection
    - terminal → a static image, not a pointer bridge
    """)
    return


@app.cell(hide_code=True)
def altair_trend(alt, station, trend_frame):
    _base = alt.Chart(trend_frame).encode(x=alt.X("day:T", title="Date"))
    altair_trend = alt.layer(_base.mark_point(opacity=0.35).encode(y=alt.Y("daily:Q", title="Trips / relative trips"), tooltip=["day:T","daily:Q"]), _base.mark_line(color="#2a9d8f").encode(y="smoothed:Q")).properties(width=660, height=240, title=f"{station.value}: daily and rolling mean")
    altair_trend
    return


@app.cell(hide_code=True)
def altair_brush(alt, filtered_trips, mo, pd):
    altair_records = filtered_trips.assign(day=pd.to_datetime(filtered_trips["day"]))
    _brush = alt.selection_interval(name="trips_brush")
    _scatter = alt.Chart(altair_records).mark_circle(size=35).encode(x="day:T", y="trips:Q", color="station:N", opacity=alt.condition(_brush, alt.value(0.8), alt.value(0.15)), tooltip=["day:T","station:N","trips:Q"]).add_params(_brush).properties(width=660,height=210,title="Trip observations · browser brush")
    _hist = alt.Chart(altair_records).mark_bar().encode(x=alt.X("trips:Q",bin=alt.Bin(maxbins=20)), y="count()",color="station:N").transform_filter(_brush).properties(width=660,height=130,title="Brushed trip distribution")
    brush_chart = alt.vconcat(_scatter, _hist)
    altair_selection = mo.ui.altair_chart(brush_chart, chart_selection=True, label="Browser-only brush")
    altair_selection
    return (altair_selection,)


@app.cell(hide_code=True)
def altair_selected(altair_selection, mo):
    altair_selected_records = altair_selection.value
    mo.ui.table(altair_selected_records, selection=None, pagination=True, page_size=5, label="Selected Altair records · browser brush")
    return


@app.cell(hide_code=True)
def raw_vega(stations, totals):
    class TripsVega:
        def _repr_mimebundle_(self, include=None, exclude=None):
            return {
                "application/vnd.vega.v5+json": {
                    "$schema": "https://vega.github.io/schema/vega/v5.json",
                    "background": "white",
                    "width": 500,
                    "height": 180,
                    "padding": 35,
                    "title": "All-season trips · raw Vega",
                    "data": [
                        {
                            "name": "trips",
                            "values": [
                                {"station": _d, "trips": int(totals.loc[_d, "sum"])}
                                for _d in stations
                            ],
                        }
                    ],
                    "scales": [
                        {
                            "name": "x",
                            "type": "band",
                            "domain": {"data": "trips", "field": "station"},
                            "range": "width",
                            "padding": 0.2,
                        },
                        {
                            "name": "y",
                            "type": "linear",
                            "domain": {"data": "trips", "field": "trips"},
                            "range": "height",
                            "zero": True,
                            "nice": True,
                        },
                    ],
                    "axes": [
                        {"orient": "bottom", "scale": "x"},
                        {"orient": "left", "scale": "y", "title": "Trips"},
                    ],
                    "marks": [
                        {
                            "type": "rect",
                            "from": {"data": "trips"},
                            "encode": {
                                "enter": {
                                    "x": {"scale": "x", "field": "station"},
                                    "width": {"scale": "x", "band": 1},
                                    "y": {"scale": "y", "field": "trips"},
                                    "y2": {"scale": "y", "value": 0},
                                    "fill": {"value": "#2a9d8f"},
                                }
                            },
                        }
                    ],
                }
            }


    vega_chart = TripsVega()
    vega_chart
    return


@app.cell(hide_code=True)
def rich_heading(mo):
    mo.md(r"""
    ## Rich output
    ### Notebook ingredients
    - **Markdown** with emphasis, lists and [marimo documentation](https://docs.marimo.io).
    - A bike lifecycle in two Mermaid forms.
    - A locally generated PNG and ordered mixed output.

    > A good notebook makes the computation and the story independently readable.

    The deliberately long source below exercises horizontal scrolling and line numbers; it is an example, not executed code.

    **Check:**
    - `H`/`L` → horizontal scroll
    - `0` → reset scroll
    - `#`/F7 → line numbers

    ```python
    # Trip review: a long example with enough lines for scrolling.
    filtered = trips.loc[trips["station"].isin(["Harbor", "Market", "Ferry", "Campus", "Park"]) & trips["trips"].between(0, 150), ["day", "station", "trips", "weekend"]]
    summary = filtered.groupby("station")["trips"].agg(["sum", "mean", "max"])
    summary = summary.sort_values("sum", ascending=False)
    for station_name, row in summary.iterrows():
        print(station_name, row["sum"])
    # Inspect data types before choosing filters.
    print(filtered.dtypes)
    # Keep the date order deterministic.
    daily = filtered.groupby("day")["trips"].sum().sort_index()
    rolling = daily.rolling(7, min_periods=1).mean()
    # Revenue here is an estimate, not accounting data.
    revenue = daily * 3.5
    print(revenue.head())
    print(rolling.tail())
    # End of the example.
    ```
    """)
    return


@app.cell(hide_code=True)
def mermaid_fence(mo):
    mo.md(r"""
    ### Bike lifecycle
    ```mermaid
    graph LR
      Dock --> Bike
      Bike --> Ride
      Ride --> Return
      Return --> Dock
      Bike --> Repair
    ```
    Use `s` on a diagram to inspect its source.
    """)
    return


@app.cell(hide_code=True)
def mermaid_object(mo):
    mo.mermaid("graph LR; Dock-->Bike; Bike-->Ride; Ride-->Return; Return-->Dock; Bike-->Repair;")
    return


@app.cell(hide_code=True)
def fleet_png(io, mo, plt, totals):
    _badge, _badge_ax = plt.subplots(figsize=(4, 2))
    _badge_ax.bar(totals.index, totals["sum"], color="#2a9d8f")
    _badge_ax.set(title="Seasonal trip totals", ylabel="Trips")
    _badge_ax.tick_params(axis="x", rotation=20)
    _badge.tight_layout()
    _png_buffer = io.BytesIO()
    _badge.savefig(_png_buffer, format="png", dpi=100)
    plt.close(_badge)
    fleet_png = _png_buffer.getvalue()
    mo.image(fleet_png)
    return


@app.cell(hide_code=True)
def mixed_output(mo, totals):
    mixed_note = mo.ui.text(value="Dispatcher's note", label="Mixed-output note")
    mixed_ready = mo.ui.checkbox(value=True, label="Ready to review")
    mo.vstack([mo.Html("<p><strong>Dispatch board</strong> · prose, table, then controls in document order.</p>"), mo.ui.table(totals.reset_index(), selection=None, label="Dispatch totals"), mo.hstack([mixed_note, mixed_ready])])
    return mixed_note, mixed_ready


@app.cell(hide_code=True)
def mixed_result(mixed_note, mixed_ready, mo):
    mo.md(f"""
    Dispatch board note: {mixed_note.value} · ready: {mixed_ready.value}
    """)
    return


@app.cell(hide_code=True)
def progress_heading(mo):
    mo.md(r"""
    ## Progress
    All slow work is opt-in: run one button at a time. Each short loop takes about three seconds and streams updates; the long loop takes twenty seconds and its dependent result demonstrates queued/blocked work. No model is being fit.

    **Check:**
    - `x` twice → interrupts the long loop
    - `f` → follows running
    - `T` → timing
    - run buttons → reset after execution
    - rerun the cell with the button off → clears an interrupted state
    """)
    return


@app.cell(hide_code=True)
def forecast_run_control(mo):
    forecast_run = mo.ui.run_button(label='Run native forecast (~3s)')
    forecast_run
    return (forecast_run,)


@app.cell(hide_code=True)
def rich_run_control(mo):
    rich_run = mo.ui.run_button(label='Run Rich progress (~3s)')
    rich_run
    return (rich_run,)


@app.cell(hide_code=True)
def tqdm_run_control(mo):
    tqdm_run = mo.ui.run_button(label='Run tqdm progress (~3s)')
    tqdm_run
    return (tqdm_run,)


@app.cell(hide_code=True)
def long_run_control(mo):
    long_run = mo.ui.run_button(label='Run interrupt demo (~20s)')
    long_run
    return (long_run,)


@app.cell(hide_code=True)
def native_forecast(forecast_run, mo, smooth, time):
    if forecast_run.value:
        for _step in mo.status.progress_bar(range(12), title="Ridership forecast", completion_title="Forecast complete"):
            time.sleep(0.25)
            print(f"forecast sample {_step + 1}/12", flush=True)
        forecast = round(float(smooth.iloc[-7:].mean()) * 7) if len(smooth) else 0
        print(f"Next week: about {forecast} trips", flush=True)
    else:
        forecast = None
    return


@app.cell(hide_code=True)
def rich_progress(Console, Progress, rich_run, time):
    if rich_run.value:
        with Progress(console=Console(force_terminal=True, width=65), transient=False) as _progress:
            _task = _progress.add_task("Dock sweep", total=12)
            for _step in range(12):
                time.sleep(0.25)
                _progress.advance(_task)
                _progress.refresh()
        print("Rich sweep complete", flush=True)
    return


@app.cell(hide_code=True)
def tqdm_progress(sys, time, tqdm, tqdm_run):
    if tqdm_run.value:
        for _step in tqdm(range(12), desc="Bike deliveries", mininterval=0, file=sys.stdout):
            time.sleep(0.25)
        print("Deliveries complete", flush=True)
    return


@app.cell(hide_code=True)
def html_progress(mo):
    mo.Html('<label>Native HTML progress · static sample <progress value="7" max="10" aria-label="Dock check">7/10</progress></label>')
    return


@app.cell(hide_code=True)
def synthetic_chains(mo):
    mo.Html('<p>Synthetic PyMC-style sample · no sampler or model fit</p><table class="pymc-progress-table"><tr><th>Chain</th><th>Draw</th><th>Divergences</th><th>Step size</th></tr><tr><td>0</td><td>60/100</td><td>0</td><td>0.25</td></tr><tr><td>1</td><td>100/100</td><td>0</td><td>0.31</td></tr></table>')
    return


@app.cell(hide_code=True)
def interrupt_loop(long_run, mo, time):
    if long_run.value:
        for _step in mo.status.progress_bar(range(20), title="Interruptible fleet audit", completion_title="Audit complete"):
            time.sleep(1)
            print(f"Audit {_step+1}/20", flush=True)
        long_result = "Twenty-second fleet audit finished"
    else:
        long_result = "Audit not run · press Run interrupt demo to begin"
    return (long_result,)


@app.cell(hide_code=True)
def interrupt_dependent(long_result):
    long_result + " · dependent result is ready"
    return


@app.cell
def maintenance_heading(mo):
    mo.md(r"""
    ## Maintenance pipeline

    A longer dataflow chain for watching a run: intake feeds a service step, which splits into repair and condition, then joins into fleet status and a maintenance report. Each step takes about 1.5 seconds after you press the button; later reruns of any step stay slow.

    **Check:**
    - press the button → the whole chain takes about ten seconds
    - inspection notes → sits above the steps it depends on, so its run step lands out of file order
    - `@` → shows only this run
    - `~` → switches between file and run order
    """)
    return


@app.cell
def maintenance_run_control(mo):
    maintenance_run = mo.ui.run_button(label="Run maintenance pipeline (~10s)")
    maintenance_run
    return (maintenance_run,)


@app.cell
def intake(maintenance_run, trips, time):
    maintenance_delay = 1.5 if maintenance_run.value else 0.0
    time.sleep(maintenance_delay)
    bikes = trips.groupby("station")["trips"].sum()
    print(f"intake for {len(bikes)} stations", flush=True)
    bikes
    return bikes, maintenance_delay


@app.cell
def inspection_notes(fleet, maintenance_delay, time):
    time.sleep(maintenance_delay)
    inspection_notes = fleet.assign(note=["ready" if _a > 0.7 else "needs work" for _a in fleet["condition"]])
    inspection_notes
    return


@app.cell
def service_profile(bikes, maintenance_delay, time):
    time.sleep(maintenance_delay)
    serviced = (bikes * 0.85).rename("serviced")
    print("serviced", flush=True)
    serviced
    return (serviced,)


@app.cell
def repair(maintenance_delay, serviced, time):
    time.sleep(maintenance_delay)
    repaired = serviced.round().astype(int).rename("repaired")
    repaired
    return (repaired,)


@app.cell
def condition_profile(maintenance_delay, serviced, time):
    time.sleep(maintenance_delay)
    condition = (serviced / serviced.max()).round(2).rename("condition")
    condition
    return (condition,)


@app.cell
def fleet_status(condition, repaired, pd, maintenance_delay, time):
    time.sleep(maintenance_delay)
    fleet = pd.concat([repaired, condition], axis=1)
    fleet
    return (fleet,)


@app.cell
def maintenance_report(fleet, mo, maintenance_delay, time):
    time.sleep(maintenance_delay)
    maintenance_report_md = mo.md(f"**Maintenance report**: {int(fleet['repaired'].sum())} bikes repaired across {len(fleet)} stations; best condition: **{fleet['condition'].idxmax()}**.")
    maintenance_report_md
    return


@app.cell(hide_code=True)
def diagnostics_heading(mo):
    mo.md(r"""
    ## Diagnostics
    The warning and ordinary stdout/stderr are deliberate; unexpected exceptions are not. Do not enable the error when running the whole notebook for a clean check.

    **Check:**
    - enable the checkbox → `ValueError` is raised and its descendant is blocked
    - uncheck → both clear
    - `!` → cycles All → Errors → Warnings → None
    - `\` → toggles output independently
    - `e`/`E` → navigate failures
    - `r` → runs a cell
    - `R` twice → runs stale cells
    - `A` twice → runs all cells
    - `T` → shows exact timing
    - `x` twice → interrupts
    """)
    return


@app.cell(hide_code=True)
def warning_demo(sys, warnings):
    warnings.warn("Demo warning: fare revenue is an estimate, not accounting data.", UserWarning)
    print("stdout: depot opened normally", flush=True)
    print("stderr: diagnostic channel demonstration (not an exception)", file=sys.stderr, flush=True)
    return


@app.cell(hide_code=True)
def error_control(mo):
    error_enabled = mo.ui.checkbox(value=False, label="Enable intentional ValueError · uncheck to reset")
    error_enabled
    return (error_enabled,)


@app.cell(hide_code=True)
def intentional_error(error_enabled):
    if error_enabled.value:
        raise ValueError("Intentional testing error: uncheck Enable intentional ValueError to reset.")
    error_demo_result = "Diagnostics reset: no intentional error"
    return (error_demo_result,)


@app.cell(hide_code=True)
def error_dependent(error_demo_result):
    error_demo_result + " · dependent is unblocked"
    return


@app.cell(hide_code=True)
def pairing_heading(mo):
    mo.md(r"""
    ## Pairing
    Edit the ordinary Markdown below with Enter or `b`; in the parameter cell, change the fare. Browser/agent changes cause a conflict prompt rather than silent overwrite; compare or discard/reload. Unexpected editor exit retains the draft in memory, not across Pi restarts.

    **Check:**
    - F2/`:w` → saves only (downstream becomes stale)
    - F3/`:MarimoRun` → saves and runs
    - F4 → closes
    - F6 → reverts with confirmation when dirty
    - `:q!` → deliberately discards a draft
    - `a` → asks the agent about a cell
    - `:` → runs scratchpad Python
    - `c`/`C` → visit agent changes
    - `d` → shows diffs
    - `<`/`>` → follow dataflow
    - `m` → marks a cell via Lens
    - `M` twice → clears the mark
    - `v` → opens variables
    - `P` → opens packages
    - `/marimo chart plotly_trend` (or the agent's `marimo_chart`) → puts a chart in chat
    - `/marimo inspect` → drives the newest one
    """)
    return


@app.cell(hide_code=True)
def editable_note(mo):
    mo.md("""
    ### Dispatch notes
    Ferry is our spring candidate. Edit this sentence to leave a note for the next shift.
    """)
    return


@app.cell(hide_code=True)
def pairing_parameter():
    review_fare = 4.0
    review_fare
    return (review_fare,)


@app.cell(hide_code=True)
def pairing_result(review_fare, trips):
    review_revenue = int(trips["trips"].sum()) * review_fare
    f"Review fare ${review_fare:.2f} → seasonal revenue estimate ${review_revenue:,.2f}"
    return


@app.cell(hide_code=True)
def lens_dock(Lens):
    lens = Lens()
    lens
    return


@app.cell(hide_code=True)
def tour_heading(mo):
    mo.md(r"""
    ## Tour

    The notebook supplies real data and controls; the following terminal actions need your input. Optional companion plugins and extra notebooks are prerequisites, not simulated results.

    ### Navigate and explore

    - **Navigate and find:** `j`/`k` cells, Ctrl+D/U or `[`/`]` sections, `g`/`G` ends, `/` finds cell/variable/code/error; Ctrl+D/U or arrows step through search matches; Esc cancels. `n`/`p` focus parts without separator rules.
    - **Fold and inspect source:** Tab folds a section, Shift+Tab folds all; `O` switches whole section/cell. `B` folds code, `H`/`L` scroll, `0` resets, `#`/F7 toggles line numbers. Rich output has long fenced source; `s` shows Mermaid source.
    - **Help and long messages:** `?` opens context-aware help; Tab/Shift+Tab cycles categories, `/` searches keys/actions/descriptions, Esc clears search then closes. `?`/F1 closes outside search. F8 opens a long transient message; scroll then Esc/F8 returns with drafts retained.
    - **Dock, focus and resize:** `/marimo split testing.py` docks; `|` toggles full screen, Ctrl+] changes chat/notebook focus, Ctrl+' docks/closes. Click a pane to focus; drag divider to resize. Pi dialogs temporarily use the full width.
    - **Mouse:** Wheel scrolls the pane under it; click selects a cell/part, double-click acts/edits. Controls support clicks, slider dragging and focused wheel stepping. Chart gestures are in Trend.

    ### Data and charts

    - **Tables:** Data: `t`/Enter opens a pinned-header viewport; hjkl moves the active cell without selecting it, wheel moves rows, click cells to focus, click headers to sort (Shift-click adds a sort). `]`/`[` pages, `+`/`-` page size, `s`/`S` sort, `/` search, `f` filter, `F` clear, Space selects, Enter opens a row card, `i` statistics, `c` summaries. `H`/`L` resize a column, `=` fits loaded values, Ctrl+G chooses a column, and `v` shows its full value. `y`/`Y` copies and `D` CSV export are **user-invoked side effects**, not run by this demo. Esc leaves.
    - **Controls:** Controls: `w` or Enter enters; Tab/Shift+Tab or j/k moves across cells, h/l changes, H/L or Shift+Left/Right changes ten steps, Space toggles/presses or chooses a range handle, Enter types a slider number or `lower, upper` range, `o` opens unsupported controls in the browser, Esc leaves. Dates use two separate date inputs, not date-range. Mixed output has multiple independently targetable leaves.
    - **Charts and limits:** Trend: live Plotly hover/drag/pan/zoom/legend/reset and `i` keyboard mode. Altair: browser-only brush, reactive static terminal images; raw Vega in Altair and PNG in Rich output. Static Plotly fallback uses `liveCharts: false`. Kitty graphics is required for inline images; unavailable rendering is a capability limit, not a fabricated chart.

    ### Run and pair

    - **Progress and diagnostics:** Progress buttons are opt-in; `f` follows running, `T` timing, `x` twice interrupts. Diagnostics checkbox causes and resets a real error/block; `!`, `\`, `e`/`E`, `r`/`R`/`A` inspect/recover. Stdout is the current redraw display, not a lossless log.
    - **Editing and recovery:** Pairing: Enter/`b` edits Markdown/source in isolated Neovim; F1 help, F2 save only, F3 save/run, F4 close, F5 dock/fullscreen, F6 revert, F7 lines, F8 full message. Dirty/conflict dialogs have cancel/continue paths; failed save preserves the draft.
    - **Pair with the agent:** Pairing: `a`, `:`, `c`/`C`, `d`, `<`/`>`; Lens `m` and `M` twice. Changes clear with your next prompt. `/marimo lens` lists marks; chart-in-chat uses `/marimo chart <cell>`.

    ### Inspect the environment

    - **Variables:** `v`, j/k, `/` filter, `s` sort, Enter preview, `d` definition, `>` use, `a` ask, `t` table. `y`/`Y` clipboard writes are user-invoked. Esc backs out. Previews are marimo reprs, not deep evaluation.
    - **Packages:** `P`, Tab Installed/Missing/Operations, `/` filter, Enter details, `r` refresh. `a` install, `u` upgrade, `x` remove require cancel-first confirmation with kernel fingerprint: **cancel to explore safely**. Environment may be shared; no automatic restart. Unknown operation outcome: reconcile before retrying.

    ### Sessions and integrations

    - **Multiple notebooks:** **Requires another user-opened notebook**: `}`/`{` switches, `/marimo` chooses followed notebooks, `/marimo auto` or `/marimo off` controls following. Off does not stop a kernel. `/marimo show` prints context.
    - **Status and context:** Rows under the prompt retain `name:port · state`; use ↓ at prompt bottom then Enter; `x` twice interrupts. Running/queued/error/stale and widget changes feed agent context; `context: false` disables it.
    - **Lifecycle:** **User-invoked only**: `/marimo new <file.py>` creates/starts, `/marimo edit [file]` opens/starts, `/marimo open` opens waiting browser, `/marimo view [file]` full screen. `/marimo stop [file]` stops a Pi-started server; `S` twice confirms stop (cancel by not pressing again). Esc returns to chat; docked `q` closes the view, not the kernel.
    - **Companion plugins:** **Optional installs required**: pi-bg `/tasks` and `bg_wait` track notebook work; pi-subagents shares rows, pi-sidebar shares the right pane, pi-status-footer shows status, pi-herdr exposes running/finish notifications, pi-next-prompt offers Lens addressing, pi-vim supplies prompt motions. Without them no integration is claimed.

    No package removal/upgrade, clipboard write, CSV export, extra notebook creation or server shutdown is performed by this tour. Legacy IPython widget and fastprogress display-handle transports are not guaranteed. The HTML progress and synthetic chain samples are explicitly static demonstrations.
    """)
    return


if __name__ == "__main__":
    app.run()
