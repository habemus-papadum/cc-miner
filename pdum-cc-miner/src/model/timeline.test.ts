/**
 * timeline.test.ts — the lane algebra, checked without a browser.
 *
 * One standing hazard, learned here the hard way (see this demo's CLAUDE.md):
 * several assertions below reach into `bars.find(...)` or `edges.find(...)`
 * with `?.`, so when a rules change makes the subject disappear, a NEGATIVE
 * assertion goes vacuously true and stays green. Where a fixture's presence is
 * load-bearing, assert it — `expect(bar).toBeDefined()` — before asserting
 * anything about its fields.
 *
 * The layout is a pure function, so the interesting claims are all testable as
 * claims: that the packing is *optimal* (never more lanes than the data forces),
 * that it is *sound* (nothing overlaps on a lane), that it is *stable* (input
 * order cannot change the answer), and that a fork whose parent went quiet days
 * earlier still produces a routable edge.
 */
import { describe, expect, it } from "vitest";
import {
  drawnExtent,
  edgePath,
  hitTest,
  layoutTimeline,
  mergeSpans,
  type Packable,
  packLanes,
  type TimelineSpan,
  timeScale,
  timeTicks,
} from "./timeline";

const H = 3600_000;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 5, 1);

const span = (id: string, h0: number, h1: number): Packable => ({
  id,
  t0: T0 + h0 * H,
  t1: T0 + h1 * H,
});

/**
 * The reference the packing is graded against: the largest set of spans that
 * mutually conflict. For interval graphs this is the chromatic number, so an
 * optimal packer must use exactly this many lanes — no fixture-specific
 * expected values, just the bound.
 */
function maxClique(spans: readonly Packable[], gap = 0): number {
  let best = spans.length ? 1 : 0;
  for (const p of spans.map((s) => s.t0)) {
    let n = 0;
    for (const u of spans) if (u.t0 <= p && u.t1 + gap > p) n++;
    if (n > best) best = n;
  }
  return best;
}

/** Every pair sharing a lane must be disjoint (half-open, plus the gutter). */
function assertNoOverlap(spans: readonly Packable[], lane: ReadonlyMap<string, number>, gap = 0) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  for (const a of spans) {
    for (const b of spans) {
      if (a.id >= b.id) continue;
      if (lane.get(a.id) !== lane.get(b.id)) continue;
      const x = byId.get(a.id)!;
      const y = byId.get(b.id)!;
      const disjoint = x.t1 + gap <= y.t0 || y.t1 + gap <= x.t0;
      expect(disjoint, `${a.id} and ${b.id} share a lane but overlap`).toBe(true);
    }
  }
}

