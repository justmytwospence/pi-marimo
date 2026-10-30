import marimo

__generated_with = "0.25.2"
app = marimo.App()


@app.cell(hide_code=True)
def coffee_imports():
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
    mo.md("""
    # Coffee shop explorer
    ## Start here
    Ninety deterministic days, five drinks, 450 observations: follow cold brew from winter into spring. This is a live notebook, not a collection of terminal screenshots.

    Tour index: **Data → Controls → Trend → Altair → Rich output → Progress → Diagnostics → Pairing → Tour**.

    Plotly is live in the terminal: hover, drag, zoom, pan, toggle a legend and reset; `i` opens keyboard inspection. Plotly pointer selections do not flow back into Python. Altair/Vega are static terminal images that recompute with controls; the Altair brush works in the browser only. Without Kitty graphics, images may be unavailable; `liveCharts: false` uses static Plotly fallback. Terminal actions below are invitations for you, not Python output.
    """)
    return


@app.cell(hide_code=True)
def data_heading(mo):
    mo.md("""
    ## Data
    The original plain DataFrame follows. Use `t` or Enter on a table to page, sort, search/filter, select, view row cards and summaries. Select rows in Sales and watch Selected sales below. The two-table composition exercises independent leaf targeting; inventory includes dates, categories, numbers, booleans and missing values.
    """)
    return


@app.cell
def coffee_data(np, pd):
    rng = np.random.default_rng(7)
    days = pd.date_range("2026-01-01", periods=90, freq="D")
    drinks = ["latte", "espresso", "cold brew", "chai", "mocha"]
    base = {"latte": 60, "espresso": 35, "cold brew": 20, "chai": 18, "mocha": 25}
    rows = []
    for i, day in enumerate(days):
        weekend = day.day_of_week >= 5
        for d in drinks:
            trend = 1 + (0.012 * i if d == "cold brew" else 0.002 * i)
            cups = rng.poisson(base[d] * trend * (1.35 if weekend else 1.0))
            rows.append({"day": day.date().isoformat(), "drink": d, "cups": int(cups), "weekend": bool(weekend)})
    sales = pd.DataFrame(rows)
    sales
    return drinks, sales


@app.cell(hide_code=True)
def sales_table(mo, sales):
    sales_table = mo.ui.table(sales, pagination=True, page_size=12, selection="multi", initial_selection=[0, 1], freeze_columns_left=["day"], label="Sales · select rows")
    sales_table
    return (sales_table,)


@app.cell(hide_code=True)
def selected_sales(mo, sales_table):
    selected_sales = sales_table.value
    selected_sales_summary = {"selected rows": len(selected_sales), "cups": int(selected_sales["cups"].sum()) if len(selected_sales) else 0}
    mo.vstack([mo.as_html(selected_sales_summary), mo.ui.table(selected_sales, selection=None, label="Selected sales")])
    return


@app.cell(hide_code=True)
def inventory_tables(mo, pd, sales):
    inventory = sales.head(35).copy()
    inventory["day"] = pd.to_datetime(inventory["day"]).dt.date
    inventory["drink"] = inventory["drink"].astype("category")
    inventory["price"] = inventory["drink"].astype(str).map({"latte": 4.5, "espresso": 3.0, "cold brew": 4.0, "chai": 4.25, "mocha": 5.0})
    inventory["stock"] = [None if _i % 7 == 0 else 100 + _i for _i in range(len(inventory))]
    inventory["note"] = "Roasted locally; ask the barista about origin, tasting notes and seasonal alternatives."
    inventory["internal_id"] = range(len(inventory))
    inventory["origin"] = "Colombia"
    inventory["roast"] = "medium"
    inventory["supplier"] = "Neighbourhood roasters"
    inventory["batch"] = "winter-2026"
    inventory_table = mo.ui.table(inventory, pagination=True, page_size=7, freeze_columns_left=["day", "drink"], hidden_columns=["internal_id"], text_justify_columns={"cups": "right", "weekend": "center"}, wrapped_columns=["note"], column_widths={"note": 220}, style_cell=lambda _row, _col, _value: {"background-color": "#e8f3ed"} if _col == "cups" else {}, label="Inventory · styled, frozen and wrapped")
    totals = sales.groupby("drink")["cups"].agg(["sum", "mean", "max"]).round(1).sort_values("sum", ascending=False)
    totals_table = mo.ui.table(totals.reset_index(), selection=None, label="Drink totals")
    mo.vstack([inventory_table, totals_table])
    return (totals,)


