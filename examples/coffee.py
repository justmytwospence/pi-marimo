import marimo

__generated_with = "0.25.0"
app = marimo.App()


@app.cell
def _():
    import marimo as mo
    import numpy as np
    import pandas as pd
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import time

    return mo, np, pd, plt, time


@app.cell
def _(mo):
    mo.md("""
    # Coffee shop explorer

    A toy notebook for **pi-marimo's** terminal view: ninety days of sales at a
    small café, a few controls, a chart, a summary table, a slow forecast and one
    cell that is *meant* to break.

    - pick a drink and a smoothing window under **Controls**
    - the trend and the totals follow
    """)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Data
    """)
    return


@app.cell
def _(np, pd):
    rng = np.random.default_rng(7)
    days = pd.date_range("2026-01-01", periods=90, freq="D")
    drinks = ["latte", "espresso", "cold brew", "chai", "mocha"]
    base = {"latte": 60, "espresso": 35, "cold brew": 20, "chai": 18, "mocha": 25}
    rows = []
    for i, day in enumerate(days):
        weekend = day.dayofweek >= 5
        for d in drinks:
            trend = 1 + (0.012 * i if d == "cold brew" else 0.002 * i)
            cups = rng.poisson(base[d] * trend * (1.35 if weekend else 1.0))
            rows.append({"day": day.date().isoformat(), "drink": d, "cups": int(cups), "weekend": bool(weekend)})
    sales = pd.DataFrame(rows)
    sales
    return drinks, sales


@app.cell
def _(mo):
    mo.md("""
    ## Controls
    """)
    return


@app.cell
def _(drinks, mo):
    drink = mo.ui.dropdown(drinks, value="cold brew", label="drink")
    window = mo.ui.slider(1, 14, value=7, label="rolling window (days)")
    weekends = mo.ui.checkbox(value=True, label="include weekends")
    title = mo.ui.text(value="Winter into spring", label="chart title")
    mo.vstack([drink, window, weekends, title])
    return drink, title, weekends, window


@app.cell
def _(mo):
    mo.md("""
    ## Trend
    """)
    return


@app.cell
def _(drink, sales, weekends, window):
    picked = sales[sales["drink"] == drink.value]
    if not weekends.value:
        picked = picked[~picked["weekend"]]
    daily = picked.set_index("day")["cups"]
    smooth = daily.rolling(window.value, min_periods=1).mean()
    print(f"{drink.value}: {len(daily)} days, mean {daily.mean():.1f} cups/day")
    return daily, smooth


@app.cell
def _(daily, drink, plt, smooth, title, window):
    fig, ax = plt.subplots(figsize=(7, 3))
    ax.plot(range(len(daily)), daily.values, alpha=0.35, label="daily")
    ax.plot(range(len(smooth)), smooth.values, linewidth=2.5, label=f"{window.value}-day mean")
    ax.set_title(f"{title.value}: {drink.value}")
    ax.set_xlabel("day")
    ax.set_ylabel("cups")
    ax.legend()
    fig.tight_layout()
    fig
    return


@app.cell
def _(daily, drink, smooth, title, window):
    import plotly.graph_objects as go

    interactive = go.Figure()
    interactive.add_scatter(x=daily.index, y=daily.values, mode="markers", name="daily", opacity=0.45)
    interactive.add_scatter(x=smooth.index, y=smooth.values, mode="lines", name=f"{window.value}-day mean", line=dict(width=3))
    interactive.update_layout(title=f"{title.value}: {drink.value} (hover, drag to zoom)", xaxis_title="day", yaxis_title="cups", height=360, margin=dict(l=40, r=20, t=50, b=40))
    interactive
    return


@app.cell
def _(daily, drink, mo, smooth):
    change = (smooth.iloc[-1] / smooth.iloc[0] - 1) * 100
    mo.md(f"**{drink.value}** moved **{change:+.0f}%** over the period (smoothed), peaking at {daily.max()} cups.")
    return


@app.cell
def _(mo):
    mo.md("""
    ## Summary
    """)
    return


@app.cell
def _(sales):
    totals = sales.groupby("drink")["cups"].agg(["sum", "mean", "max"]).round(1).sort_values("sum", ascending=False)
    totals
    return (totals,)


@app.cell
def _(mo):
    mo.md("""
    ## Forecast (slow)
    """)
    return


@app.cell
def _(smooth, time):
    time.sleep(6)
    forecast = round(float(smooth.iloc[-7:].mean()) * 7)
    print(f"next week, about {forecast} cups")
    forecast
    return


@app.cell
def _(mo):
    mo.md("""
    ## Experimental
    """)
    return


@app.cell
def _(totals):
    mocha_share = totals.loc["mocha", "sum"] / totals["sum"].sum()
    f"mocha is {mocha_share:.0%} of all cups"
    return


@app.cell(hide_code=True)
def _(sales):
    best_day = sales.groupby("day")["cups"].sum().idxmax()
    best_day
    return


if __name__ == "__main__":
    app.run()