describe("packLanes", () => {
  it("puts strictly sequential spans on one lane, however many there are", () => {
    // The mcp-list-changed shape: ten sessions back to back, never concurrent.
    const spans = Array.from({ length: 10 }, (_, i) => span(`s${i}`, i * 2, i * 2 + 1));
    const { laneCount, lane } = packLanes(spans);
    expect(laneCount).toBe(1);
    expect(new Set(lane.values())).toEqual(new Set([0]));
  });

  it("shares a lane between spans that merely abut", () => {
    // Half-open: ending exactly when the next begins is sequential, not
    // concurrent, and must not cost a second lane.
    const spans = [span("a", 0, 4), span("b", 4, 8)];
    expect(packLanes(spans).laneCount).toBe(1);
  });

  it("stacks concurrent spans and reuses the lane once free", () => {
    const spans = [span("a", 0, 10), span("b", 1, 3), span("c", 4, 6)];
    const { lane, laneCount } = packLanes(spans);
    expect(laneCount).toBe(2);
    expect(lane.get("a")).toBe(0);
    // b ends at 3, so c reuses lane 1 rather than opening a third.
    expect(lane.get("b")).toBe(1);
    expect(lane.get("c")).toBe(1);
  });

  it("uses exactly the optimal number of lanes", () => {
    const cases: Packable[][] = [
      [],
      [span("a", 0, 1)],
      [span("a", 0, 10), span("b", 1, 9), span("c", 2, 8), span("d", 3, 7)],
      [span("a", 0, 3), span("b", 1, 4), span("c", 2, 5), span("d", 6, 7)],
      Array.from({ length: 20 }, (_, i) => span(`s${i}`, i, i + 5)),
    ];
    for (const spans of cases) {
      const { laneCount, lane } = packLanes(spans);
      expect(laneCount).toBe(maxClique(spans));
      assertNoOverlap(spans, lane);
    }
  });

  it("stays optimal and sound with a visual gutter", () => {
    const gap = 30 * 60_000;
    const spans = [span("a", 0, 2), span("b", 2.25, 4), span("c", 1, 3), span("d", 8, 9)];
    const { laneCount, lane } = packLanes(spans, gap);
    expect(laneCount).toBe(maxClique(spans, gap));
    assertNoOverlap(spans, lane, gap);
  });

  it("is independent of input order", () => {
    const spans = [
      span("a", 0, 10),
      span("b", 1, 3),
      span("c", 4, 6),
      span("d", 2, 12),
      span("e", 11, 13),
    ];
    const base = packLanes(spans);
    for (const perm of [
      [...spans].reverse(),
      [spans[3], spans[0], spans[4], spans[1], spans[2]],
      [...spans].sort((x, y) => (x.id < y.id ? 1 : -1)),
    ]) {
      const got = packLanes(perm);
      expect(got.laneCount).toBe(base.laneCount);
      expect([...got.lane].sort()).toEqual([...base.lane].sort());
    }
  });

  it("keeps a long-running span on its lane for its whole life", () => {
    // The git-graph property: the trunk does not wander down the page while
    // short-lived branches come and go beside it.
    const long = span("long", 0, 100);
    const shorts = Array.from({ length: 8 }, (_, i) => span(`s${i}`, i * 10 + 1, i * 10 + 4));
    const { lane } = packLanes([long, ...shorts]);
    expect(lane.get("long")).toBe(0);
    for (const s of shorts) expect(lane.get(s.id)).toBe(1);
  });
});

describe("drawnExtent", () => {
  it("separates coincident zero-duration spans", () => {
    // Two one-turn sessions at the same instant are empty intervals: without an
    // extent they conflict with nothing and would be drawn on top of each other.
    const points = [span("a", 5, 5), span("b", 5, 5)];
    expect(packLanes(points).laneCount).toBe(1);
    expect(packLanes(drawnExtent(points, 1)).laneCount).toBe(2);
  });

  it("does not disturb spans that already have duration", () => {
    const spans = [span("a", 0, 4), span("b", 4, 8)];
    expect(packLanes(drawnExtent(spans, 1)).laneCount).toBe(1);
  });
});

describe("mergeSpans", () => {
  it("fuses overlapping and abutting spans into activity bands", () => {
    const spans = [span("a", 0, 2), span("b", 1, 3), span("c", 3, 4), span("d", 20, 21)];
    expect(mergeSpans(spans)).toEqual([
      { t0: T0, t1: T0 + 4 * H },
      { t0: T0 + 20 * H, t1: T0 + 21 * H },
    ]);
  });

  it("returns nothing for no spans", () => {
    expect(mergeSpans([])).toEqual([]);
  });
});

describe("edgePath", () => {
  it("leaves and arrives horizontally", () => {
    // Both control points share their endpoint's y, so the curve is flat where
    // it attaches — that is what makes the joined lanes readable.
    expect(edgePath(0, 10, 100, 50, 34)).toBe("M0,10C34,10 66,50 100,50");
  });

  it("caps the handle so a long gap does not become one vast arc", () => {
    const near = edgePath(0, 0, 40, 20, 34);
    const far = edgePath(0, 0, 4000, 20, 34);
    expect(near).toContain("C18,0"); // 40 * 0.45, under the cap
    expect(far).toContain("C34,0"); // capped
    expect(far).toContain("3966,20");
  });

  it("keeps a minimum handle when the endpoints share an x", () => {
    // An agent launched at an instant: the drop is vertical, and a zero handle
    // would degenerate the cubic into an invisible straight line.
    expect(edgePath(50, 0, 50, 12, 10)).toBe("M50,0C56,0 44,12 50,12");
  });
});

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

