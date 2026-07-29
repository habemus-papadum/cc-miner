/**
 * Attribution.tsx — what *caused* the spend: agent type, skill, MCP server.
 *
 * These columns are sparse (a skill is named on ~4% of turns, an MCP server on
 * ~6%), so the "(none)" bucket is nearly always the largest bar. That is not
 * noise to be filtered out — it is the baseline the others must be read
 * against, and hiding it would make a 3% slice look like a headline.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { For } from "solid-js";
import { graph } from "../model/graph";

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

interface Slice {
  kind: string;
  key: string;
  cost: number;
  turns: number;
}

function Group(props: {
  title: string;
  note: string;
  rows: Slice[];
  /** key → the whole corpus's cost for it, drawn behind as context. */
  totals: Map<string, number>;
}) {
  // Scaled against the UNFILTERED maximum, so a bar's length means the same
  // thing before and after a filter — otherwise narrowing the selection
  // re-normalises every bar and the biggest one is always full-width.
  const max = () => Math.max(...[...props.totals.values()], 1e-9);
  // Rows come from the filtered data, but ordering by the corpus total keeps
  // them from reshuffling under the reader as the filter moves.
  const ordered = () =>
    [...props.rows].sort((a, b) => (props.totals.get(b.key) ?? 0) - (props.totals.get(a.key) ?? 0));
  return (
    <div class="cco-attr-group">
      <h3 class="cco-h3">{props.title}</h3>
      <p class="cco-note cco-note-tight">{props.note}</p>
      <For each={ordered().slice(0, 8)}>
        {(r) => (
          <div class={`cco-attr-row${r.key.startsWith("(") ? " cco-attr-baseline" : ""}`}>
            <span class="cco-attr-key" title={r.key}>
              {r.key}
            </span>
            <span class="cco-attr-track">
              {/* The corpus total sits behind the filtered bar, so a selection
                  is read against the whole rather than against itself. */}
              <span
                class="cco-attr-ghost"
                style={{ width: `${((props.totals.get(r.key) ?? r.cost) / max()) * 100}%` }}
              />
              <span class="cco-attr-fill" style={{ width: `${(r.cost / max()) * 100}%` }} />
            </span>
            <span class="cco-attr-cost">{usd(r.cost)}</span>
          </div>
        )}
      </For>
    </div>
  );
}

export function Attribution() {
  return (
    <section class="cco-panel">
      <h2 class="cco-h2">what caused the spend</h2>
      <CellView of={graph().attribution}>
        {(rows) => (
          <CellView of={graph().attributionTotals}>
            {(all) => {
              const totalsFor = (kind: string) =>
                new Map(
                  all()
                    .filter((r) => r.kind === kind)
                    .map((r) => [r.key, r.cost]),
                );
              return (
                <div class="cco-attr">
                  <Group
                    title="by agent"
                    note="(main loop) is every turn that ran in the top-level session."
                    rows={rows().filter((r) => r.kind === "agent")}
                    totals={totalsFor("agent")}
                  />
                  <Group
                    title="by skill"
                    note="Named on a minority of turns — (none) is the baseline, not an error."
                    rows={rows().filter((r) => r.kind === "skill")}
                    totals={totalsFor("skill")}
                  />
                  <Group
                    title="by MCP server"
                    note="Attribution lands on the turn that invoked the server's tool."
                    rows={rows().filter((r) => r.kind === "mcp")}
                    totals={totalsFor("mcp")}
                  />
                </div>
              );
            }}
          </CellView>
        )}
      </CellView>
    </section>
  );
}