@app.cell(hide_code=True)
def controls_heading(mo):
    mo.md("""
    ## Controls
    Each control has its own definition and rerun boundary. Drink/window/weekends/title retain the original trend story. Cup range, date bounds and multiselect filter the shared coffee data. Empty or reversed filters are safe. Price scales revenue; normalization changes trend units; aggregation changes daily totals; annotation and revision have separate observable outputs. `w` enters controls; Enter types, Space toggles/presses and Esc leaves.
    """)
    return


@app.cell(hide_code=True)
def drink_control(drinks, mo):
    drink = mo.ui.dropdown(drinks, value="cold brew", label="Trend drink")
    drink
    return (drink,)


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
def cup_range_control(mo):
    cup_range = mo.ui.range_slider(0, 150, value=[0, 150], label="Cups per observation")
    cup_range
    return (cup_range,)


@app.cell(hide_code=True)
def price_control(mo):
    price = mo.ui.number(0, 20, step=0.25, value=4.0, label="Estimated price per cup ($)")
    price
    return (price,)


@app.cell(hide_code=True)
def aggregation_control(mo):
    aggregation = mo.ui.radio(["sum", "mean"], value="sum", label="Daily aggregation")
    aggregation
    return (aggregation,)


@app.cell(hide_code=True)
def drink_choices_control(drinks, mo):
    drink_choices = mo.ui.multiselect(drinks, value=drinks, label="Drinks in shared filter")
    drink_choices
    return (drink_choices,)


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
    annotation = mo.ui.text_area(value="Cold brew grows as spring approaches.", rows=3, label="Analyst annotation")
    annotation
    return (annotation,)


@app.cell(hide_code=True)
def revision_control(mo):
    revision = mo.ui.button(value=0, on_click=lambda _n: _n + 1, label="Record revision")
    revision
    return (revision,)


@app.cell(hide_code=True)
def filtered_coffee(
    aggregation,
    cup_range,
    drink_choices,
    end_date,
    mo,
    pd,
    price,
    sales,
    start_date,
    weekends,
):
    filtered_sales = sales[(sales["drink"].isin(drink_choices.value)) & sales["cups"].between(*cup_range.value) & sales["day"].between(start_date.value.isoformat(), end_date.value.isoformat())]
    if not weekends.value:
        filtered_sales = filtered_sales[~filtered_sales["weekend"]]
    coffee_daily = filtered_sales.groupby("day")["cups"].agg(aggregation.value)
    revenue_estimate = float(filtered_sales["cups"].sum()) * price.value
    mo.ui.table(pd.DataFrame({"day": coffee_daily.index, "daily cups (" + aggregation.value + ")": coffee_daily.values}), selection=None, label=f"Filtered coffee · {len(filtered_sales)} observations · estimated revenue ${revenue_estimate:,.2f}")
    return (filtered_sales,)


@app.cell(hide_code=True)
def annotation_output(annotation, mo, revision):
    mo.md(f"""
    **Annotation:** {annotation.value}\n\nRevision count: **{revision.value}**
    """)
    return


