/**
 * SessionDetail.tsx — one session, turn by turn (playbook layer 3).
 *
 * The drill-down. Every panel above this one aggregates across the corpus; this
 * one answers "what happened inside this session, and did it get more expensive
 * as it went".
 *
 * Two stacked charts sharing an x axis of turn ordinals (see session-detail.ts
 * for why the axis is not wall-clock): cost per turn split by class, and the
 * context size that drives it. Compactions are ruled through both, because the
 * whole point is that a compaction is the thing that resets the second chart
 * and therefore bends the first.
 *
 * Observable Plot rather than a Mosaic client, same reasoning as DailySpend: one
 * session is thousands of rows, not millions, and this view does not
 * participate in the crossfilter by design.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import * as Plot from "@observablehq/plot";
import { createEffect, createSignal, Show } from "solid-js";
import { graph, type SessionDetailData } from "../model/graph";
import {
  bucketTurns,
  COST_CLASSES,
  gaps,
  placeCompactions,
  type StackSegment,
  stack,
  summarise,
} from "../model/session-detail";
import { focusSession, idleGapMinutes, store } from "../model/store";

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const tok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const dur = (ms: number) =>
  ms >= 86400_000
    ? `${(ms / 86400_000).toFixed(1)}d`
    : ms >= 3600_000
      ? `${(ms / 3600_000).toFixed(1)}h`
      : `${Math.round(ms / 60_000)}m`;

/** "1 compaction", "3 compactions" — a stat line that says "1 turns" reads as a bug. */
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

const CLASS_TONES = COST_CLASSES.map((c) => c.tone);
const CLASS_LABELS = COST_CLASSES.map((c) => c.label);

function DetailCharts(props: { data: SessionDetailData; gapMs: number }) {
  const [host, setHost] = createSignal<HTMLDivElement | undefined>();

  createEffect(
    () => ({ el: host(), data: props.data, gapMs: props.gapMs }),
    ({ el, data, gapMs }) => {
      if (!el) return;
      el.replaceChildren();
      const turns = data.turns;
      if (turns.length === 0) return;

      // ~180 bars over a 780px plotting area keeps every bar at least 4px wide,
      // which is the width below which a stack stops reading as layers.
      const buckets = bucketTurns(turns, 180);
      const segments = stack(buckets);
      const per = buckets[0]?.turns ?? 1;
      // `i === -1` means the compaction predates every turn in this session — a
      // fork inherits its parent's compaction records. Dropped rather than
      // drawn at the left edge, which would claim it happened here.
      const marks = placeCompactions(turns, data.compactions).filter((c) => c.i >= 0);
      const idle = gaps(turns, gapMs);
      const width = 900;

      // A rule per compaction and per idle gap, shared by both charts so the
      // eye can carry a vertical line from cost down to context.
      const rules = () => [
        Plot.ruleX(idle, {
          x: (g: { i: number }) => g.i + 0.5,
          stroke: "var(--cco-rule)",
          strokeWidth: 1,
          strokeDasharray: "2,3",
          tip: true,
          // The axis has no time on it, so the gap's length has to be readable
          // somewhere — otherwise a dashed line is just an unexplained mark.
          title: (g: { i: number; ms: number }) =>
            `put down for ${dur(g.ms)}\nresumed at turn ${g.i + 2}`,
        }),
        Plot.ruleX(marks, {
          x: "i",
          stroke: "var(--cco-input)",
          strokeWidth: 1.5,
          strokeOpacity: 0.85,
        }),
      ];

      const cost = Plot.plot({
        width,
        height: 200,
        marginLeft: 56,
        marginBottom: 8,
        x: { axis: null, domain: [-0.5, turns.length - 0.5] },
        y: {
          // The label has to say what a bar covers, or the reader compares a
          // 12-turn bar against a per-turn intuition and is off by 12×.
          label: per === 1 ? "USD / turn" : `USD / ${per} turns`,
          grid: true,
          tickFormat: (d: number) => `$${d}`,
        },
        color: { domain: CLASS_LABELS, range: CLASS_TONES, legend: true },
        style: { background: "transparent", color: "var(--cco-fg-dim)", fontSize: "11px" },
        marks: [
          ...rules(),
          Plot.rectY(segments, {
            // Bars span their bucket's turn range, so the x scale stays in turn
            // ordinals and the rules and the context line below need no
            // remapping to line up with them.
            x1: (d: StackSegment) => d.bucket.from - 0.5,
            x2: (d: StackSegment) => d.bucket.to + 0.5,
            y: "cost",
            fill: "klass",
            // Ordered explicitly rather than by value, so a class keeps the same
            // position in every bar and the layers read as bands.
            order: CLASS_LABELS,
            tip: true,
            title: (d: StackSegment) =>
              `${d.bucket.turns === 1 ? `turn ${d.bucket.from + 1}` : `turns ${d.bucket.from + 1}–${d.bucket.to + 1}`}` +
              ` · ${when(d.bucket.t0)}\n${d.klass}: ${usd(d.cost)}\n` +
              `total: ${usd(d.bucket.costTotal)}` +
              (d.bucket.turns > 1 ? `\npriciest single turn: ${usd(d.bucket.maxTurnCost)}` : ""),
          }),
        ],
      });

      const context = Plot.plot({
        width,
        height: 130,
        marginLeft: 56,
        marginBottom: 30,
        x: { label: "turn", domain: [-0.5, turns.length - 0.5] },
        y: { label: "context tokens", grid: true, tickFormat: tok },
        style: { background: "transparent", color: "var(--cco-fg-dim)", fontSize: "11px" },
        marks: [
          ...rules(),
          // Main-loop turns only. A subagent carries its OWN context, so mixing
          // them in draws a sawtooth that says nothing about this session's.
          Plot.areaY(
            turns.map((t, i) => ({ ...t, i })).filter((t) => t.context === "main"),
            {
              x: "i",
              y: "contextTokens",
              fill: "var(--cco-accent)",
              fillOpacity: 0.16,
              curve: "step-after",
            },
          ),
          Plot.line(
            turns.map((t, i) => ({ ...t, i })).filter((t) => t.context === "main"),
            {
              x: "i",
              y: "contextTokens",
              stroke: "var(--cco-accent)",
              strokeWidth: 1,
              curve: "step-after",
            },
          ),
          // The compaction's own `preTokens`: the measured value beside the
          // proxy, so the reader can see the two agree rather than take it on
          // trust. See session-detail.ts — 38 of 40 within ±20%.
          Plot.dot(marks, {
            x: "i",
            y: "preTokens",
            r: 2.5,
            fill: "var(--cco-input)",
            tip: true,
            title: (d: { preTokens: number; postTokens: number; trigger: string; ts: number }) =>
              `compaction (${d.trigger})\n${when(d.ts)}\n` +
              `${tok(d.preTokens)} → ${tok(d.postTokens)} tokens`,
          }),
          Plot.ruleY([0], { stroke: "var(--cco-rule)" }),
        ],
      });

      el.append(cost, context);
    },
  );

  return <div class="cco-chart" ref={setHost} />;
}

