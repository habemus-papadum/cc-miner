/**
 * timeline.ts — the session-graph layout (playbook layer 1: pure functions).
 *
 * Everything here is a total function of its arguments: no framework, no time,
 * no DOM. Given a set of wall-clock spans and the fork edges between them, it
 * produces the complete pixel geometry of a git-commit-graph-shaped timeline —
 * rows, bars, and SVG path strings — which makes the whole layout unit-testable
 * without a browser.
 *
 * The three ideas that shape it:
 *
 *   1. **Lane packing is first-fit over start-sorted intervals.** That is the
 *      optimal coloring for an interval graph (they are perfect graphs), so the
 *      lane count a project needs is exactly its peak concurrency — no wasted
 *      vertical space, and `packLanes` is checked against that bound in the
 *      tests. Picking the *lowest free* lane rather than the *earliest freed*
 *      one is what gives the git-graph look: lanes stay compact and a
 *      long-running session keeps the same lane for its whole life.
 *
 *   2. **Lanes are semantic and zoom-independent.** The caller hands in a
 *      `TimeScale` and everything geometric goes through it, but lane
 *      *assignment* does not: it uses the raw timestamps, so a lane count is a
 *      peak-concurrency reading that does not change as you brush. The two
 *      near-misses are documented where they are decided — `DEFAULTS.laneGapPx`
 *      (a visual gutter turns concurrency into proximity: ten strictly
 *      sequential sessions become ten lanes) and `drawnExtent` (packing by the
 *      drawn width does the same thing more subtly).
 *
 *   3. **Expansion is layout, never a query.** Collapsing a project or opening a
 *      session's agents changes only the arguments to this function. Nothing
 *      here can round-trip to the database, so the interaction is frame-rate
 *      fast by construction and the Mosaic client never re-queries for it.
 */

// ---------------------------------------------------------------------------
// scale
// ---------------------------------------------------------------------------

/** A linear map from epoch milliseconds to pixels, and back. */
export interface TimeScale {
  readonly t0: number;
  readonly t1: number;
  readonly x0: number;
  readonly x1: number;
  /** Milliseconds per pixel — the conversion lane packing needs. */
  readonly msPerPx: number;
  toPx(t: number): number;
  fromPx(px: number): number;
}

/**
 * A degenerate domain (one instant, or an empty corpus) still has to produce a
 * usable scale — the alternative is a NaN that silently voids every path
 * string downstream — so it is widened to one millisecond.
 */