const sess = (
  id: string,
  project: string,
  h0: number,
  h1: number,
  extra: Partial<TimelineSpan> = {},
): TimelineSpan => ({
  kind: "session",
  id,
  project,
  parentId: null,
  t0: T0 + h0 * H,
  t1: T0 + h1 * H,
  nTurns: 10,
  cost: 1,
  agentType: null,
  context: "main",
  ...extra,
});

const agent = (
  id: string,
  parentId: string,
  project: string,
  h0: number,
  h1: number,
): TimelineSpan => ({
  ...sess(id, project, h0, h1),
  kind: "agent",
  parentId,
  agentType: "general-purpose",
  context: "subagent",
});

const scaleOver = (hours: number, width = 1000) => timeScale([T0, T0 + hours * H], [0, width]);

describe("layoutTimeline — the filter dims, it does not drop", () => {
  // The crossfilter idiom, and the reason it is in the layout rather than the
  // view: bars must keep their lanes while a brush moves, so the layout is fed
  // the whole corpus and told which ids survive.
  const spans = [sess("s1", "p", 0, 2), sess("s2", "p", 3, 5), sess("s3", "p", 6, 8)];
  const opts = { scale: scaleOver(10) };

  it("keeps every bar and marks the excluded ones", () => {
    const l = layoutTimeline({ spans, forks: [], live: new Set(["s2"]) }, opts);
    expect(l.bars).toHaveLength(3);
    const by = new Map(l.bars.map((b) => [b.id, b]));
    expect(by.get("s2")?.dim).toBe(false);
    expect(by.get("s1")?.dim).toBe(true);
    expect(by.get("s3")?.dim).toBe(true);
  });

  it("treats an absent live set as nothing filtered", () => {
    const l = layoutTimeline({ spans, forks: [] }, opts);
    expect(l.bars.every((b) => !b.dim)).toBe(true);
  });

  it("lays out identically whatever survives — lanes must not move", () => {
    // The stability claim. If a brush changed the geometry, every drag would
    // reflow the chart under the cursor.
    const geom = (live?: ReadonlySet<string>) =>
      layoutTimeline({ spans, forks: [], ...(live ? { live } : {}) }, opts)
        .bars.map((b) => `${b.id}:${b.x.toFixed(2)},${b.y},${b.rowIndex}`)
        .sort()
        .join("|");
    expect(geom(new Set(["s2"]))).toBe(geom());
    expect(geom(new Set())).toBe(geom());
  });

  it("dims an agent independently of its session", () => {
    const withAgent = [...spans, agent("a1", "s1", "p", 0, 1)];
    const l = layoutTimeline(
      { spans: withAgent, forks: [], live: new Set(["s1"]) },
      // Both, not just the session: an unexpanded PROJECT collapses to one row
      // and never lays out its agents at all.
      { ...opts, expandedProjects: new Set(["p"]), expandedSessions: new Set(["s1"]) },
    );
    const by = new Map(l.bars.map((b) => [b.id, b]));
    expect(by.get("s1")?.dim).toBe(false);
    expect(by.get("a1"), "the agent bar should still be laid out").toBeDefined();
    expect(by.get("a1")?.dim).toBe(true);
  });
});

