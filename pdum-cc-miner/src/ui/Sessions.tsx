/**
 * Sessions.tsx — the "five calendar days, seven actual hours" view.
 *
 * Two bars per session: wall-clock span, and the work inside it. The gap
 * between them is the point — a session that ran for a week was not a week of
 * work, and cost per calendar day is a meaningless statistic until you can see
 * that.
 *
 * The duty cycle depends entirely on where you put the idle threshold, so that
 * threshold is a control (store.ts) and this view recomputes live against it —
 * which is why `sessions` is a cell keyed on `idleGapMinutes` rather than a
 * column read straight out of the parquet.
 */

import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { graph, type SessionShape } from "../model/graph";
import { focusSession, idleGapMinutes, store } from "../model/store";

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const dur = (s: number) =>
  s >= 86400
    ? `${(s / 86400).toFixed(1)}d`
    : s >= 3600
      ? `${(s / 3600).toFixed(1)}h`
      : `${Math.round(s / 60)}m`;

function SessionRow(props: { s: SessionShape; maxSpan: number }) {
  const spanFrac = () => (props.maxSpan > 0 ? props.s.spanSeconds / props.maxSpan : 0);
  // The active bar is drawn as a fraction OF THE SPAN BAR, not of the axis, so
  // the eye reads duty cycle directly as "how much of this bar is filled".
  const activeFrac = () => Math.min(1, props.s.dutyCycle);
  const focused = () => store.focusedSession() === props.s.sessionId;
  return (
    // The row IS the way into the drill-down below. A whole clickable row
    // rather than a link in one cell: the target is the session, and every
    // cell of the row is describing it.
    <tr
      class={`cco-sess-row${focused() ? " cco-sess-row-on" : ""}`}
      onClick={() => focusSession(props.s.sessionId)}
      title="show this session's turns below"
    >
      <td class="cco-sess-name">
        <span class="cco-sess-project">{props.s.project}</span>
        <Show when={props.s.name}>
          {/* `title` carries the rename, since the cell is too narrow for it
              and an AI title already fills the width. */}
          <span
            class="cco-sess-slug"
            title={props.s.nameWas ? `was “${props.s.nameWas}”` : undefined}
          >
            {props.s.name}
          </span>
        </Show>
      </td>
      <td class="cco-sess-bar">
        <div class="cco-span-track">
          <div class="cco-span-fill" style={{ width: `${spanFrac() * 100}%` }}>
            <div class="cco-active-fill" style={{ width: `${activeFrac() * 100}%` }} />
          </div>
        </div>
      </td>
      <td class="cco-num">{dur(props.s.spanSeconds)}</td>
      <td class="cco-num">{dur(props.s.activeSeconds)}</td>
      <td class={`cco-num cco-duty${props.s.dutyCycle < 0.15 ? " cco-duty-low" : ""}`}>
        {(props.s.dutyCycle * 100).toFixed(0)}%
      </td>
      <td class="cco-num">{props.s.nTurns}</td>
      <td class="cco-num">{props.s.nCompactions || ""}</td>
      <td class="cco-num">{usd(props.s.cost)}</td>
    </tr>
  );
}

export function Sessions() {
  return (
    <section class="cco-panel">
      <header class="cco-panel-head">
        <h2 class="cco-h2">sessions — elapsed vs worked</h2>
        <ControlSlider of={idleGapMinutes} label="idle gap" />
      </header>
      <p class="cco-note">
        The outer bar is wall-clock span; the filled part is time actually spent working, summing
        every inter-turn gap shorter than the idle threshold. Move the slider and watch the duty
        cycles move — where you draw that line is a judgement call, so it is yours to make.
      </p>
      <CellView of={graph().sessions}>
        {(rows) => {
          const top = rows().slice(0, 25);
          const maxSpan = Math.max(...top.map((r) => r.spanSeconds), 1);
          return (
            <div class="cco-table-scroll">
              <table class="cco-table">
                <thead>
                  <tr>
                    <th>session</th>
                    <th>span vs active</th>
                    <th class="cco-num">span</th>
                    <th class="cco-num">active</th>
                    <th class="cco-num">duty</th>
                    <th class="cco-num">turns</th>
                    <th class="cco-num" title="context compactions">
                      cmpct
                    </th>
                    <th class="cco-num">cost</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={top}>{(s) => <SessionRow s={s} maxSpan={maxSpan} />}</For>
                </tbody>
              </table>
            </div>
          );
        }}
      </CellView>
    </section>
  );
}