export function timeScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): TimeScale {
  const [t0, rawT1] = domain;
  const [x0, x1] = range;
  const t1 = rawT1 > t0 ? rawT1 : t0 + 1;
  const span = t1 - t0;
  const width = x1 - x0 || 1;
  return {
    t0,
    t1,
    x0,
    x1,
    msPerPx: span / width,
    toPx: (t) => x0 + ((t - t0) / span) * width,
    fromPx: (px) => t0 + ((px - x0) / width) * span,
  };
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

/** Where a span ran: the main loop, or an agent launched out of it. */
export type SpanKind = "session" | "agent";

/** One wall-clock span, exactly as the Mosaic client hands it over. */
export interface TimelineSpan {
  kind: SpanKind;
  /** `sessionId` for a session, `agentId` for an agent. */
  id: string;
  project: string;
  /** The session that launched this agent; null on a session. */
  parentId: string | null;
  /** Epoch ms of the first and last turn. Equal for a one-turn span. */
  t0: number;
  t1: number;
  nTurns: number;
  cost: number;
  /** `Explore`, `Plan`, `general-purpose`, `workflow-subagent`, … */
  agentType: string | null;
  /** `main` | `subagent` | `workflow-agent`. */
  context: string;
  /**
   * A session FILE that produced no billed turn — a fork taken and never
   * continued. It is the user's own stated case ("sometimes I fork something I
   * intend to continue but don't go back to it"), so it earns a mark rather
   * than a gap, but a hollow one: there is no work here to compare against the
   * filled bars, and no activity for an activity filter to act on.
   */
  ghost?: boolean;
}

/**
 * What the child took from the parent (cc-assay's `forkEdges.kind`).
 *
 * `copy` is a true fork: the inherited prefix was physically copied into the
 * child's file, so the branch leaves the MIDDLE of the parent's life.
 * `continuation` is a session continued into a fresh file — the link is real
 * but nothing was inherited on disk, so the branch leaves the parent's END.
 * The two are drawn from different anchors for exactly that reason.
 */
export type ForkKind = "copy" | "continuation";

/**
 * A session→session fork: `childId` was started from `parentId`'s transcript.
 *
 * `forkTs` is the timestamp of the last record the child inherited — i.e. the
 * point in the PARENT's timeline the fork was taken from, which is generally
 * nowhere near the parent's last event and may precede the child's own start by
 * days. Anchoring the edge there rather than at `parent.lastTs` is what makes a
 * stale fork readable: it points at the moment that was actually branched.
 */
export interface ForkEdgeInput {
  childId: string;
  parentId: string;
  forkTs: number;
  kind?: ForkKind;
  /**
   * The direction of this edge rested on file creation order, not on content —
   * cc-assay could not prove which of the two sessions was the copy. Drawn
   * differently from a proven edge on purpose: a widget that renders a guess
   * identically to a fact is lying.
   */
  ambiguous?: boolean;
}

export interface TimelineInput {
  spans: readonly TimelineSpan[];
  forks: readonly ForkEdgeInput[];
  /**
   * Ids surviving the crossfilter, or undefined for "no filter, all live".
   *
   * `spans` is always the whole corpus so the layout is stable; this says which
   * of them are in the selection.
   */
  live?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// lane packing
// ---------------------------------------------------------------------------

/** The minimum a span needs to take part in lane packing. */
export interface Packable {
  id: string;
  t0: number;
  t1: number;
}

export interface Packing {
  /** span id → lane index, 0-based, 0 at the top. */
  lane: ReadonlyMap<string, number>;
  laneCount: number;
}

/**
 * Deterministic order: earliest start first; among equal starts the longer span
 * first, so a long-running session takes the low lane and the short ones stack
 * beneath it; `id` last so the result never depends on input order.
 */
function packOrder(a: Packable, b: Packable): number {
  return a.t0 - b.t0 || b.t1 - a.t1 || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * First-fit lane assignment over start-sorted spans, treating each span as the
 * half-open interval `[t0, t1 + minGapMs)`.
 *
 * This is the textbook optimal coloring of an interval graph: it uses exactly
 * as many lanes as the largest set of spans that are mutually in conflict, so a
 * lane count is a peak-concurrency reading and never an artefact. The tests
 * assert that bound directly.
 *
 * Two properties are load-bearing and neither is incidental:
 *
 *  - **Lowest free lane, not earliest freed.** A heap would hand back whichever
 *    lane freed up first and the graph would wander down the page; scanning for
 *    the lowest index keeps lanes compact and holds a long-running session on
 *    one lane for its whole life. That is the git-graph look.
 *  - **Half-open, so abutting spans share a lane.** A session ending exactly
 *    when the next begins is sequential, not concurrent, and belongs on the
 *    same lane. Callers that need a visual gutter pass `minGapMs`; callers with
 *    zero-duration spans must extend them first (see `drawnExtent`), or a point
 *    span would be an empty interval that conflicts with nothing.
 *
 * O(n·L) for n spans and L lanes.
 */
export function packLanes(spans: readonly Packable[], minGapMs = 0): Packing {
  const sorted = [...spans].sort(packOrder);
  const freeAt: number[] = [];
  const lane = new Map<string, number>();
  for (const s of sorted) {
    let i = 0;
    while (i < freeAt.length && freeAt[i] + minGapMs > s.t0) i++;
    freeAt[i] = s.t1;
    lane.set(s.id, i);
  }
  return { lane, laneCount: freeAt.length };
}

/**
 * Give every span a strictly positive extent, so none of them is the empty
 * interval that conflicts with nothing.
 *
 * A one-turn session has `t0 === t1`, and two of those at the same instant must
 * not land on the same lane. `minExtentMs` is a **tie-breaker, not a gutter**:
 * one millisecond is enough to separate coincident points and far too small to
 * ever manufacture a lane for genuinely sequential work. Widening it to the
 * minimum *drawn* width is the tempting mistake — at a month-wide zoom 1.5px is
 * 84 minutes, which re-introduces exactly the proximity-not-concurrency
 * inflation `DEFAULTS.laneGapPx` exists to avoid, and makes the chart's height
 * change as you brush.
 */
export function drawnExtent(spans: readonly Packable[], minExtentMs: number): Packable[] {
  return spans.map((s) => ({
    id: s.id,
    t0: s.t0,
    t1: Math.max(s.t1, s.t0 + minExtentMs),
  }));
}

/**
 * The union of a set of spans, with anything closer than `minGapMs` fused.
 * This is what a collapsed project's activity band is drawn from: "when was
 * this project alive at all", independent of how many sessions overlapped.
 */
export function mergeSpans(
  spans: readonly Packable[],
  minGapMs = 0,
): Array<{ t0: number; t1: number }> {
  const sorted = [...spans].sort(packOrder);
  const out: Array<{ t0: number; t1: number }> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.t0 - last.t1 <= minGapMs) {
      if (s.t1 > last.t1) last.t1 = s.t1;
    } else {
      out.push({ t0: s.t0, t1: s.t1 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// edge routing
// ---------------------------------------------------------------------------

/** Round to 0.1px: shorter path strings, and stable ones to assert against. */
const r = (n: number): number => Math.round(n * 10) / 10;

/**
 * A cubic from one lane to another with *horizontal* control handles.
 *
 * The handles are capped in pixels, which is the whole trick for the long-gap
 * case. A fork taken days before the child starts becomes: a flat run leaving
 * the parent's lane, one compact S, and a flat run arriving at the child's —
 * instead of the single vast arc a proportional handle would draw. Both
 * attachment points stay horizontal, so the eye reads *which* lanes are joined
 * even when it cannot follow the middle of the curve.
 */
export function edgePath(x1: number, y1: number, x2: number, y2: number, handlePx: number): string {
  const k = Math.max(6, Math.min(handlePx, Math.abs(x2 - x1) * 0.45));
  return `M${r(x1)},${r(y1)}C${r(x1 + k)},${r(y1)} ${r(x2 - k)},${r(y2)} ${r(x2)},${r(y2)}`;
}

// ---------------------------------------------------------------------------
// layout output
// ---------------------------------------------------------------------------

/** One horizontal band of the chart. Rows are the unit of vertical space. */
export interface LayoutRow {
  index: number;
  y: number;
  height: number;
  project: string;
  /**
   * `lane` — a session lane of an expanded project.
   * `collapsed` — the single row a collapsed project folds onto.
   * `agent` — a sub-lane holding the agents of one expanded session.
   */
  kind: "lane" | "collapsed" | "agent";
  lane: number;
  /** Set on `agent` rows: whose agents these are. */
  sessionId?: string;
}

export interface LayoutBar {
  id: string;
  kind: SpanKind;
  project: string;
  /** Set on an agent bar: the session it was launched from. */
  sessionId: string | null;
  agentType: string | null;
  context: string;
  x: number;
  width: number;
  y: number;
  height: number;
  rowIndex: number;
  t0: number;
  t1: number;
  nTurns: number;
  cost: number;
  /** True when this bar sits on a collapsed project's shared row. */
  collapsed: boolean;
  /**
   * True for an agent drawn as a hairline *inside* its session's row rather
   * than on a sub-lane of its own — the default, dense presentation.
   */
  strip: boolean;
  /** A fork that produced no billed turn. Drawn hollow. See `TimelineSpan`. */
  ghost: boolean;
  /**
   * True when this bar exists in the corpus but not in the current selection.
   *
   * Drawn faint rather than dropped. Two reasons, and the second is the one
   * that made it worth doing: a selection is only readable against the shape it
   * came from, and laying out the FULL set means lanes and rows keep their
   * positions while a brush moves — otherwise every drag reflows the chart
   * under the cursor.
   */
  dim: boolean;
}

export interface LayoutEdge {
  id: string;
  kind: "fork" | "launch";
  path: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Screen distance the edge spans, in px. */
  gapPx: number;
  /**
   * True when the endpoints are too far apart to read as adjacent. The user's
   * hard case — forking something days after you last touched it — lands here,
   * and the view draws these dashed and faded rather than pretending the two
   * tracks are neighbours.
   */
  long: boolean;
  /** Fork edges only: cc-assay could not prove the direction. */
  ambiguous: boolean;
  /** Fork edges only. */
  forkKind?: ForkKind;
}

export interface LayoutGroup {
  project: string;
  y: number;
  height: number;
  rowStart: number;
  rowCount: number;
  collapsed: boolean;
  nSessions: number;
  nAgents: number;
  cost: number;
  /** Activity band for the collapsed presentation, in pixels. */
  band: Array<{ x: number; width: number }>;
}

export interface TimelineLayout {
  rows: LayoutRow[];
  bars: LayoutBar[];
  edges: LayoutEdge[];
  groups: LayoutGroup[];
  /** Total height in pixels — what the SVG viewBox should use. */
  height: number;
  scale: TimeScale;
}

export interface TimelineOptions {
  scale: TimeScale;
  /** Clear screen a lane needs before it may be reused. */
  laneGapPx?: number;
  rowHeight?: number;
  barHeight?: number;
  agentRowHeight?: number;
  agentBarHeight?: number;
  collapsedRowHeight?: number;
  /** Vertical space between two project groups. */
  groupGapPx?: number;
  /** Projects NOT in this set render collapsed onto a single row. */
  expandedProjects?: ReadonlySet<string>;
  /** Sessions in this set get their agents on real sub-lanes. */
  expandedSessions?: ReadonlySet<string>;
  /** Beyond this screen distance a fork edge is drawn as "unrelated in time". */
  longGapPx?: number;
  /** Cap on the horizontal bezier handle. See `edgePath`. */
  edgeHandlePx?: number;
  /** Minimum drawn width, so a one-turn session is still clickable. */
  minBarPx?: number;
  /** Shrink each bar by this much per side, so abutting bars keep a seam. */
  barInsetPx?: number;
  /**
   * The width given to a zero-duration span purely so it conflicts with
   * something. A tie-breaker, deliberately NOT a gutter — see `drawnExtent`.
   */
  packEpsilonMs?: number;
}

/**
 * `laneGapPx` defaults to 0 on purpose, and it is the one default worth
 * arguing about.
 *
 * A positive gutter guarantees two bars never fuse on screen — but it also
 * makes a lane mean "close in time" rather than "concurrent", and against the
 * real corpus that is a bad trade: `mcp-list-changed` has ten strictly
 * sequential sessions inside a few hours and peak concurrency of one, and a
 * 1px gutter at month-wide zoom (38 minutes) splits it into ten lanes. Ten rows
 * for a project that never ran two sessions at once is a lie about the data,
 * and it triples the height of the whole chart.
 *
 * So lanes stay semantic — a lane count IS a peak concurrency — and visual
 * fusion is a rendering problem, solved by insetting each bar (`barInsetPx`)
 * so abutting bars keep a seam. Two sessions five minutes apart at a month's
 * zoom still merge, which is honest: five minutes is a tenth of a pixel there,
 * and resolving it is what brushing in is for.
 */
const DEFAULTS = {
  laneGapPx: 0,
  rowHeight: 13,
  barHeight: 8,
  agentRowHeight: 6,
  agentBarHeight: 3,
  collapsedRowHeight: 15,
  groupGapPx: 6,
  longGapPx: 90,
  edgeHandlePx: 34,
  minBarPx: 1.5,
  barInsetPx: 0.35,
  packEpsilonMs: 1,
} as const;

/**
 * Projects read top to bottom in the order they first appear in the corpus —
 * the same chronological reading a git graph gives, and stable under filtering
 * in a way that ordering by volume or cost is not.
 */
function projectOrder(spans: readonly TimelineSpan[]): string[] {
  const first = new Map<string, number>();
  for (const s of spans) {
    const seen = first.get(s.project);
    if (seen === undefined || s.t0 < seen) first.set(s.project, s.t0);
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p);
}

/**
 * Which ghosts have earned a lane under the current filter.
 *
 * A ghost is not filterable the way a real session is — it has no turns, so no
 * turn-grain predicate can select it, and it must not respond to the client's
 * own brush either, or it would behave differently from the real bars beside
 * it (a crossfilter excludes a client from its own clause, so the real bars
 * hold still). Its relevance is therefore **transitive**: a ghost is worth
 * drawing exactly when it connects to something that is being drawn.
 *
 * Computed against the set of *real* sessions that survived the filter, in one
 * pass, so there is no circularity — a ghost never justifies another ghost.
 * This inherits whatever semantics produced that set, which is why it behaves
 * correctly under a project filter (the ghost's family is gone, so it goes) and
 * under the client's own brush (the real set is unchanged, so it stays).
 *
 * A ghost whose only surviving neighbour is its PARENT is kept, deliberately.
 * It reads as "you forked here and it went nowhere", which is the case the
 * whole feature exists for — an abandoned fork usually has no children, so
 * requiring one on each side would hide precisely the thing worth seeing.
 */
function connectedGhosts(
  spans: readonly TimelineSpan[],
  forks: readonly ForkEdgeInput[],
): Set<string> {
  const real = new Set<string>();
  const ghosts = new Set<string>();
  for (const s of spans) {
    if (s.kind !== "session") continue;
    (s.ghost ? ghosts : real).add(s.id);
  }
  const keep = new Set<string>();
  for (const f of forks) {
    if (ghosts.has(f.childId) && real.has(f.parentId)) keep.add(f.childId);
    if (ghosts.has(f.parentId) && real.has(f.childId)) keep.add(f.parentId);
  }
  return keep;
}

/**
 * The whole geometry, in one pass.
 *
 * Sessions are packed per project; agents are packed per *expanded* session and
 * otherwise ride as hairlines inside their session's row. Fork edges are routed
 * last, once every bar has a y — and are dropped when either endpoint is absent
 * from the filtered set, because an edge to a session that is not on screen is
 * a line pointing at nothing.
 *
 * Ghosts are pruned before packing (see `connectedGhosts`) so a ghost with no
 * surviving family costs neither a lane nor a project row.
 */
export function layoutTimeline(input: TimelineInput, opts: TimelineOptions): TimelineLayout {
  const o = { ...DEFAULTS, ...opts };
  const { scale } = o;
  const expandedProjects = opts.expandedProjects ?? new Set<string>();
  const expandedSessions = opts.expandedSessions ?? new Set<string>();
  const laneGapMs = o.laneGapPx * scale.msPerPx;
  const minExtentMs = o.packEpsilonMs;
  const pack = (spans: readonly Packable[]) =>
    packLanes(drawnExtent(spans, minExtentMs), laneGapMs);

  // Prune disconnected ghosts first: a project whose only member is an orphan
  // ghost must not get a row, so this has to happen before `projectOrder`.
  // Undefined `live` means nothing is filtered, so every bar is live. A bar
  // whose id is absent from a present set is dimmed, never dropped.
  const isDim = (id: string) => (input.live ? !input.live.has(id) : false);

  const keepGhost = connectedGhosts(input.spans, input.forks);
  const spans = input.spans.filter((s) => !s.ghost || keepGhost.has(s.id));

  const sessions = spans.filter((s) => s.kind === "session");
  const agents = spans.filter((s) => s.kind === "agent");

  const agentsBySession = new Map<string, TimelineSpan[]>();
  for (const a of agents) {
    if (!a.parentId) continue;
    const list = agentsBySession.get(a.parentId);
    if (list) list.push(a);
    else agentsBySession.set(a.parentId, [a]);
  }

  const rows: LayoutRow[] = [];
  const bars: LayoutBar[] = [];
  const groups: LayoutGroup[] = [];
  /** session id → the row it was drawn on, for edge routing. */
  const sessionRow = new Map<string, LayoutRow>();
  const barById = new Map<string, LayoutBar>();

  const barX = (t0: number, t1: number) => {
    const x = scale.toPx(t0);
    const raw = scale.toPx(t1) - x;
    // Inset first, then floor the width: a one-turn span still gets a visible
    // mark, and a long one keeps a seam against its neighbour.
    return { x: x + o.barInsetPx, width: Math.max(o.minBarPx, raw - 2 * o.barInsetPx) };
  };

  let y = 0;
  for (const project of projectOrder(spans)) {
    const mine = sessions.filter((s) => s.project === project);
    if (mine.length === 0) continue;
    const collapsed = !expandedProjects.has(project);
    const rowStart = rows.length;
    const groupY = y;
    let nAgents = 0;
    let cost = 0;
    for (const s of mine) cost += s.cost;

    if (collapsed) {
      const row: LayoutRow = {
        index: rows.length,
        y,
        height: o.collapsedRowHeight,
        project,
        kind: "collapsed",
        lane: 0,
      };
      rows.push(row);
      y += o.collapsedRowHeight;
      // Every session lands on the one row; overlap is the density signal.
      for (const s of mine) {
        const { x, width } = barX(s.t0, s.t1);
        const bar: LayoutBar = {
          id: s.id,
          kind: "session",
          project,
          sessionId: null,
          agentType: null,
          context: s.context,
          x,
          width,
          y: row.y + (row.height - o.barHeight) / 2,
          height: o.barHeight,
          rowIndex: row.index,
          t0: s.t0,
          t1: s.t1,
          nTurns: s.nTurns,
          cost: s.cost,
          collapsed: true,
          strip: false,
          ghost: s.ghost === true,
          dim: isDim(s.id),
        };
        bars.push(bar);
        barById.set(s.id, bar);
        sessionRow.set(s.id, row);
        nAgents += agentsBySession.get(s.id)?.length ?? 0;
      }
    } else {
      const packing = pack(mine);
      const laneRows: LayoutRow[] = [];
      for (let i = 0; i < packing.laneCount; i++) {
        const row: LayoutRow = {
          index: rows.length,
          y,
          height: o.rowHeight,
          project,
          kind: "lane",
          lane: i,
        };
        rows.push(row);
        laneRows.push(row);
        y += o.rowHeight;
      }
      for (const s of mine) {
        const row = laneRows[packing.lane.get(s.id) ?? 0];
        const { x, width } = barX(s.t0, s.t1);
        const bar: LayoutBar = {
          id: s.id,
          kind: "session",
          project,
          sessionId: null,
          agentType: null,
          context: s.context,
          x,
          width,
          y: row.y + 1,
          height: o.barHeight,
          rowIndex: row.index,
          t0: s.t0,
          t1: s.t1,
          nTurns: s.nTurns,
          cost: s.cost,
          collapsed: false,
          strip: false,
          ghost: s.ghost === true,
          dim: isDim(s.id),
        };
        bars.push(bar);
        barById.set(s.id, bar);
        sessionRow.set(s.id, row);

        const mineAgents = agentsBySession.get(s.id) ?? [];
        nAgents += mineAgents.length;
        if (!expandedSessions.has(s.id)) {
          // Hairlines under the session bar: dense, always on, no extra rows.
          for (const a of mineAgents) {
            const g = barX(a.t0, a.t1);
            bars.push({
              id: a.id,
              kind: "agent",
              project,
              sessionId: s.id,
              agentType: a.agentType,
              context: a.context,
              x: g.x,
              width: g.width,
              y: row.y + 1 + o.barHeight + 0.5,
              height: 3,
              rowIndex: row.index,
              t0: a.t0,
              t1: a.t1,
              nTurns: a.nTurns,
              cost: a.cost,
              collapsed: false,
              strip: true,
              ghost: false,
              dim: isDim(a.id),
            });
          }
        }
      }

      // Expanded sessions get their agents on real sub-lanes, appended after
      // the project's session lanes so opening one never shifts the lanes
      // above it — the alternative, inserting rows mid-group, makes the whole
      // graph jump under the cursor.
      for (const s of mine) {
        if (!expandedSessions.has(s.id)) continue;
        const mineAgents = agentsBySession.get(s.id) ?? [];
        if (mineAgents.length === 0) continue;
        const packed = pack(mineAgents);
        const subRows: LayoutRow[] = [];
        for (let i = 0; i < packed.laneCount; i++) {
          const row: LayoutRow = {
            index: rows.length,
            y,
            height: o.agentRowHeight,
            project,
            kind: "agent",
            lane: i,
            sessionId: s.id,
          };
          rows.push(row);
          subRows.push(row);
          y += o.agentRowHeight;
        }
        for (const a of mineAgents) {
          const row = subRows[packed.lane.get(a.id) ?? 0];
          const g = barX(a.t0, a.t1);
          bars.push({
            id: a.id,
            kind: "agent",
            project,
            sessionId: s.id,
            agentType: a.agentType,
            context: a.context,
            x: g.x,
            width: g.width,
            y: row.y + (row.height - o.agentBarHeight) / 2,
            height: o.agentBarHeight,
            rowIndex: row.index,
            t0: a.t0,
            t1: a.t1,
            nTurns: a.nTurns,
            cost: a.cost,
            collapsed: false,
            strip: false,
            ghost: false,
            dim: isDim(a.id),
          });
        }
      }
    }

    const band = mergeSpans(drawnExtent(mine, minExtentMs), laneGapMs).map((m) => {
      const b = barX(m.t0, m.t1);
      return { x: b.x, width: b.width };
    });
    groups.push({
      project,
      y: groupY,
      height: y - groupY,
      rowStart,
      rowCount: rows.length - rowStart,
      collapsed,
      nSessions: mine.length,
      nAgents,
      cost,
      band,
    });
    y += o.groupGapPx;
  }

  const height = Math.max(0, y - (groups.length ? o.groupGapPx : 0));

  // --- edges, once every bar has a y ---------------------------------------
  const edges: LayoutEdge[] = [];

  for (const f of input.forks) {
    const child = barById.get(f.childId);
    const parentRow = sessionRow.get(f.parentId);
    const parentBar = barById.get(f.parentId);
    if (!child || !parentRow || !parentBar) continue; // an endpoint was filtered away

    // A `copy` branched out of the middle of the parent's life, so it leaves at
    // the fork point. A `continuation` inherited nothing on disk — the parent
    // simply carried on in a new file — so it leaves at the parent's end. Using
    // one anchor for both would put a continuation's departure inside the
    // parent's bar, reading as a branch that never happened.
    const x1 =
      f.kind === "continuation"
        ? Math.max(scale.toPx(f.forkTs), parentBar.x + parentBar.width)
        : scale.toPx(f.forkTs);
    const y1 = parentRow.y + parentRow.height / 2;
    const x2 = child.x;
    const y2 = child.y + child.height / 2;
    const gapPx = Math.abs(x2 - x1);
    edges.push({
      id: `fork:${f.parentId}->${f.childId}`,
      kind: "fork",
      path: edgePath(x1, y1, x2, y2, o.edgeHandlePx),
      x1,
      y1,
      x2,
      y2,
      gapPx,
      long: gapPx > o.longGapPx,
      ambiguous: f.ambiguous === true,
      forkKind: f.kind,
    });
  }

  // Launch edges only for agents on their own sub-lane; a hairline sitting
  // inside its session's row is already visibly attached to it.
  for (const bar of bars) {
    if (bar.kind !== "agent" || bar.strip || !bar.sessionId) continue;
    const row = sessionRow.get(bar.sessionId);
    if (!row) continue;
    const x1 = bar.x;
    const y1 = row.y + row.height / 2;
    const y2 = bar.y + bar.height / 2;
    edges.push({
      id: `launch:${bar.sessionId}->${bar.id}`,
      kind: "launch",
      path: edgePath(x1, y1, bar.x, y2, 10),
      x1,
      y1,
      x2: bar.x,
      y2,
      gapPx: 0,
      long: false,
      ambiguous: false,
    });
  }

  return { rows, bars, edges, groups, height, scale };
}

// ---------------------------------------------------------------------------
// axis + hit testing
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Candidate tick spacings, coarsest last. Months are approximated as 28 days. */
const TICK_STEPS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY];

export interface TimeTick {
  t: number;
  x: number;
  label: string;
  /** A UTC midnight — the view draws these brighter. */
  major: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Nice round ticks for the time axis, in **UTC**.
 *
 * UTC rather than local time so the ticks are deterministic (and so this is
 * testable at all), and to match the daily-spend chart next door, which already
 * bins on a UTC scale — two panels over the same corpus disagreeing about where
 * a day starts would be worse than either choice on its own.
 */
export function timeTicks(scale: TimeScale, target = 8): TimeTick[] {
  const span = scale.t1 - scale.t0;
  const step = TICK_STEPS.find((s) => span / s <= target) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const out: TimeTick[] = [];
  for (let t = Math.ceil(scale.t0 / step) * step; t <= scale.t1; t += step) {
    const d = new Date(t);
    const midnight = t % DAY === 0;
    out.push({
      t,
      x: scale.toPx(t),
      major: midnight,
      label:
        step < DAY && !midnight
          ? `${pad(d.getUTCHours())}:00`
          : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`,
    });
  }
  return out;
}

/**
 * The bar under a point, or null.
 *
 * Ties break toward the *narrower* bar: an agent hairline sits inside its
 * session's row and is a couple of pixels tall, so a plain first-match would
 * make it unhoverable and the more specific thing is always the one meant.
 */
export function hitTest(layout: TimelineLayout, x: number, y: number, slop = 2): LayoutBar | null {
  let best: LayoutBar | null = null;
  for (const b of layout.bars) {
    if (x < b.x - slop || x > b.x + b.width + slop) continue;
    if (y < b.y - slop || y > b.y + b.height + slop) continue;
    if (!best || b.width < best.width) best = b;
  }
  return best;
}