describe("layoutTimeline", () => {
  it("orders projects by first activity and gives each its own band", () => {
    const spans = [sess("s1", "late", 10, 12), sess("s2", "early", 0, 2)];
    const l = layoutTimeline({ spans, forks: [] }, { scale: scaleOver(24) });
    expect(l.groups.map((g) => g.project)).toEqual(["early", "late"]);
    expect(l.groups[0].y).toBeLessThan(l.groups[1].y);
  });

  it("collapses a project to one row and expands it to its lane count", () => {
    const spans = [sess("a", "p", 0, 10), sess("b", "p", 1, 3), sess("c", "p", 2, 4)];
    const scale = scaleOver(24);
    const collapsed = layoutTimeline({ spans, forks: [] }, { scale });
    expect(collapsed.rows).toHaveLength(1);
    expect(collapsed.rows[0].kind).toBe("collapsed");
    expect(collapsed.bars.filter((b) => b.collapsed)).toHaveLength(3);

    const expanded = layoutTimeline(
      { spans, forks: [] },
      { scale, expandedProjects: new Set(["p"]) },
    );
    expect(expanded.rows).toHaveLength(3);
    expect(expanded.height).toBeGreaterThan(collapsed.height);
    // Same data either way — collapsing is presentation, not filtering.
    expect(expanded.bars.filter((b) => b.kind === "session")).toHaveLength(3);
  });

  it("draws agents as hairlines inside the session row until the session opens", () => {
    const spans = [
      sess("s", "p", 0, 10),
      agent("a1", "s", "p", 1, 2),
      agent("a2", "s", "p", 1.5, 3),
    ];
    const scale = scaleOver(24);
    const shut = layoutTimeline({ spans, forks: [] }, { scale, expandedProjects: new Set(["p"]) });
    expect(shut.rows).toHaveLength(1);
    expect(shut.bars.filter((b) => b.kind === "agent").every((b) => b.strip)).toBe(true);
    expect(shut.edges).toHaveLength(0); // a hairline is already visibly attached

    const open = layoutTimeline(
      { spans, forks: [] },
      { scale, expandedProjects: new Set(["p"]), expandedSessions: new Set(["s"]) },
    );
    // a1 and a2 overlap, so they need two sub-lanes below the session's lane.
    expect(open.rows.filter((r) => r.kind === "agent")).toHaveLength(2);
    expect(open.bars.filter((b) => b.kind === "agent").every((b) => !b.strip)).toBe(true);
    expect(open.edges.filter((e) => e.kind === "launch")).toHaveLength(2);
  });

  it("appends agent sub-lanes below the project's session lanes, so nothing above shifts", () => {
    const spans = [sess("s1", "p", 0, 10), sess("s2", "p", 1, 9), agent("a1", "s1", "p", 2, 3)];
    const scale = scaleOver(24);
    const opts = { scale, expandedProjects: new Set(["p"]) };
    const shut = layoutTimeline({ spans, forks: [] }, opts);
    const open = layoutTimeline(
      { spans, forks: [] },
      { ...opts, expandedSessions: new Set(["s1"]) },
    );
    const yOf = (l: typeof shut, id: string) => l.bars.find((b) => b.id === id)!.y;
    expect(yOf(open, "s1")).toBe(yOf(shut, "s1"));
    expect(yOf(open, "s2")).toBe(yOf(shut, "s2"));
    expect(open.rows.at(-1)!.kind).toBe("agent");
  });

  it("routes a stale fork from the fork point, not from the parent's last event", () => {
    // The user's hard case: the parent went quiet on day 1, the fork was taken
    // from a point midway through it, and the child only started on day 9.
    const parent = sess("parent", "p", 0, 20);
    const child = sess("child", "p", 9 * 24, 9 * 24 + 4);
    const forkTs = T0 + 6 * H; // midway through the parent, long before its end
    const scale = timeScale([T0, T0 + 10 * DAY], [0, 1000]);
    const l = layoutTimeline(
      { spans: [parent, child], forks: [{ childId: "child", parentId: "parent", forkTs }] },
      { scale, expandedProjects: new Set(["p"]) },
    );
    const edge = l.edges.find((e) => e.kind === "fork")!;
    expect(edge).toBeDefined();
    expect(edge.x1).toBeCloseTo(scale.toPx(forkTs), 5);
    // Anchored at the fork point, well left of where the parent's bar ends.
    expect(edge.x1).toBeLessThan(
      l.bars.find((b) => b.id === "parent")!.x + l.bars.find((b) => b.id === "parent")!.width,
    );
    expect(edge.long).toBe(true);
    // Flat at both ends despite the ~890px span: the handles are capped.
    expect(edge.path).toMatch(/^M[\d.]+,[\d.]+C/);
    const handle = Number(edge.path.split("C")[1].split(",")[0]) - edge.x1;
    expect(handle).toBeLessThanOrEqual(34);
  });

  it("marks a fork short enough to read as adjacent", () => {
    const scale = timeScale([T0, T0 + 10 * DAY], [0, 1000]);
    const l = layoutTimeline(
      {
        spans: [sess("parent", "p", 0, 20), sess("child", "p", 21, 30)],
        forks: [{ childId: "child", parentId: "parent", forkTs: T0 + 19 * H }],
      },
      { scale, expandedProjects: new Set(["p"]) },
    );
    expect(l.edges.find((e) => e.kind === "fork")!.long).toBe(false);
  });

  it("drops a fork edge whose other end was filtered away", () => {
    // Half an edge is a line pointing at nothing; the crossfilter makes this
    // the normal case, not an exotic one.
    const scale = scaleOver(24);
    const l = layoutTimeline(
      {
        spans: [sess("child", "p", 5, 8)],
        forks: [{ childId: "child", parentId: "gone", forkTs: T0 }],
      },
      { scale, expandedProjects: new Set(["p"]) },
    );
    expect(l.edges).toHaveLength(0);
  });

  it("gives a one-turn session a visible bar", () => {
    const l = layoutTimeline(
      { spans: [sess("blip", "p", 5, 5)], forks: [] },
      { scale: timeScale([T0, T0 + 30 * DAY], [0, 1000]) },
    );
    expect(l.bars[0].width).toBeGreaterThanOrEqual(1.5);
  });

  it("produces an empty, finite layout for no data", () => {
    const l = layoutTimeline({ spans: [], forks: [] }, { scale: scaleOver(24) });
    expect(l).toMatchObject({ rows: [], bars: [], edges: [], groups: [], height: 0 });
  });

  it("never lets two bars on one row overlap", () => {
    // The property that matters at the pixel level, checked on a messy set.
    const spans: TimelineSpan[] = [];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 60; i++) {
      const start = rand() * 200;
      spans.push(sess(`s${i}`, `p${i % 3}`, start, start + rand() * 30));
    }
    const l = layoutTimeline(
      { spans, forks: [] },
      { scale: scaleOver(240, 2000), expandedProjects: new Set(["p0", "p1", "p2"]) },
    );
    const byRow = new Map<number, typeof l.bars>();
    for (const b of l.bars) {
      const list = byRow.get(b.rowIndex) ?? [];
      list.push(b);
      byRow.set(b.rowIndex, list);
    }
    for (const list of byRow.values()) {
      const sorted = [...list].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].width - 0.01);
      }
    }
  });
});

