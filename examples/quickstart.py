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

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def imports():
    import marimo as mo
    import numpy as np
    import pandas as pd
    import plotly.express as px
    return mo, np, pd, px


@app.cell
def title(mo):
    mo.md("""
    # Bike share quickstart

    A small notebook for trying pi-marimo: press `ctrl+'` in Pi to dock it, then ask the agent to change something.
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
    window = mo.ui.slider(1, 24, value=6, label="Smoothing (hours)")
    window
    return (window,)


@app.cell
def results_heading(mo):
    mo.md("""
    ## Results
    """)
    return


@app.cell
def station_rides(rides, station):
    station_rides = rides[rides["station"] == station.value].set_index("hour")["rides"]
    return (station_rides,)


@app.cell
def rides_chart(px, station, station_rides, window):
    _smooth = station_rides.rolling(window.value, min_periods=1).mean()
    px.line(_smooth, title=f"{station.value}: rides per hour, {window.value}h average", labels={"value": "rides", "hour": ""})
    return


@app.cell
def daily_table(mo, rides, station):
    _daily = rides[rides["station"] == station.value].assign(day=lambda d: d["hour"].dt.date).groupby("day").agg(rides=("rides", "sum"), temperature=("temperature", "mean")).round(1).reset_index()
    daily = mo.ui.table(_daily, label="Daily totals (select rows)")
    daily
    return (daily,)


@app.cell
def selection_summary(daily, mo):
    _picked = daily.value
    mo.md(f"**{len(_picked)}** day(s) selected, **{int(_picked['rides'].sum()) if len(_picked) else 0}** rides.")
    return


if __name__ == "__main__":
    app.run()
