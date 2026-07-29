/**
 * ProjectFilter.tsx — which projects the page is about (playbook layer 3).
 *
 * Sits directly under the summary because it scopes everything below it, and
 * because twelve is more projects than anyone is looking at: the usual case is
 * three. Clicking a chip toggles that project; the swatch is the exact colour
 * it carries in every chart, which is what makes the filter and the legends one
 * idea rather than two.
 *
 * It publishes a point clause into the same crossfilter the timeline and the
 * scatter use, so it composes with a brushed time range and a brushed cost band
 * with no special handling anywhere — that is the whole reason the panels read
 * the Selection's predicate rather than a mirrored brush (store.ts).
 *
 * It is also the honest answer to a limit the palette cannot fix: twelve
 * categorical colours are not distinguishable under colour-vision deficiency at
 * any palette (see palette.ts for the measurements). Showing three or four at a
 * time is.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { graph } from "../model/graph";
import { setVisibleProjects, store } from "../model/store";

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

export function ProjectFilter() {
  return (
    <CellView of={graph().projects}>
      {(p) => {
        const names = () => p().rows.map((r) => r.project);
        const colorOf = (project: string) => {
          const { domain, range } = p().scale;
          const i = domain.indexOf(project);
          return i < 0 ? "var(--cco-fg-dim)" : range[i];
        };
        // null means "all", so an un-narrowed page publishes no clause at all.
        const on = (project: string) => store.visibleProjects()?.has(project) ?? true;
        const narrowed = () => store.visibleProjects() !== null;

        return (
          <section class="cco-projects">
            <span class="cco-projects-label">projects</span>
            <div class="cco-projects-chips">
              <For each={p().rows}>
                {(r) => (
                  <button
                    type="button"
                    class={`cco-pchip${on(r.project) ? "" : " cco-pchip-off"}`}
                    aria-pressed={on(r.project) ? "true" : "false"}
                    onClick={() => store.toggleProjectVisible(r.project, names())}
                    title={`${r.turns.toLocaleString()} turns · ${usd(r.cost)}`}
                  >
                    <span class="cco-pchip-dot" style={{ background: colorOf(r.project) }} />
                    {r.project}
                  </button>
                )}
              </For>
            </div>
            <Show when={narrowed()}>
              <button type="button" class="cco-btn" onClick={() => setVisibleProjects(null)}>
                all
              </button>
            </Show>
            {/* A shortcut for the stated common case: the three that matter. */}
            <Show when={!narrowed() && p().rows.length > 3}>
              <button
                type="button"
                class="cco-btn"
                onClick={() => setVisibleProjects(new Set(names().slice(0, 3)))}
                title="the three projects with the most spend"
              >
                top 3
              </button>
            </Show>
          </section>
        );
      }}
    </CellView>
  );
}
