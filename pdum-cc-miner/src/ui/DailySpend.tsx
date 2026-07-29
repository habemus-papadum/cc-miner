/**
 * DailySpend.tsx — spend per day, stacked by project.
 *
 * Observable Plot rather than a Mosaic client: this series is small (one row
 * per project-day) and already lives in a cell, so pushing it through the
 * coordinator would add a round-trip and a second reactivity system for no
 * gain. Mosaic earns its keep when a mark must query millions of rows or
 * participate in a brush — when the cross-filter views land, they use it; this
 * one does not need to.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import * as Plot from "@observablehq/plot";
import { createEffect, createSignal } from "solid-js";
import { graph } from "../model/graph";

interface DayRow {
  day: number;
  project: string;
  cost: number;
  turns: number;
}

/**
 * An imperative display island: Plot builds its own DOM, so this component
 * owns a container and re-renders into it when the data changes. Nothing
 * reactive lives inside the SVG.
 */
function SpendChart(props: {
  rows: DayRow[];
  /** Every day's total, unfiltered — the context the selection is read against. */
  totals: { day: number; cost: number }[];
  scale: { domain: string[]; range: string[] };
}) {
  const [host, setHost] = createSignal<HTMLDivElement | undefined>();

  createEffect(
    () => ({ el: host(), rows: props.rows, totals: props.totals, scale: props.scale }),
    ({ el, rows, totals, scale }) => {
      if (!el) return;
      el.replaceChildren();
      if (rows.length === 0) return;
      const chart = Plot.plot({
        width: 900,
        height: 260,
        marginLeft: 52,
        marginBottom: 32,
        x: { type: "utc", label: null, grid: false },
        y: { label: "USD / day", grid: true, tickFormat: (d: number) => `$${d}` },
        // The same (domain, range) the scatter uses, so a project is one
        // colour across the page rather than one per chart. See palette.ts.
        color: { legend: true, domain: scale.domain, range: scale.range },
        style: { background: "transparent", color: "var(--cco-fg-dim)", fontSize: "11px" },
        marks: [
          // The corpus behind the selection — same crossfilter idiom the
          // scatter uses. Drawn first so the coloured bars sit on top, and
          // scaled by the same y so the comparison is direct rather than
          // each chart re-normalising to whatever survived.
          Plot.rectY(totals, {
            x: (d: { day: number }) => new Date(d.day),
            interval: "day",
            y: "cost",
            fill: "#2a2f3a",
          }),
          Plot.rectY(rows, {
            x: (d: DayRow) => new Date(d.day),
            interval: "day",
            y: "cost",
            fill: "project",
            tip: true,
            title: (d: DayRow) =>
              `${d.project}\n${new Date(d.day).toISOString().slice(0, 10)}\n$${d.cost.toFixed(2)} · ${d.turns} turns`,
          }),
          Plot.ruleY([0], { stroke: "var(--cco-rule)" }),
        ],
      });
      el.append(chart);
    },
  );

  return <div class="cco-chart" ref={setHost} />;
}

export function DailySpend() {
  return (
    <section class="cco-panel">
      <h2 class="cco-h2">spend by day</h2>
      <CellView of={graph().dailyCost}>
        {(rows) => (
          <CellView of={graph().dailyTotals}>
            {(totals) => (
              <CellView of={graph().projects}>
                {(p) => <SpendChart rows={rows()} totals={totals()} scale={p().scale} />}
              </CellView>
            )}
          </CellView>
        )}
      </CellView>
    </section>
  );
}
