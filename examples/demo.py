# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
#     "numpy",
#     "pandas",
#     "plotly",
# ]
# ///

import marimo

__generated_with = "0.25.0"
app = marimo.App(width="medium")


@app.cell
def imports():
    import marimo as mo
    import numpy as np
    import pandas as pd
    import plotly.express as px
    import plotly.io as pio

    pio.templates.default = "plotly_dark"
    return mo, np, pd, px


@app.cell
def intro(mo):
    mo.md("""
    # City bikes

    Four weeks of hourly rides at four docking stations. Pick a station and a smoothing window, select days in the table to mark them on the chart, or ask the agent to add an analysis.
    """)
    return


@app.cell
def rides_data(np, pd):
    _rng = np.random.default_rng(42)
    _hours = pd.date_range("2026-06-01", periods=24 * 28, freq="h")
    _h = np.asarray(_hours.hour)
    _base = 40 + 30 * np.clip(np.sin((_h - 6) / 24 * 2 * np.pi), 0, None)
    rides = pd.DataFrame({
        "hour": _hours,
        "station": _rng.choice(["Harbor", "Market", "Campus", "Park"], len(_hours)),
        "rides": _rng.poisson(_base * np.where(np.asarray(_hours.day_of_week) >= 5, 1.3, 1.0)),
        "temperature": np.round(18 + 8 * np.sin((_h - 9) / 24 * 2 * np.pi) + _rng.normal(0, 1.5, len(_hours)), 1),
    })
    return (rides,)


@app.cell
def controls_heading(mo):
    mo.md("""
    ## Controls
    """)
    return


@app.cell
def station_control(mo, rides):
    station = mo.ui.dropdown(sorted(rides["station"].unique()), value="Harbor", label="Station")
    station
    return (station,)


@app.cell
def smoothing_control(mo):
    window = mo.ui.slider(1, 24, value=3, label="Smoothing (hours)")
    window
    return (window,)


@app.cell
def overview_heading(mo):
    mo.md("""
    ## Overview
    """)
    return


@app.cell
def station_rides(rides, station):
    station_rides = rides[rides["station"] == station.value].set_index("hour")["rides"]
    return (station_rides,)


@app.cell
def headline(mo, station, station_rides):
    _peak = station_rides.groupby(station_rides.index.hour).mean().idxmax()
    mo.md(f"**{station.value}**: {int(station_rides.sum()):,} rides in four weeks, busiest at {_peak:02d}:00.")
    return


@app.cell
def rides_chart(daily, pd, px, station, station_rides, window):
    _smooth = station_rides.rolling(window.value, min_periods=1).mean()
    _fig = px.line(_smooth, title=f"{station.value}: rides per hour, {window.value}h average", labels={"value": "rides", "hour": ""})
    _fig.update_traces(line_color="#f5a97f")
    _fig.update_layout(showlegend=False, height=360, margin=dict(l=40, r=20, t=60, b=30))
    for _day in daily.value["day"]:
        _fig.add_vrect(x0=pd.Timestamp(_day), x1=pd.Timestamp(_day) + pd.Timedelta(days=1), fillcolor="#8bd5ca", opacity=0.25, line_width=0)
    _fig
    return


@app.cell
def days_heading(mo):
    mo.md("""
    ## Days
    """)
    return


@app.cell
def daily_table(mo, rides, station):
    _daily = (
        rides[rides["station"] == station.value]
        .assign(day=lambda d: d["hour"].dt.date)
        .groupby("day")
        .agg(rides=("rides", "sum"), temperature=("temperature", "mean"))
        .round(1)
        .reset_index()
    )
    daily = mo.ui.table(_daily, page_size=7, label="Daily totals: select days to mark them on the chart")
    daily
    return (daily,)


@app.cell
def selection_summary(daily, mo):
    _picked = daily.value
    mo.md(f"**{len(_picked)}** day(s) selected, **{int(_picked['rides'].sum()) if len(_picked) else 0:,}** rides.")
    return


if __name__ == "__main__":
    app.run()