describe("timeTicks", () => {
  it("picks a step coarse enough to stay near the target count", () => {
    const ticks = timeTicks(timeScale([T0, T0 + 37 * DAY], [0, 1400]), 8);
    expect(ticks.length).toBeLessThanOrEqual(9);
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.every((t) => t.major)).toBe(true); // a multi-day step lands on midnights
    expect(ticks[0].label).toMatch(/^[A-Z][a-z]{2} \d+$/);
  });

  it("falls back to hours on a short domain", () => {
    const ticks = timeTicks(timeScale([T0 + 1 * H, T0 + 9 * H], [0, 800]), 8);
    expect(ticks.some((t) => /^\d\d:00$/.test(t.label))).toBe(true);
  });

  it("keeps every tick inside the domain and in order", () => {
    const scale = timeScale([T0 + 5 * H, T0 + 20 * DAY], [0, 1000]);
    const ticks = timeTicks(scale);
    for (const t of ticks) {
      expect(t.t).toBeGreaterThanOrEqual(scale.t0);
      expect(t.t).toBeLessThanOrEqual(scale.t1);
      expect(t.x).toBeCloseTo(scale.toPx(t.t), 6);
    }
    expect(ticks.map((t) => t.t)).toEqual([...ticks.map((t) => t.t)].sort((a, b) => a - b));
  });
});

