/**
 * index.ts — the app's LIBRARY surface (the `.` export): what a sibling
 * package importing cc-miner gets.
 *
 * Three kinds of thing, and the split is the point:
 *
 *   the identity     `appScope`, and `graph` for reading cells
 *   the PURE model   the session-graph layout — `layoutTimeline`, `packLanes`,
 *                    `timeScale` and their types. Framework-free and time-free,
 *                    so a consumer can lay out a timeline without mounting
 *                    anything (and so it can be tested exhaustively).
 *   components       `App` and `SessionTimeline`, the two worth mounting
 *                    elsewhere; the rest of `ui/` is internal to the page.
 *
 * The mountable page lives behind the `./page` subpath on purpose: importing
 * THIS barrel must not drag in the page's stylesheet or its wiring side effects
 * (page.tsx's graph import builds the cell graph and registers the agent
 * tools). A library consumer chooses when that happens.
 */
export { type AppGraph, graph } from "./model/graph";
export { appScope } from "./model/store";
export {
  type ForkEdgeInput,
  type LayoutBar,
  type LayoutEdge,
  type LayoutGroup,
  type LayoutRow,
  layoutTimeline,
  packLanes,
  type TimelineLayout,
  type TimelineSpan,
  timeScale,
} from "./model/timeline";
export {
  SelectionStatsClient,
  SessionTimelineClient,
  type TimelineData,
} from "./model/timeline-client";
export { App } from "./ui/App";
export { SessionTimeline } from "./ui/SessionTimeline";