function Header(props: { data: SessionDetailData; gapMs: number }) {
  const s = () => summarise(props.data.turns);
  const growth = () => {
    const { firstFifthMean, lastFifthMean } = s();
    if (firstFifthMean <= 0) return null;
    return lastFifthMean / firstFifthMean;
  };
  const idleCount = () => gaps(props.data.turns, props.gapMs).length;

  return (
    <>
      <div class="cco-detail-head">
        <span class="cco-detail-name">{props.data.name}</span>
        <Show when={props.data.nameWas}>
          {(was) => <span class="cco-detail-was">was “{was()}”</span>}
        </Show>
        <span class="cco-detail-meta">
          {props.data.project} · {props.data.sessionId.slice(0, 8)}
        </span>
      </div>
      <div class="cco-detail-stats">
        <span>
          <b>{s().turns.toLocaleString()}</b> {s().turns === 1 ? "turn" : "turns"}
        </span>
        <span>
          <b>{usd(s().cost)}</b> total
        </span>
        <span>
          peak context <b>{tok(s().peakContextTokens)}</b>
        </span>
        <Show when={s().subagentTurns > 0}>
          <span>
            <b>{s().subagentTurns.toLocaleString()}</b> in subagents
          </span>
        </Show>
        <Show when={props.data.compactions.length > 0}>
          <span>{plural(props.data.compactions.length, "compaction")}</span>
        </Show>
        <Show when={idleCount() > 0}>
          <span>{plural(idleCount(), "idle gap")}</span>
        </Show>
      </div>
      <p class="cco-note">
        <Show
          when={growth()}
          fallback="Each bar is one turn, stacked by cost class; the area below is the context that
            drives it. Solid rules are compactions, dashed are idle gaps."
        >
          {(g) => (
            <>
              The last fifth of this session's main-loop turns cost{" "}
              <b>{g() >= 1 ? `${g().toFixed(1)}×` : `${(1 / g()).toFixed(1)}× less than`}</b>{" "}
              {g() >= 1 ? "what the first fifth did" : "the first fifth"} —{" "}
              {usd(s().firstFifthMean)} → {usd(s().lastFifthMean)} per turn. Solid rules are
              compactions, dashed are idle gaps; the dots are each compaction's own recorded context
              size, beside the estimate.
            </>
          )}
        </Show>
      </p>
    </>
  );
}

export function SessionDetail() {
  const gapMs = () => Math.max(1, idleGapMinutes.get()) * 60_000;
  return (
    <section class="cco-panel">
      <header class="cco-panel-head">
        <h2 class="cco-h2">inside one session</h2>
        {/* Only offered once a session has been picked; with no focus the
            panel is already showing the priciest one. */}
        <Show when={store.focusedSession()}>
          <button type="button" class="cco-btn" onClick={() => focusSession(null)}>
            back to priciest
          </button>
        </Show>
      </header>
      <CellView of={graph().sessionDetail}>
        {(data) => (
          <Show
            when={data()}
            fallback={<p class="cco-note">No session to show — the corpus has no billed turns.</p>}
          >
            {(d) => (
              <>
                <Header data={d()} gapMs={gapMs()} />
                <DetailCharts data={d()} gapMs={gapMs()} />
              </>
            )}
          </Show>
        )}
      </CellView>
    </section>
  );
}