describe("hitTest", () => {
  const spans = [sess("s", "p", 0, 10), agent("a", "s", "p", 2, 3)];
  const layout = layoutTimeline(
    { spans, forks: [] },
    { scale: scaleOver(24), expandedProjects: new Set(["p"]) },
  );

  it("prefers the agent hairline over the session bar beneath it", () => {
    // The hairline is 2px tall and sits inside the session's row; a first-match
    // scan would return the session and the agent would be unhoverable.
    const hair = layout.bars.find((b) => b.kind === "agent")!;
    const hit = hitTest(layout, hair.x + hair.width / 2, hair.y + 1, 0);
    expect(hit?.id).toBe("a");
  });

  it("returns the session where no agent overlaps", () => {
    const bar = layout.bars.find((b) => b.id === "s")!;
    expect(hitTest(layout, bar.x + bar.width - 2, bar.y + 2, 0)?.id).toBe("s");
  });

  it("returns null off the marks", () => {
    expect(hitTest(layout, 5, 5000, 0)).toBeNull();
  });
});

describe("fork edge provenance", () => {
  const scale = () => timeScale([T0, T0 + 10 * DAY], [0, 1000]);
  const pair = (forkTs: number, extra: Partial<import("./timeline").ForkEdgeInput> = {}) =>
    layoutTimeline(
      {
        spans: [sess("parent", "p", 0, 20), sess("child", "p", 40, 50)],
        forks: [{ childId: "child", parentId: "parent", forkTs, ...extra }],
      },
      { scale: scale(), expandedProjects: new Set(["p"]) },
    );

  it("leaves a copy at the fork point, inside the parent's life", () => {
    const forkTs = T0 + 6 * H; // parent runs 0..20h, so this is mid-bar
    const l = pair(forkTs, { kind: "copy" });
    const edge = l.edges.find((e) => e.kind === "fork");
    const parent = l.bars.find((b) => b.id === "parent");
    expect(edge?.x1).toBeCloseTo(scale().toPx(forkTs), 5);
    expect(edge?.x1).toBeLessThan((parent?.x ?? 0) + (parent?.width ?? 0));
    expect(edge?.forkKind).toBe("copy");
  });

  it("leaves a continuation at the parent's end, never inside its bar", () => {
    // Nothing was inherited on disk, so a departure drawn mid-bar would show a
    // branch that never happened.
    const forkTs = T0 + 6 * H;
    const l = pair(forkTs, { kind: "continuation" });
    const edge = l.edges.find((e) => e.kind === "fork");
    const parent = l.bars.find((b) => b.id === "parent");
    expect(edge?.x1).toBeGreaterThanOrEqual((parent?.x ?? 0) + (parent?.width ?? 0));
  });

  it("carries the unproven-direction flag through to the edge", () => {
    expect(pair(T0 + 6 * H, { ambiguous: true }).edges[0].ambiguous).toBe(true);
    expect(pair(T0 + 6 * H).edges[0].ambiguous).toBe(false);
  });

  it("keeps ambiguity and long-gap independent", () => {
    // Two different claims — "we could not prove the direction" and "these are
    // far apart in time" — so one must never imply the other.
    const near = pair(T0 + 19 * H, { ambiguous: true });
    expect(near.edges[0].ambiguous).toBe(true);
    expect(near.edges[0].long).toBe(false);
    const far = pair(T0 + 1 * H, { ambiguous: false });
    expect(far.edges[0].ambiguous).toBe(false);
    expect(far.edges[0].long).toBe(true);
  });

  it("routes a multi-level fork chain, each hop independently", () => {
    // The real pdum_rfb shape: a -> b -> c, three sessions, two edges.
    const l = layoutTimeline(
      {
        spans: [sess("a", "p", 0, 10), sess("b", "p", 8, 20), sess("c", "p", 18, 30)],
        forks: [
          { childId: "b", parentId: "a", forkTs: T0 + 5 * H, kind: "copy" },
          { childId: "c", parentId: "b", forkTs: T0 + 15 * H, kind: "copy" },
        ],
      },
      { scale: scale(), expandedProjects: new Set(["p"]) },
    );
    const forks = l.edges.filter((e) => e.kind === "fork");
    expect(forks).toHaveLength(2);
    // Each hop connects two DIFFERENT lanes — a, b and c all overlap.
    for (const e of forks) expect(e.y1).not.toBe(e.y2);
  });
});