@app.cell(hide_code=True)
def trend_heading(mo):
    mo.md("""
    ## Trend
    Cold brew has the strongest built-in seasonal growth. The first two charts follow the selected drink and shared filters; totals and heatmap use all filtered drinks. Hover for values, drag to zoom, choose pan, wheel to zoom, toggle traces in the legend and double-click to reset. The 3D surface uses deterministic local data: drag to rotate. `i` enters terminal chart mode; arrows move, Space starts/ends a drag, `+`/`-` zoom and `0` resets. Esc leaves.
    """)
    return


@app.cell(hide_code=True)
def trend_data(drink, filtered_sales, normalize, pd, window):
    picked = filtered_sales[filtered_sales["drink"] == drink.value]
    daily = picked.set_index("day")["cups"].astype(float)
    if normalize.value and len(daily):
        daily = daily / max(float(daily.iloc[0]), 1.0)
    smooth = daily.rolling(window.value, min_periods=1).mean()
    trend_frame = pd.DataFrame({"day": pd.to_datetime(daily.index), "daily": daily.values, "smoothed": smooth.values})
    print(f"{drink.value}: {len(daily)} days; units: {'relative to first day' if normalize.value else 'cups'}")
    return daily, smooth, trend_frame


@app.cell(hide_code=True)
def matplotlib_trend(daily, drink, normalize, pd, plt, smooth, title, window):
    fig, ax = plt.subplots(figsize=(9, 3.5))
    ax.plot(pd.to_datetime(daily.index), daily.values, alpha=0.4, label="daily")
    ax.plot(pd.to_datetime(smooth.index), smooth.values, linewidth=2.5, label=f"{window.value}-day mean")
    ax.set(title=f"{title.value}: {drink.value}", xlabel="Date", ylabel="Relative cups" if normalize.value else "Cups")
    ax.legend()
    fig.autofmt_xdate()
    fig.tight_layout()
    plt.close(fig)
    fig
    return


@app.cell(hide_code=True)
def plotly_trend(daily, drink, go, normalize, smooth, title, window):
    interactive = go.Figure()
    interactive.add_scatter(x=daily.index.tolist(), y=daily.values.tolist(), mode="markers", name="daily", opacity=0.5, hovertemplate="%{x}<br>%{y:.2f}<extra>Daily</extra>")
    interactive.add_scatter(x=smooth.index.tolist(), y=smooth.values.tolist(), mode="lines", name=f"{window.value}-day mean", line=dict(width=3))
    interactive.update_layout(title=f"{title.value}: {drink.value}", xaxis_title="Date", yaxis_title="Relative cups" if normalize.value else "Cups", height=380, margin=dict(l=60,r=25,t=60,b=55), template="plotly_white")
    interactive
    return


@app.cell(hide_code=True)
def plotly_stacked(drinks, filtered_sales, go):
    stacked = go.Figure()
    for _drink in drinks:
        _series = filtered_sales[filtered_sales["drink"] == _drink].groupby("day")["cups"].sum()
        stacked.add_bar(x=_series.index.tolist(), y=_series.values.tolist(), name=_drink)
    stacked.update_layout(barmode="stack", title="Daily cups by drink", xaxis_title="Date", yaxis_title="Cups", height=390, margin=dict(l=60,r=25,t=60,b=90), template="plotly_white")
    stacked
    return


@app.cell(hide_code=True)
def plotly_heatmap(drinks, filtered_sales, go, pd):
    _heat = filtered_sales.assign(weekday=pd.to_datetime(filtered_sales["day"]).dt.day_of_week).pivot_table(index="drink", columns="weekday", values="cups", aggfunc="mean").reindex(index=drinks, columns=range(7))
    heatmap = go.Figure(go.Heatmap(z=_heat.to_numpy().tolist(), x=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], y=drinks, colorscale="YlOrBr", colorbar=dict(title="Cups"), hovertemplate="%{y} · %{x}<br>%{z:.1f} cups<extra></extra>"))
    heatmap.update_layout(title="Mean cups by weekday and drink", height=360, margin=dict(l=90,r=60,t=60,b=65), template="plotly_white")
    heatmap
    return


