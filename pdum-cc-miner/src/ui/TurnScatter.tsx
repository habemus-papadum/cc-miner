/**
 * TurnScatter.tsx — one dot per billed turn (playbook layer 3).
 *
 * The other half of the crossfilter, and the one view here built from **stock
 * vgplot marks** rather than a hand-written client. The session graph needed a
 * custom `MosaicClient` because its y position is a lane assignment no SQL
 * expression produces; this needs nothing of the sort — x is a timestamp, y is
 * a number, colour is a category — so it is `vg.dot` over `vg.from("turns")`
 * and Mosaic does the rest.
 *
 * That difference is the point of having both. Between them they show where the
 * line falls: a mark whose position is a function of its row is stock, and a
 * mark whose position depends on every other row is not.
 *
 * **It publishes as well as reads.** `intervalXY` writes a clause covering both
 * axes, so dragging a box here filters by time AND by cost — a dimension no
 * other view can express. That is what makes it a crossfilter participant
 * rather than a picture of one.
 *
 * **The context is ours, not the default.** `vg.plot` resolves its coordinator
 * from the module-global unless given one, and this app runs its own (with
 * preagg off — see store.ts). `createAPIContext` is what binds the marks to it.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { createAPIContext } from "@uwdata/vgplot";
import { createEffect, createSignal, Show } from "solid-js";
import { graph } from "../model/graph";
import { filter, store, viewFilter } from "../model/store";

/**
 * Log y, because turn cost spans nearly three orders of magnitude: p01 is
 * $0.025, the median $0.22, the maximum $20.86. On a linear axis 99% of the
 * corpus is a smear along the bottom and the only readable feature is the
 * handful of outliers — which the panel above already covers.
 *
 * Log cannot draw a zero, so the zero-cost turns are counted and named in the
 * note rather than silently dropped.
 */
function ScatterPlot(props: {
  zeroCost: number;
  turns: number;
  scale: { domain: string[]; range: string[] };
}) {
  const [host, setHost] = createSignal<HTMLDivElement | undefined>();
  const [error, setError] = createSignal<string | null>(null);

  createEffect(
    () => ({ el: host(), scale: props.scale }),
    ({ el, scale }) => {
      if (!el) return;
      el.replaceChildren();
      try {
        const vg = createAPIContext({ coordinator: store.coordinator });
        const chart = vg.plot(
          // Two layers over the same rows, which is the whole crossfilter
          // idiom: the base is EVERY turn and carries no `filterBy`, so it
          // never moves; the coloured layer is what survives. A selection then
          // reads against the shape it came from instead of the rest of the
          // data vanishing and leaving nothing to judge it against.
          //
          // Grey rather than a faded version of each project's colour: 30,000
          // dots at low alpha still read as colour, and the point of the base
          // is to be visibly *not* the selection.
          vg.dot(vg.from("turns"), {
            x: "ts",
            y: "costTotal",
            fill: "#8b93a7",
            r: 1.4,
            fillOpacity: 0.12,
          }),
          // `viewFilter`, not `filter`: a crossfilter would hide this plot's
          // own brush from its own marks, so dragging a box here left every dot
          // fully coloured and the selection invisible. See store.ts.
          vg.dot(vg.from("turns", { filterBy: viewFilter }), {
            x: "ts",
            y: "costTotal",
            fill: "project",
            r: 1.6,
            fillOpacity: 0.5,
          }),
          // Publishes into the same crossfilter the timeline uses. Two axes, so
          // a drag here says "these turns, in this cost band".
          vg.intervalXY({ as: filter, brush: { fill: "none", stroke: "#e6e9ef" } }),
          // Pinned from the whole corpus, not derived from what survives the
          // filter. Without this, isolating one project recoloured it — the
          // filtered data had one category, so it took the scheme's first
          // colour, and a colour that changes when you select it is not an
          // identity. See palette.ts.
          vg.colorDomain(scale.domain),
          vg.colorRange(scale.range),
          // A key, NOT a control. With `as: filter` this legend publishes its
          // own clause over `project` — a second widget filtering the same
          // column from a different source than the chips, so the two could
          // disagree, and selecting every entry left a `project IN (all)`
          // clause that filters nothing while still reading as "filtered".
          // The chips own project selection; this just says what the colours
          // mean.
          vg.colorLegend({ columns: 4 }),
          vg.width(900),
          vg.height(300),
          vg.marginLeft(56),
          vg.marginBottom(30),
          vg.xLabel("→ when"),
          // Both domains pinned to the unfiltered extent, for the reason the
          // timeline pins its own: an axis that rescales to the brush makes the
          // next drag chase its own tail, and here it also breaks the alignment
          // between this time axis and the session graph's directly above it.
          vg.xDomain(vg.Fixed),
          vg.yDomain(vg.Fixed),
          vg.yScale("log"),
          vg.yLabel("↑ USD / turn"),
          vg.yTickFormat("$,.3~f"),
          vg.yGrid(true),
          vg.style({
            background: "transparent",
            color: "var(--cco-fg-dim)",
            fontSize: "11px",
          }),
        );
        // `plot()` returns `p.element`, which is undefined if a directive threw
        // before the element was built. Appending that is a confusing DOM error
        // several frames from the cause.
        if (!(chart instanceof Node)) throw new Error("vg.plot returned no element");
        el.append(chart);
      } catch (e) {
        // A stock-mark failure must not blank the page; the panel says what
        // broke and everything above it keeps working.
        setError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // Built as a string rather than nested JSX: the sentence has two optional
  // clauses and assembling them inline made a fragment-in-ternary that Solid 2
  // would not insert.
  const caption = () => {
    const zero =
      props.zeroCost > 0
        ? ` A log axis has no zero, so ${props.zeroCost} zero-cost ${
            props.zeroCost === 1 ? "turn is" : "turns are"
          } not drawn.`
        : "";
    return (
      `One dot per billed turn — ${props.turns.toLocaleString()} of them. Drag a box to filter ` +
      `every panel above by time AND by cost — the chips at the top pick projects. Grey is the ` +
      `whole corpus, colour is what survives the filter. Cost is on a ` +
      `log axis because it spans three orders of magnitude.${zero}`
    );
  };

  return (
    <>
      <p class="cco-note cco-note-tight">{caption()}</p>
      <Show when={error()}>{(e) => <pre class="cco-err">{e()}</pre>}</Show>
      <div class="cco-chart" ref={setHost} />
    </>
  );
}

export function TurnScatter() {
  return (
    <section class="cco-panel">
      <header class="cco-panel-head">
        <h2 class="cco-h2">every turn</h2>
        <Show when={store.filterActive()}>
          <button type="button" class="cco-btn" onClick={() => store.clearAllFilters()}>
            clear filter
          </button>
        </Show>
      </header>
      <CellView of={graph().scatterMeta}>
        {(m) => (
          <CellView of={graph().projects}>
            {(p) => <ScatterPlot zeroCost={m().zeroCost} turns={m().turns} scale={p().scale} />}
          </CellView>
        )}
      </CellView>
    </section>
  );
}