/**
 * A lesson these tests taught the hard way, worth keeping next to them.
 *
 * When the ghost visibility rule changed, two tests here relied on an edgeless
 * ghost. One failed loudly — good. The other had silently gone **vacuous**:
 * `expect(undefined).not.toBe(0)` passes, for entirely the wrong reason. An
 * optional chain in an assertion turns a real check into a tautology the moment
 * the thing it reaches for stops existing.
 *
 * That failure survives every gate — biome, typecheck, a green test run — while
 * still reading as coverage, which makes it worse than a missing test. When an
 * assertion narrows through `?.`, assert the subject exists first
 * (`expect(bar).toBeDefined()`), or match on a whole object rather than a field
 * reached through an optional.
 *
 * **Do not take biome's autofix here.** `lint/style/noNonNullAssertion` warns on
 * the `!` in `bars.find(...)!.y` and offers `?.` as the fix — which is precisely
 * the transformation that produces the bug above. On a missing bar, `!` throws
 * and the test fails loudly; `?.` yields `undefined` and
 * `expect(undefined).toBe(undefined)` passes. The rule is right about production
 * code and wrong about assertions, so the `!`s in this file are deliberate: in a
 * test, a throw IS the failure signal.
 */
describe("ghost sessions (forks that produced no turns)", () => {
  const gscale = () => timeScale([T0, T0 + 10 * DAY], [0, 1000]);
  const ghost = (id: string, project: string, h0: number, h1: number): TimelineSpan => ({
    ...sess(id, project, h0, h1),
    nTurns: 0,
    cost: 0,
    ghost: true,
  });

  it("keeps a fork chain connected through a node that produced nothing", () => {
    // The real pdum_dsl shape: 63baa90e -> 4df4dbb9 -> {70486150, de93c3a5},
    // where the middle session file has zero billed turns. Without a mark for
    // it, BOTH downstream edges have nowhere to attach and the family reads as
    // three unrelated sessions.
    const spans = [
      sess("root", "p", 0, 20),
      ghost("middle", "p", 20, 20),
      sess("childA", "p", 21, 30),
      sess("childB", "p", 22, 40),
    ];
    const forks = [
      { childId: "middle", parentId: "root", forkTs: T0 + 18 * H },
      { childId: "childA", parentId: "middle", forkTs: T0 + 20 * H },
      { childId: "childB", parentId: "middle", forkTs: T0 + 20 * H },
    ];
    const l = layoutTimeline(
      { spans, forks },
      { scale: gscale(), expandedProjects: new Set(["p"]) },
    );
    expect(l.edges.filter((e) => e.kind === "fork")).toHaveLength(3);

    // Drop the ghost and EVERY edge in the family disappears — the two below it
    // lose their parent, and the one above it loses its child. One unrenderable
    // node takes the whole fork tree with it, which is why it gets a mark.
    const without = layoutTimeline(
      { spans: spans.filter((x) => !x.ghost), forks },
      { scale: gscale(), expandedProjects: new Set(["p"]) },
    );
    expect(without.edges.filter((e) => e.kind === "fork")).toHaveLength(0);
  });

  // A ghost needs an edge to a real session to be drawn at all — see the
  // transitive-visibility suite below — so these two fixtures carry one.
  const attached = {
    spans: [sess("real", "p", 0, 10), ghost("empty", "p", 5, 5)],
    forks: [{ childId: "empty", parentId: "real", forkTs: T0 + 5 * H }],
  };

  it("marks the bar as a ghost so the view can draw it hollow", () => {
    const l = layoutTimeline(attached, {
      scale: gscale(),
      expandedProjects: new Set(["p"]),
    });
    expect(l.bars.find((b) => b.id === "empty")?.ghost).toBe(true);
    expect(l.bars.find((b) => b.id === "real")?.ghost).toBe(false);
  });

  it("gives a zero-duration ghost its own lane rather than overlaying a session", () => {
    const l = layoutTimeline(attached, {
      scale: gscale(),
      expandedProjects: new Set(["p"]),
    });
    const empty = l.bars.find((b) => b.id === "empty");
    expect(empty).toBeDefined();
    expect(empty?.rowIndex).not.toBe(l.bars.find((b) => b.id === "real")?.rowIndex);
  });
});