@app.cell(hide_code=True)
def plotly_surface(go, np):
    _x = np.linspace(0, 1, 24)
    _y = np.linspace(0, 1, 20)
    _xx, _yy = np.meshgrid(_x, _y)
    surface = go.Figure(go.Surface(x=_x.tolist(), y=_y.tolist(), z=(40 + 30*_xx + 15*np.sin(np.pi*_yy)).tolist(), colorscale="Viridis", colorbar=dict(title="Cups")))
    surface.update_layout(title=dict(text="Synthetic coffee demand", y=0.94, yanchor="top"), scene=dict(camera=dict(eye=dict(x=1.7,y=1.7,z=1.5)), xaxis_title="Season",yaxis_title="Weekend",zaxis_title="Cups"), height=420, margin=dict(l=15,r=35,t=85,b=65))
    surface
    return


@app.cell(hide_code=True)
def trend_summary(daily, drink, mo, smooth):
    mo.md(f"**{drink.value}**: {len(daily)} selected days; smoothed change **{((smooth.iloc[-1] / smooth.iloc[0] - 1) * 100):+.0f}%**." if len(smooth) and smooth.iloc[0] else "No matching observations: widen the filters or choose another drink.")
    return


@app.cell(hide_code=True)
def altair_heading(mo):
    mo.md("""
    ## Altair
    The layered trend follows the same controls. The scatter/histogram shares a Vega-Lite interval selection: **brush in the browser**, then inspect Selected Altair records. The terminal shows a static image, not a pointer bridge. A separate raw Vega MIME object exercises Vega rather than Vega-Lite.
    """)
    return


@app.cell(hide_code=True)
def altair_trend(alt, drink, trend_frame):
    _base = alt.Chart(trend_frame).encode(x=alt.X("day:T", title="Date"))
    altair_trend = alt.layer(_base.mark_point(opacity=0.35).encode(y=alt.Y("daily:Q", title="Cups / relative cups"), tooltip=["day:T","daily:Q"]), _base.mark_line(color="#a35c27").encode(y="smoothed:Q")).properties(width=660, height=240, title=f"{drink.value}: daily and rolling mean")
    altair_trend
    return


@app.cell(hide_code=True)
def altair_brush(alt, filtered_sales, mo, pd):
    altair_records = filtered_sales.assign(day=pd.to_datetime(filtered_sales["day"]))
    _brush = alt.selection_interval(name="coffee_brush")
    _scatter = alt.Chart(altair_records).mark_circle(size=35).encode(x="day:T", y="cups:Q", color="drink:N", opacity=alt.condition(_brush, alt.value(0.8), alt.value(0.15)), tooltip=["day:T","drink:N","cups:Q"]).add_params(_brush).properties(width=660,height=210,title="Coffee observations · browser brush")
    _hist = alt.Chart(altair_records).mark_bar().encode(x=alt.X("cups:Q",bin=alt.Bin(maxbins=20)), y="count()",color="drink:N").transform_filter(_brush).properties(width=660,height=130,title="Brushed cup distribution")
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
def raw_vega(drinks, totals):
    class CoffeeVega:
        def _repr_mimebundle_(self, include=None, exclude=None):
            return {
                "application/vnd.vega.v5+json": {
                    "$schema": "https://vega.github.io/schema/vega/v5.json",
                    "background": "white",
                    "width": 500,
                    "height": 180,
                    "padding": 35,
                    "title": "All-season cups · raw Vega",
                    "data": [
                        {
                            "name": "coffee",
                            "values": [
                                {"drink": _d, "cups": int(totals.loc[_d, "sum"])}
                                for _d in drinks
                            ],
                        }
                    ],
                    "scales": [
                        {
                            "name": "x",
                            "type": "band",
                            "domain": {"data": "coffee", "field": "drink"},
                            "range": "width",
                            "padding": 0.2,
                        },
                        {
                            "name": "y",
                            "type": "linear",
                            "domain": {"data": "coffee", "field": "cups"},
                            "range": "height",
                            "zero": True,
                            "nice": True,
                        },
                    ],
                    "axes": [
                        {"orient": "bottom", "scale": "x"},
                        {"orient": "left", "scale": "y", "title": "Cups"},
                    ],
                    "marks": [
                        {
                            "type": "rect",
                            "from": {"data": "coffee"},
                            "encode": {
                                "enter": {
                                    "x": {"scale": "x", "field": "drink"},
                                    "width": {"scale": "x", "band": 1},
                                    "y": {"scale": "y", "field": "cups"},
                                    "y2": {"scale": "y", "value": 0},
                                    "fill": {"value": "#a35c27"},
                                }
                            },
                        }
                    ],
                }
            }


    vega_chart = CoffeeVega()
    vega_chart
    return


