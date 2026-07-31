/**
 * crossfilter.ts — the shared Mosaic Selection, and every widget that publishes
 * a clause into it.
 *
 * Split from store.ts because it is a self-contained concern with one entry
 * point per producer, and because store.ts's boot sequence reads far better
 * without 200 lines of clause plumbing in the middle of it.
 *
 * `brushTime` is deliberately NOT here: it publishes a range AND pushes it into
 * the timeline's Mosaic client, which is created during the load. It bridges
 * this file and the engine, so it stays with the engine in store.ts.
 */
import { clausePoints } from "@uwdata/mosaic-core";
import { Selection } from "@uwdata/vgplot";
import { appScope, scopedState } from "./scope";

/**
 * The shared crossfilter. Every view publishes its brush here and reads
 * everyone else's — one Selection is what makes this a crossfilter rather than
 * several charts that happen to share a page.
 */
export const filter: Selection = appScope.durable("filter", () => Selection.crossfilter());

/**
 * The same clauses, but with nothing skipped — what a *drawn layer* should obey.
 *
 * A crossfilter deliberately hides a client's own clause from it
 * (`skip() === cross && clause.clients.has(client)`), so that a chart you are
 * brushing keeps its full data underneath and the drag has something to aim at.
 * That was the right default when a filtered-out mark disappeared. It is the
 * wrong one now that every chart draws an unfiltered base layer: the context is
 * already there in grey, so a chart applying its own brush to its coloured
 * layer is exactly what "the selection is highlighted" means — and not applying
 * it is what made brushing the scatter appear to do nothing to the scatter.
 *
 * `intersect` sets `cross: false`, so nothing is ever skipped; `include` relays
 * every clause published to the crossfilter. Marks filter by this; clauses are
 * still published to `filter`, so *other* clients keep crossfilter semantics.
 */
export const viewFilter: Selection = appScope.durable("viewFilter", () =>
  Selection.intersect({ include: filter }),
);

/** The time range currently published to the crossfilter — the drawn brush. */
export const brushRange = appScope.durableSignal<[number, number] | null>("brushRange", null);

/**
 * Which projects are visible, or null for "all of them".
 *
 * Null rather than "every project selected" so the default needs no knowledge
 * of which projects exist — the same reasoning as `collapsedProjects`, and it
 * means no clause is published until the reader actually narrows something.
 */
export const visibleProjects = scopedState<ReadonlySet<string> | null>("visibleProjects", null);

/**
 * A stable clause source for the project filter.
 *
 * Stable identity is what makes a Selection *replace* this widget's clause
 * rather than accumulate one per click. It is a bare object because the filter
 * is not a MosaicClient — it publishes but never queries.
 */
const projectSource = { name: "project-filter" };

/**
 * Show only these projects, or `null` to show all.
 *
 * Publishes a point clause over `project`, so it composes with the timeline's
 * time interval and the scatter's time×cost box exactly like any other clause —
 * and the cell panels pick it up through `filterSql()` with no extra wiring.
 */
export function setVisibleProjects(projects: ReadonlySet<string> | null): void {
  visibleProjects.set(projects);
  filter.update(
    clausePoints(["project"], projects ? [...projects].map((p) => [p]) : null, {
      source: projectSource,
    }),
  );
}

/** Toggle one project without disturbing the others. */
export function toggleProjectVisible(project: string, all: readonly string[]): void {
  const current = visibleProjects.peek() ?? new Set(all);
  const next = new Set(current);
  if (!next.delete(project)) next.add(project);
  // Back to everything selected means back to no clause at all, so the page
  // reads as unfiltered rather than as "filtered to all 12".
  setVisibleProjects(next.size === all.length ? null : next);
}

/**
 * Drop every clause AND the widget state that produced them.
 *
 * `filter.reset()` alone clears the Selection but leaves `visibleProjects`
 * holding a set, so the chips would keep showing a selection that no longer
 * filters anything. One entry point, so the two cannot drift.
 */
export function clearAllFilters(): void {
  visibleProjects.set(null);
  brushRange.set(null);
  filter.reset();
}

/**
 * Bumped whenever the crossfilter changes, so cell-based panels can depend on
 * it and recompute.
 *
 * The panels that aggregate a few hundred rows (daily spend, attribution, the
 * session table) are cells rather than Mosaic clients — see DailySpend.tsx on
 * why. That leaves them outside the coordinator's push, so they need something
 * reactive to key on, and a version counter is the smallest thing that works.
 */
export const filterVersion = scopedState<number>("filterVersion", 0);

/**
 * The crossfilter's current predicate as SQL text, for those cell consumers.
 *
 * Read from the `Selection` itself rather than mirrored from `brushRange`, and
 * that distinction is load-bearing. Mirroring worked while the timeline was the
 * only thing that published a clause; the turn scatter is a second producer
 * with a second dimension (cost), and a mirror of one range would silently
 * ignore it. Asking the Selection means any number of producers compose, which
 * is what a crossfilter is for.
 *
 * `predicate(undefined)` is documented as "a predicate with all clauses" — no
 * client to exclude, which is right: a cell is nobody's source, so nothing
 * should be skipped on its behalf.
 */
export function filterSql(): string {
  const p = filter.predicate(undefined);
  const parts = (Array.isArray(p) ? p : [p])
    .filter((x) => x != null && x !== true)
    .map((x) => String(x))
    .filter((s) => s.length > 0);
  return parts.length ? parts.join(" AND ") : "TRUE";
}

/** True when anything is brushed — the panels say so rather than looking empty. */
export const filterActive = (): boolean => {
  filterVersion.get(); // subscribe: the predicate itself is not reactive
  return filterSql() !== "TRUE";
};
