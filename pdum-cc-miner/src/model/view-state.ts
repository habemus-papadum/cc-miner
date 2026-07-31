/**
 * view-state.ts — what the session graph is showing: which projects are folded,
 * which sessions are broken out, which one the drill-down is looking at.
 *
 * None of this touches DuckDB, Mosaic or the crossfilter. It lived in store.ts,
 * which CLAUDE.md describes as "guarded, rarely-edited wiring… editing it forces
 * a full reload" — a description this state made false, since it is exactly the
 * kind of thing that gets edited constantly while iterating on the view.
 */

import { toggled } from "./durable-state";
import { appScope, scopedState } from "./scope";

/**
 * Collapsed rather than expanded, so the default needs no knowledge of which
 * projects exist: an empty set means every project shows its lanes. Storing the
 * expanded set instead would need a "not yet initialised" sentinel and a first
 * -data hook to fill it in.
 */
export const collapsedProjects = scopedState<ReadonlySet<string>>("collapsedProjects", new Set());
/** Sessions whose agents are broken out onto their own sub-lanes. */
export const expandedSessions = scopedState<ReadonlySet<string>>("expandedSessions", new Set());

/**
 * The session the drill-down is looking at, or null for "pick the priciest".
 *
 * Deliberately NOT the crossfilter. The drill-down answers a different kind of
 * question from the panels above it — "what happened inside this one session"
 * rather than "how do these dimensions co-vary" — and routing it through the
 * shared Selection would make every other panel collapse to one session the
 * moment you looked at one. One explicit pointer, no filtering.
 */
export const focusedSession = appScope.durableSignal<string | null>("focusedSession", null);

export function focusSession(sessionId: string | null): void {
  focusedSession.set(sessionId);
}

export function toggleProject(project: string): void {
  collapsedProjects.set(toggled(collapsedProjects.peek(), project));
}

export function toggleSession(sessionId: string): void {
  expandedSessions.set(toggled(expandedSessions.peek(), sessionId));
}

export function setAllCollapsed(projects: readonly string[], collapsed: boolean): void {
  collapsedProjects.set(collapsed ? new Set(projects) : new Set<string>());
  if (collapsed) expandedSessions.set(new Set<string>());
}