@app.cell(hide_code=True)
def rich_heading(mo):
    mo.md("""
    ## Rich output
    ### Notebook ingredients
    - **Markdown** with emphasis, lists and [marimo documentation](https://docs.marimo.io).
    - A coffee dataflow in two Mermaid forms.
    - A locally generated PNG and ordered mixed output.

    > A good notebook makes the computation and the story independently readable.

    The deliberately long source below exercises horizontal scrolling and line numbers (`H`/`L`, `0`, `#`/F7); it is an example, not executed code.

    ```python
    # Coffee review: a long example with enough lines for scrolling.
    filtered = sales.loc[sales["drink"].isin(["latte", "espresso", "cold brew", "chai", "mocha"]) & sales["cups"].between(0, 150), ["day", "drink", "cups", "weekend"]]
    summary = filtered.groupby("drink")["cups"].agg(["sum", "mean", "max"])
    summary = summary.sort_values("sum", ascending=False)
    for drink_name, row in summary.iterrows():
        print(drink_name, row["sum"])
    # Inspect data types before choosing filters.
    print(filtered.dtypes)
    # Keep the date order deterministic.
    daily = filtered.groupby("day")["cups"].sum().sort_index()
    rolling = daily.rolling(7, min_periods=1).mean()
    # Revenue here is an estimate, not accounting data.
    revenue = daily * 4.0
    print(revenue.head())
    print(rolling.tail())
    # End of the example.
    ```
    """)
    return


@app.cell(hide_code=True)
def mermaid_fence(mo):
    mo.md("""
    ### Coffee dataflow
    ```mermaid
    graph LR
      Sales --> Filters
      Controls --> Filters
      Filters --> Trend
      Filters --> Tables
      Filters --> Altair
    ```
    Use `s` on a diagram to inspect its source.
    """)
    return


@app.cell(hide_code=True)
def mermaid_object(mo):
    mo.mermaid("graph LR; Beans-->Grinder; Grinder-->Espresso; Espresso-->Latte; Espresso-->Mocha;")
    return


@app.cell(hide_code=True)
def coffee_png(io, mo, plt, totals):
    _badge, _badge_ax = plt.subplots(figsize=(4, 2))
    _badge_ax.bar(totals.index, totals["sum"], color="#a35c27")
    _badge_ax.set(title="Seasonal coffee totals", ylabel="Cups")
    _badge_ax.tick_params(axis="x", rotation=20)
    _badge.tight_layout()
    _png_buffer = io.BytesIO()
    _badge.savefig(_png_buffer, format="png", dpi=100)
    plt.close(_badge)
    coffee_png = _png_buffer.getvalue()
    mo.image(coffee_png)
    return


@app.cell(hide_code=True)
def mixed_output(mo, totals):
    mixed_note = mo.ui.text(value="Barista's tasting note", label="Mixed-output note")
    mixed_ready = mo.ui.checkbox(value=True, label="Ready to review")
    mo.vstack([mo.Html("<p><strong>Service board</strong> · prose, table, then controls in document order.</p>"), mo.ui.table(totals.reset_index(), selection=None, label="Service totals"), mo.hstack([mixed_note, mixed_ready])])
    return mixed_note, mixed_ready