describe("ghost visibility is transitive, not exempt", () => {
  const tscale = () => timeScale([T0, T0 + 10 * DAY], [0, 1000]);
  const gh = (id: string, project: string, h0: number): TimelineSpan => ({
    ...sess(id, project, h0, h0),
    nTurns: 0,
    cost: 0,
    ghost: true,
  });
  // The real pdum_dsl family: root -> ghost -> {childA, childB}.
  const root = sess("root", "p", 0, 20);
  const middle = gh("middle", "p", 20);
  const childA = sess("childA", "p", 21, 30);
  const childB = sess("childB", "p", 22, 40);
  const forks = [
    { childId: "middle", parentId: "root", forkTs: T0 + 18 * H },
    { childId: "childA", parentId: "middle", forkTs: T0 + 20 * H },
    { childId: "childB", parentId: "middle", forkTs: T0 + 20 * H },
  ];
  const lay = (spans: TimelineSpan[]) =>
    layoutTimeline({ spans, forks }, { scale: tscale(), expandedProjects: new Set(["p"]) });

  it("draws the ghost and every edge when the family is in the filtered set", () => {
    const l = lay([root, middle, childA, childB]);
    expect(l.bars.some((b) => b.id === "middle")).toBe(true);
    expect(l.edges.filter((e) => e.kind === "fork")).toHaveLength(3);
  });

  it("drops the ghost and its edges when the filter excludes the whole family", () => {
    // A filter that selects no turn-bearing session in this family leaves the
    // ghost with nothing to anchor: a hollow mark alone would read as "something
    // happened here" when the filter says nothing did.
    const l = lay([middle]);
    expect(l.bars.some((b) => b.id === "middle")).toBe(false);
    expect(l.edges).toHaveLength(0);
    expect(l.groups).toHaveLength(0); // and it must not manufacture a project row
  });

  it("keeps a ghost whose only surviving neighbour is its parent", () => {
    // Deliberately NOT requiring a neighbour on both sides. "You forked here and
    // it went nowhere" is the case this feature exists for, and an abandoned
    // fork usually has no children — demanding one would hide exactly it.
    const l = lay([root, middle]);
    expect(l.bars.some((b) => b.id === "middle")).toBe(true);
    expect(l.edges.filter((e) => e.kind === "fork")).toHaveLength(1);
  });

  it("keeps a ghost whose only surviving neighbours are its children", () => {
    const l = lay([middle, childA, childB]);
    expect(l.bars.some((b) => b.id === "middle")).toBe(true);
    expect(l.edges.filter((e) => e.kind === "fork")).toHaveLength(2);
  });

  it("never lets one ghost justify another", () => {
    // Connectivity is measured against REAL sessions only, in one pass, so a
    // chain of ghosts cannot bootstrap itself into existence.
    const g1 = gh("g1", "p", 5);
    const g2 = gh("g2", "p", 6);
    const l = layoutTimeline(
      { spans: [g1, g2], forks: [{ childId: "g2", parentId: "g1", forkTs: T0 + 5 * H }] },
      { scale: tscale(), expandedProjects: new Set(["p"]) },
    );
    expect(l.bars).toHaveLength(0);
    expect(l.groups).toHaveLength(0);
  });

  it("costs no lane when pruned", () => {
    // Pruning happens before packing, so a dropped ghost cannot widen a project.
    const withGhost = lay([root, middle, childA, childB]);
    const noFamily = lay([root, childA, childB]);
    expect(noFamily.rows.length).toBeLessThanOrEqual(withGhost.rows.length);
  });
});
