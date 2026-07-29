/**
 * index.ts — the app's LIBRARY surface (the `.` export): what a sibling
 * package importing this app gets. The starter exports its scope, graph, and
 * root component; as your real app grows, export its store surface, widgets,
 * and pure model functions here the same way (the in-repo reference demos —
 * morphogen, aztec, seismos, circle in pdum_aiui — model the shape).
 *
 * The mountable page lives behind the `./page` subpath on purpose: importing
 * THIS barrel should not drag in the page's stylesheet or wiring side effects.
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