@app.cell(hide_code=True)
def mixed_result(mixed_note, mixed_ready, mo):
    mo.md(f"""
    Service board note: {mixed_note.value} · ready: {mixed_ready.value}
    """)
    return


@app.cell(hide_code=True)
def progress_heading(mo):
    mo.md("""
    ## Progress
    All slow work is opt-in. Run one button at a time. Each short loop takes about three seconds and streams updates; the long loop takes twenty seconds. Press `x` twice to interrupt the long loop, `f` to follow running, and `T` for timing. Its dependent result demonstrates queued/blocked work. Run buttons reset after execution; rerun the cell with the button off to clear an interrupted state. No model is being fit.
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
        for _step in mo.status.progress_bar(range(12), title="Coffee forecast", completion_title="Forecast complete"):
            time.sleep(0.25)
            print(f"forecast sample {_step + 1}/12", flush=True)
        forecast = round(float(smooth.iloc[-7:].mean()) * 7) if len(smooth) else 0
        print(f"Next week: about {forecast} cups", flush=True)
    else:
        forecast = None
    return


@app.cell(hide_code=True)
def rich_progress(Console, Progress, rich_run, time):
    if rich_run.value:
        with Progress(console=Console(force_terminal=True, width=65), transient=False) as _progress:
            _task = _progress.add_task("Coffee roast", total=12)
            for _step in range(12):
                time.sleep(0.25)
                _progress.advance(_task)
                _progress.refresh()
        print("Rich roast complete", flush=True)
    return


@app.cell(hide_code=True)
def tqdm_progress(sys, time, tqdm, tqdm_run):
    if tqdm_run.value:
        for _step in tqdm(range(12), desc="Coffee deliveries", mininterval=0, file=sys.stdout):
            time.sleep(0.25)
        print("Deliveries complete", flush=True)
    return


@app.cell(hide_code=True)
def html_progress(mo):
    mo.Html('<label>Native HTML progress · static sample <progress value="7" max="10" aria-label="Coffee preparation">7/10</progress></label>')
    return


@app.cell(hide_code=True)
def synthetic_chains(mo):
    mo.Html('<p>Synthetic PyMC-style sample · no sampler or model fit</p><table class="pymc-progress-table"><tr><th>Chain</th><th>Draw</th><th>Divergences</th><th>Step size</th></tr><tr><td>0</td><td>60/100</td><td>0</td><td>0.25</td></tr><tr><td>1</td><td>100/100</td><td>0</td><td>0.31</td></tr></table>')
    return


@app.cell(hide_code=True)
def interrupt_loop(long_run, mo, time):
    if long_run.value:
        for _step in mo.status.progress_bar(range(20), title="Interruptible coffee audit", completion_title="Audit complete"):
            time.sleep(1)
            print(f"Audit {_step+1}/20", flush=True)
        long_result = "Twenty-second coffee audit finished"
    else:
        long_result = "Audit not run · press Run interrupt demo to begin"
    return (long_result,)


@app.cell(hide_code=True)
def interrupt_dependent(long_result):
    long_result + " · dependent result is ready"
    return


@app.cell(hide_code=True)
def diagnostics_heading(mo):
    mo.md(r"""
    ## Diagnostics
    The warning and ordinary stdout/stderr are deliberate; unexpected exceptions are not. Enable the checkbox to raise `ValueError` and block its descendant, then uncheck to clear both. `!` cycles All → Errors → Warnings → None; `\` toggles output independently. `e`/`E` navigate failures, `r` runs a cell, `R` twice runs stale cells, `A` twice runs all cells, `T` shows exact timing and `x` twice interrupts. Do not enable the error when running the whole notebook for a clean check.
    """)
    return


@app.cell(hide_code=True)
def warning_demo(sys, warnings):
    warnings.warn("Demo warning: coffee revenue is an estimate, not accounting data.", UserWarning)
    print("stdout: café opened normally", flush=True)
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
        raise ValueError("Intentional coffee demo error: uncheck Enable intentional ValueError to reset.")
    error_demo_result = "Diagnostics reset: no intentional error"
    return (error_demo_result,)


@app.cell(hide_code=True)
def error_dependent(error_demo_result):
    error_demo_result + " · dependent is unblocked"
    return


@app.cell(hide_code=True)
def pairing_heading(mo):
    mo.md("""
    ## Pairing
    Edit the ordinary Markdown below with Enter or `b`. In the parameter cell, change the price: F2/`:w` saves only (downstream becomes stale), F3/`:MarimoRun` saves and runs, F4 closes and F6 reverts with confirmation when dirty. `:q!` deliberately discards a draft. Browser/agent changes cause a conflict prompt rather than silent overwrite; compare or discard/reload. Unexpected editor exit retains the draft in memory, not across Pi restarts.

    `a` asks the agent about a cell, `:` runs scratchpad Python, `c`/`C` visit agent changes and `d` shows diffs. `<`/`>` follow dataflow. `m` marks a cell via Lens; `M` twice clears the mark. `v` opens variables, `P` packages. `/marimo chart plotly_trend` (or the agent's `marimo_chart`) puts a chart in chat; `/marimo inspect` drives the newest one.
    """)
    return


@app.cell(hide_code=True)
def editable_note(mo):
    mo.md("""
    ### Barista notebook
    Cold brew is our spring candidate. Edit this sentence to leave a note for the next shift.
    """)
    return


@app.cell(hide_code=True)
def pairing_parameter():
    review_price = 4.0
    review_price
    return (review_price,)


@app.cell(hide_code=True)
def pairing_result(review_price, sales):
    review_revenue = int(sales["cups"].sum()) * review_price
    f"Review price ${review_price:.2f} → seasonal revenue estimate ${review_revenue:,.2f}"
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

    - **Navigate and find:** `j`/`k` cells, Ctrl+J/K or `[`/`]` sections, `g`/`G` ends, `/` finds cell/variable/code/error; Esc cancels. `n`/`p` focus parts.
    - **Fold and inspect source:** Tab folds a section, Shift+Tab folds all; `O` switches whole section/cell. `B` folds code, `H`/`L` scroll, `0` resets, `#`/F7 toggles line numbers. Rich output has long fenced source; `s` shows Mermaid source.
    - **Help and long messages:** `?` opens context-aware help; Tab/Shift+Tab cycles categories, `/` searches keys/actions/descriptions, Esc clears search then closes. `?`/F1 closes outside search. F8 opens a long transient message; scroll then Esc/F8 returns with drafts retained.
    - **Dock, focus and resize:** `/marimo split coffee.py` docks; `|` toggles full screen, Ctrl+] changes chat/notebook focus, Ctrl+' docks/closes. Click a pane to focus; drag divider to resize. Pi dialogs temporarily use the full width.
    - **Mouse:** Wheel scrolls the pane under it; click selects a cell/part, double-click acts/edits. Controls support clicks, slider dragging and focused wheel stepping. Chart gestures are in Trend.

    ### Data and charts

    - **Tables:** Data: `t`, hjkl movement, `]`/`[` pages, `+`/`-` page size, `s`/`S` sort, `/` search, `f` filter, `F` clear, Space select, Enter row card, `i` statistics, `c` summaries. `y`/`Y` copies and `D` CSV export are **user-invoked side effects**, not run by this demo. Esc leaves.
    - **Controls:** Controls: `w`, j/k picks, h/l changes, H/L ten steps, Space toggles/presses, Enter types, Esc leaves. Dates use two separate date inputs, not date-range. Mixed output has multiple independently targetable leaves.
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
