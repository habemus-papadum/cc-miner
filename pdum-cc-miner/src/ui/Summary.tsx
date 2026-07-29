/**
 * Summary.tsx — the strip at the top: what this corpus is, and the one number
 * that reframes everything else.
 *
 * The token-class split is deliberately the largest thing on the page. Cache
 * reads are ~63% of spend and fresh input ~0.1%, which means "using Claude Code
 * efficiently" is a context-management problem far more than a prompting one.
 * A dashboard that led with total dollars would bury that.
 *
 * Every dollar carries its provenance, and the provenance is stronger than
 * "derived": this account is on a Max subscription, so no per-token charge was
 * ever incurred and there is no bill to reconcile against. These are
 * **list-price equivalents** — what the tokens would have cost at published API
 * rates. That is the right unit for comparing a workflow against an agent swarm,
 * or one month against another; it is not money that changed hands, and the copy
 * must not let a reader think it is. See the proposal, §8.2.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { graph } from "../model/graph";
import { store } from "../model/store";

const usd = (n: number) =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : "—");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One class of token spend, sized by its share. */
function ClassBar(props: { label: string; cost: number; total: number; tone: string }) {
  return (
    <div class="cco-class">
      <div class="cco-class-head">
        <span class="cco-class-label">{props.label}</span>
        <span class="cco-class-share">{pct(props.cost, props.total)}</span>
      </div>
      <div class="cco-class-track">
        <div
          class="cco-class-fill"
          style={{
            width: `${props.total > 0 ? (props.cost / props.total) * 100 : 0}%`,
            background: props.tone,
          }}
        />
      </div>
      <div class="cco-class-cost">{usd(props.cost)}</div>
    </div>
  );
}

export function Summary() {
  const m = () => store.manifest();
  // The corpus totals, kept as the denominator behind the live numbers.
  const whole = () => store.summary();

  return (
    <CellView of={graph().liveSummary} fallback={null}>
      {(live) => {
        const s = () => live() ?? whole();
        return (
          <Show when={s()}>
            {(sum) => (
              <section class="cco-summary">
                <div class="cco-stats">
                  <div class="cco-stat">
                    <div class="cco-stat-value">{usd(sum().totalCost)}</div>
                    <div class="cco-stat-label">list-price equivalent</div>
                  </div>
                  <div class="cco-stat">
                    <div class="cco-stat-value">{sum().turns.toLocaleString()}</div>
                    <div class="cco-stat-label">turns</div>
                  </div>
                  <div class="cco-stat">
                    <div class="cco-stat-value">{sum().sessions.toLocaleString()}</div>
                    <div class="cco-stat-label">sessions</div>
                  </div>
                  <div class="cco-stat">
                    <div class="cco-stat-value">{sum().projects}</div>
                    <div class="cco-stat-label">projects</div>
                  </div>
                  <Show when={store.filterActive() && whole()}>
                    {(w) => (
                      <div class="cco-stat">
                        <div class="cco-stat-value cco-stat-of">
                          of {usd(w().totalCost)} · {w().sessions} sessions
                        </div>
                        <div class="cco-stat-label">filtered from</div>
                      </div>
                    )}
                  </Show>
                  <div class="cco-stat cco-stat-wide">
                    <div class="cco-stat-value">
                      {day(sum().firstTs)} → {day(sum().lastTs)}
                    </div>
                    <div class="cco-stat-label">window</div>
                  </div>
                </div>

                <div class="cco-classes">
                  <h2 class="cco-h2">where the money actually goes</h2>
                  <ClassBar
                    label="cache read"
                    cost={sum().costCacheRead}
                    total={sum().totalCost}
                    tone="var(--cco-cache-read)"
                  />
                  <ClassBar
                    label="cache creation"
                    cost={sum().costCacheCreate}
                    total={sum().totalCost}
                    tone="var(--cco-cache-create)"
                  />
                  <ClassBar
                    label="output"
                    cost={sum().costOutput}
                    total={sum().totalCost}
                    tone="var(--cco-output)"
                  />
                  <ClassBar
                    label="fresh input"
                    cost={sum().costInput}
                    total={sum().totalCost}
                    tone="var(--cco-input)"
                  />
                  <p class="cco-note">
                    Cache read + creation is{" "}
                    <strong>
                      {pct(sum().costCacheRead + sum().costCacheCreate, sum().totalCost)}
                    </strong>{" "}
                    of spend. Most of what you pay for is re-sending context, not generating tokens.
                  </p>
                </div>

                <Show when={m()}>
                  {(man) => (
                    <p class="cco-provenance">
                      <strong>Not a bill.</strong> No cost field exists in a Claude Code transcript,
                      and a Max subscription is charged a flat rate, not per token — so every figure
                      here is what these tokens <em>would</em> have cost at published API rates:
                      tokens × <code>{man().pricing.source}</code> @{" "}
                      {man().pricing.version.slice(0, 10)}, derived from {man().stats.files} files.
                      Useful for comparing one workflow against another, or this month against last.
                      A naive per-record sum would have reported{" "}
                      {(
                        man().stats.naiveOutputTokens / Math.max(1, man().stats.dedupedOutputTokens)
                      ).toFixed(2)}
                      × these output tokens.
                      <Show when={!man().invariants.ok}>
                        {" "}
                        <strong class="cco-warn">
                          Invariants FAILED — treat these numbers as suspect.
                        </strong>
                      </Show>
                    </p>
                  )}
                </Show>
              </section>
            )}
          </Show>
        );
      }}
    </CellView>
  );
}
