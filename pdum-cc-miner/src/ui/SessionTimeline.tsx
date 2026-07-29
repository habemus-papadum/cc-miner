/**
 * SessionTimeline.tsx — the session graph (playbook layer 3: a pure reader).
 *
 * Wide and short: every session this corpus knows about, laid out as a git
 * commit graph. Horizontal is wall-clock time, vertical is a *lane* — one
 * per concurrent session inside a project — and the beziers are forks.
 *
 * The component owns no logic. Geometry comes from `layoutTimeline`
 * (model/timeline.ts, pure and unit-tested), rows come from
 * `SessionTimelineClient` (model/timeline-client.ts, the Mosaic client), and
 * expansion state lives in the store. What is left here is SVG and pointers.
 *
 * SVG rather than Canvas, on measurement rather than faith: the real corpus
 * lays out to 467 marks (104 sessions + 363 agents), and a re-layout is
 * confined to data/width/expansion changes — dragging the brush moves one rect
 * and re-queries the coordinator, it does not touch the 467. Canvas would buy
 * nothing at this size and cost the hit-testing, the CSS tokens, and the
 * screenshot-to-source attribution the aiui loop depends on. The threshold
 * where that flips is somewhere in the thousands of marks, not the hundreds.
 */

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { brushTime, setAllCollapsed, store, toggleProject, toggleSession } from "../model/store";
import { hitTest, type LayoutBar, layoutTimeline, timeScale, timeTicks } from "../model/timeline";

// --- palette -----------------------------------------------------------------
//
// Validated against this page's panel surface (#1a1d23) with the dataviz
// six-check procedure, in dark mode:
//
//  - cost ramp — one hue, 5 steps, monotone lightness, ΔL >= 0.06 between
//    steps, dimmest step 2.65:1 against the surface. On a dark surface the
//    *dim* end is the one that has to clear the floor, so the ramp starts at a
//    mid-tone rather than near-black.
//  - the three co-occurring marks (a mid session bar, the two agent classes)
//    pass as a categorical set: worst adjacent CVD ΔE 10.7 (protan), worst
//    normal-vision ΔE 17.5, all >= 3:1 on the surface.
//
// The page's existing tokens (--cco-accent #7aa2f7 and friends) sit above the
// dark-mode lightness band at L≈0.72-0.76, so these are their in-band
// relatives: same families, so the panel still reads as one system.

const COST_RAMP = ["#41608f", "#4f74ab", "#5d88c7", "#6c9ce3", "#7bb0ff"];

/**
 * Absolute USD breakpoints, never quantiles.
 *
 * Color follows the entity, not its rank: with quantile buckets, brushing a
 * range would repaint every surviving session as the distribution shifted
 * underneath it, and the same session would change color for no reason the
 * reader can see. Fixed breaks mean a given bar's color means the same thing
 * in every view.
 *
 * The *values* are calibrated once against the real distribution, which is
 * heavily skewed — session cost runs $0 to $1,225 with a median of $11.62 —
 * so the breaks are spaced roughly logarithmically. Reading them off the data
 * once is not the same as recomputing them per render: these numbers are now
 * constants, and a filter cannot move them.
 */
const COST_BREAKS = [1, 10, 50, 200];

function costColor(cost: number): string {
  let i = 0;
  while (i < COST_BREAKS.length && cost >= COST_BREAKS[i]) i++;
  return COST_RAMP[i];
}

/** Agents are colored by *context*, not by agentType — two classes, not seven. */
const AGENT_COLOR: Record<string, string> = {
  subagent: "#35a389",
  "workflow-agent": "#c2872f",
};
const agentColor = (context: string) => AGENT_COLOR[context] ?? "#35a389";

const GUTTER = 138;
const PAD_RIGHT = 12;
const AXIS_H = 22;

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const dur = (ms: number) =>
  ms >= 86400_000
    ? `${(ms / 86400_000).toFixed(1)}d`
    : ms >= 3600_000
      ? `${(ms / 3600_000).toFixed(1)}h`
      : `${Math.max(1, Math.round(ms / 60_000))}m`;
const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

interface Hover {
  bar: LayoutBar;
  x: number;
  y: number;
}

export function SessionTimeline() {
  const [width, setWidth] = createSignal(1200);
  const [hover, setHover] = createSignal<Hover | null>(null);

  /**
   * The name for a bar, or undefined when it has none.
   *
   * A fork's label is deliberately NOT shown: it is built from the opening
   * words of a prompt (`where-is-the`), so presenting it as a name would
   * attribute to the user a choice they never made.
   */
  const named = (bar: LayoutBar) => {
    const hit = store.timeline().names.get(bar.id);
    return hit && hit.kind !== "fork" ? hit : undefined;
  };

  /**
   * The line under the name: what kind of thing this is and where it lives.
   *
   * Built by filtering rather than by branching because the parts are
   * independently absent — a named agent carries no `agentType`, and an agent's
   * id prefix says nothing once it has a name (`achannel` from
   * `achannel-explorer-…`). A session's id stays, since it is the handle you
   * would resume with.
   */
  const qualifiers = (bar: LayoutBar): string[] => {
    const isSession = bar.kind === "session";
    return [
      bar.project,
      isSession ? "session" : (bar.agentType ?? bar.context),
      isSession || !named(bar) ? bar.id.slice(0, 8) : null,
    ].filter((p): p is string => !!p);
  };

  let svg!: SVGSVGElement;
  let ro: ResizeObserver | undefined;
  let raf = 0;

  onCleanup(() => {
    ro?.disconnect();
    if (raf) cancelAnimationFrame(raf);
  });

  // The observer's callback is async, so the width write lands outside the
  // owned scope this ref runs in — Solid 2.0 rejects a reactive write inside
  // one, which is the same trap store.ts's `load()` yields past.
  const measure = (el: HTMLDivElement): void => {
    ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(520, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
  };

  /** The unfiltered corpus extent, resolved once by the client's `prepare`. */
  const scale = createMemo(() => {
    const d = store.timelineDomain();
    const data = store.timeline();
    const t0 = d?.t0 ?? Math.min(...data.spans.map((s) => s.t0), Date.now());
    const t1 = d?.t1 ?? Math.max(...data.spans.map((s) => s.t1), Date.now() + 1);
    return timeScale([t0, t1], [GUTTER, Math.max(GUTTER + 100, width() - PAD_RIGHT)]);
  });

  const projects = createMemo(() => [...new Set(store.timeline().spans.map((s) => s.project))]);

  const layout = createMemo(() => {
    // `data` already carries the whole corpus plus `live`; the layout dims
    // rather than drops, so lanes hold still while a brush moves.
    const data = store.timeline();
    const collapsed = store.collapsedProjects();
    const expandedProjects = new Set(
      [...new Set(data.spans.map((s) => s.project))].filter((p) => !collapsed.has(p)),
    );
    return layoutTimeline(data, {
      scale: scale(),
      expandedProjects,
      expandedSessions: store.expandedSessions(),
    });
  });

  const ticks = createMemo(() => timeTicks(scale(), Math.max(4, Math.round(width() / 170))));

  /**
   * The brush rectangle, in pixels, derived from what is actually published
   * rather than from the drag. One source of truth, so an agent-driven brush
   * draws and a clear from anywhere erases.
   */
  const brushPx = createMemo(() => {
    const r = store.brushRange();
    if (!r) return null;
    const s = scale();
    return [s.toPx(r[0]), s.toPx(r[1])] as [number, number];
  });

  // --- pointer handling ------------------------------------------------------

  const localX = (e: PointerEvent): number => e.clientX - svg.getBoundingClientRect().left;
  const localY = (e: PointerEvent): number => e.clientY - svg.getBoundingClientRect().top;

  let anchor: number | null = null;
  let moved = false;

  /**
   * Pointer capture is best-effort: it throws `NotFoundError` whenever the id
   * is not an active pointer — a pointer released out of order, a synthetic
   * event from a script or a test. Losing capture degrades the drag; letting
   * the exception escape aborts the handler and loses the gesture entirely.
   */
  const capture = (pointerId: number, on: boolean): void => {
    try {
      if (on) svg.setPointerCapture(pointerId);
      else svg.releasePointerCapture(pointerId);
    } catch {
      /* not an active pointer — carry on without capture */
    }
  };

  const publishDrag = (range: [number, number]): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const s = scale();
      const [a, b] = range;
      brushTime([s.fromPx(Math.min(a, b)), s.fromPx(Math.max(a, b))]);
    });
  };

  const onPointerDown = (e: PointerEvent): void => {
    const x = localX(e);
    if (x < GUTTER) return;
    anchor = x;
    moved = false;
    capture(e.pointerId, true);
  };

  const onPointerMove = (e: PointerEvent): void => {
    const x = localX(e);
    const y = localY(e);
    if (anchor !== null) {
      if (Math.abs(x - anchor) > 3) moved = true;
      if (moved) publishDrag([anchor, x]);
      return;
    }
    const bar = hitTest(layout(), x, y, 2);
    setHover(bar ? { bar, x, y } : null);
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (anchor === null) return;
    const x = localX(e);
    const y = localY(e);
    const wasDrag = moved;
    anchor = null;
    moved = false;
    capture(e.pointerId, false);
    if (wasDrag) return; // the range is already published

    // A click, not a drag: open the session under the cursor, or — on empty
    // space — clear the selection. One gesture surface, no modal state.
    const bar = hitTest(layout(), x, y, 2);
    if (bar?.kind === "session") toggleSession(bar.id);
    else if (!bar) brushTime(null);
  };

  const stats = () => store.selectionStats();

  return (
    <section class="cco-panel cco-tl">
      <header class="cco-panel-head">
        <h2 class="cco-h2">session graph</h2>
        <div class="cco-tl-actions">
          <Show when={stats()}>
            {(s) => (
              <span class="cco-tl-stat">
                {s().sessions} sessions · {s().agents} agents · {s().turns.toLocaleString()} turns ·{" "}
                {usd(s().cost)}
              </span>
            )}
          </Show>
          <Show when={brushPx()}>
            <button type="button" class="cco-tl-btn" onClick={() => brushTime(null)}>
              clear brush
            </button>
          </Show>
          <button
            type="button"
            class="cco-tl-btn"
            onClick={() => setAllCollapsed(projects(), store.collapsedProjects().size === 0)}
          >
            {store.collapsedProjects().size === 0 ? "collapse all" : "expand all"}
          </button>
        </div>
      </header>
      <p class="cco-note">
        Horizontal is wall-clock time; each row is a lane, and a project needs a second lane only
        when two of its sessions actually overlapped. Hairlines under a session bar are the agents
        it launched — click a session to break them onto their own lanes, click a project name to
        fold it. Drag across the graph to brush a time range into the cross-filter; click empty
        space to clear it.
      </p>

      <div class="cco-tl-wrap" ref={measure}>
        {/* The fold controls are real HTML buttons laid over the SVG's left
            gutter rather than <text role="button">: SVG has no focusable
            interactive element, so an in-SVG control would be mouse-only and
            invisible to a screen reader. They scroll with the marks because
            they share the scrolled stage. */}
        <div class="cco-tl-stage">
          <svg
            ref={svg}
            class="cco-tl-svg"
            width={width()}
            height={layout().height + AXIS_H}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
          >
            <title>Claude Code sessions over time, by project and lane</title>

            {/* gridlines first: everything else sits on top of them */}
            <g>
              <For each={ticks()}>
                {(t) => (
                  <line
                    x1={t.x}
                    x2={t.x}
                    y1={0}
                    y2={layout().height}
                    stroke="var(--cco-rule)"
                    stroke-width={1}
                    opacity={t.major ? 0.7 : 0.4}
                  />
                )}
              </For>
            </g>

            {/* project bands — a faint stripe so lanes group visually */}
            <g>
              <For each={layout().groups}>
                {(g, i) => (
                  <>
                    <rect
                      x={GUTTER - 6}
                      y={g.y - 2}
                      width={Math.max(0, width() - GUTTER - PAD_RIGHT + 6)}
                      height={g.height + 2}
                      fill={i() % 2 === 0 ? "#ffffff" : "transparent"}
                      opacity={0.022}
                    />
                  </>
                )}
              </For>
            </g>

            {/* edges under the bars: they are relationships, not marks */}
            <g fill="none">
              {/* Two independent dash codes, and they must not be confused.
                  `1 3` (dotted) means cc-assay could not PROVE which session
                  was the copy — a claim about certainty. `4 3` (dashed) means
                  the two endpoints are far apart in time — a claim about the
                  data. A proven fork across a long gap is solid-but-faded;
                  only an unproven one is dotted. */}
              <For each={layout().edges}>
                {(e) => (
                  <path
                    d={e.path}
                    stroke={e.kind === "fork" ? "#c2872f" : "var(--cco-fg-dim)"}
                    stroke-width={e.kind === "fork" ? 1.4 : 1}
                    stroke-dasharray={
                      e.kind !== "fork"
                        ? undefined
                        : e.ambiguous
                          ? "1 3"
                          : e.long
                            ? "4 3"
                            : undefined
                    }
                    opacity={e.kind === "fork" ? (e.long ? 0.6 : 0.9) : 0.35}
                  />
                )}
              </For>
              {/* A marker at each departure point, so the branched moment stays
                  visible even when the curve is too long to trace. A copy left
                  the middle of the parent's life (diamond); a continuation left
                  its end (a bar, like a terminator). */}
              <For each={layout().edges.filter((e) => e.kind === "fork")}>
                {(e) => (
                  <path
                    d={
                      e.forkKind === "continuation"
                        ? `M${e.x1 - 0.8},${e.y1 - 3.4}L${e.x1 + 0.8},${e.y1 - 3.4}L${e.x1 + 0.8},${e.y1 + 3.4}L${e.x1 - 0.8},${e.y1 + 3.4}Z`
                        : `M${e.x1},${e.y1 - 3.2}L${e.x1 + 3.2},${e.y1}L${e.x1},${e.y1 + 3.2}L${e.x1 - 3.2},${e.y1}Z`
                    }
                    fill={e.ambiguous ? "none" : "#c2872f"}
                    stroke="#c2872f"
                    stroke-width={e.ambiguous ? 1 : 0}
                    opacity={0.9}
                  />
                )}
              </For>
            </g>

            <g>
              <For each={layout().bars}>
                {(b) => (
                  <rect
                    x={b.x}
                    y={b.y}
                    width={b.ghost ? Math.max(b.width, 3) : b.width}
                    height={b.height}
                    rx={b.kind === "session" && b.height > 4 ? 2 : 0.5}
                    fill={
                      b.ghost
                        ? "none"
                        : b.dim
                          ? // Excluded by the filter: still drawn, in neutral
                            // grey, so the selection reads against the shape it
                            // came from. Grey and not a faded cost colour —
                            // a dim blue would read as "cheap", which is a
                            // different claim than "not selected".
                            "#8b93a7"
                          : b.kind === "session"
                            ? costColor(b.cost)
                            : agentColor(b.context)
                    }
                    opacity={b.dim ? 0.22 : b.collapsed ? 0.62 : b.strip ? 0.75 : 1}
                    stroke={
                      hover()?.bar.id === b.id && hover()?.bar.rowIndex === b.rowIndex
                        ? "var(--cco-fg)"
                        : b.ghost
                          ? "#c2872f"
                          : "none"
                    }
                    stroke-width={1}
                    stroke-dasharray={b.ghost ? "2 2" : undefined}
                  />
                )}
              </For>
            </g>

            {/* the brush */}
            <Show when={brushPx()}>
              {(d) => (
                <g>
                  <rect
                    x={Math.min(d()[0], d()[1])}
                    y={0}
                    width={Math.abs(d()[1] - d()[0])}
                    height={layout().height}
                    fill="var(--cco-accent)"
                    opacity={0.14}
                  />
                  <For each={[Math.min(d()[0], d()[1]), Math.max(d()[0], d()[1])]}>
                    {(x) => (
                      <line
                        x1={x}
                        x2={x}
                        y1={0}
                        y2={layout().height}
                        stroke="var(--cco-accent)"
                        stroke-width={1}
                      />
                    )}
                  </For>
                </g>
              )}
            </Show>

            {/* axis last, along the bottom */}
            <g>
              <line
                x1={GUTTER}
                x2={width() - PAD_RIGHT}
                y1={layout().height + 0.5}
                y2={layout().height + 0.5}
                stroke="var(--cco-rule)"
              />
              <For each={ticks()}>
                {(t) => (
                  <text class="cco-tl-tick" x={t.x} y={layout().height + 14} text-anchor="middle">
                    {t.label}
                  </text>
                )}
              </For>
            </g>
          </svg>

          <For each={layout().groups}>
            {(g) => (
              <button
                type="button"
                class="cco-tl-fold"
                style={{ top: `${g.y + g.height / 2 - 9}px`, width: `${GUTTER - 12}px` }}
                aria-expanded={g.collapsed ? "false" : "true"}
                onClick={() => toggleProject(g.project)}
              >
                <span class="cco-tl-caret">{g.collapsed ? "▸" : "▾"}</span>
                <span class="cco-tl-proj">{g.project}</span>
                <span class="cco-tl-count">{g.nSessions}</span>
              </button>
            )}
          </For>

          <Show when={hover()}>
            {(h) => (
              <div
                class="cco-tl-tip"
                style={{
                  // 300 ≈ the widest the tip gets once a 34ch name is in it;
                  // clamping to a narrower guess pushed long titles off-screen.
                  left: `${Math.max(0, Math.min(h().x + 14, width() - 300))}px`,
                  top: `${h().y + 16}px`,
                }}
              >
                {/* The name leads, because it is the thing the user recognises;
                    the project and id stay as the qualifiers beneath it. An
                    unnamed session falls back to the project, which is what the
                    head showed before names existed. */}
                <div class="cco-tl-tip-head">
                  {named(h().bar)?.name ??
                    (h().bar.kind === "session" ? h().bar.project : (h().bar.agentType ?? "agent"))}
                </div>
                <Show when={named(h().bar)?.was}>
                  {(was) => (
                    /* A rename is worth surfacing rather than silently adopting:
                       anything written down before it still uses the old name. */
                    <div class="cco-tl-tip-row cco-tl-tip-was">was “{was()}”</div>
                  )}
                </Show>
                <div class="cco-tl-tip-row">{qualifiers(h().bar).join(" · ")}</div>
                <div class="cco-tl-tip-row">
                  {/* A ghost has t1 === t0 (no billed turn to end at), so an
                      arrow would read as a span from a time to itself — i.e.
                      as work that took no time, rather than work that never
                      happened. Show the fork instant alone. */}
                  {h().bar.ghost ? when(h().bar.t0) : `${when(h().bar.t0)} → ${when(h().bar.t1)}`}
                </div>
                <div class="cco-tl-tip-row">
                  {h().bar.ghost
                    ? "fork taken, never continued — no billed turns"
                    : `${dur(h().bar.t1 - h().bar.t0)} · ${h().bar.nTurns} turns · ${usd(h().bar.cost)}`}
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>

      <div class="cco-tl-legend">
        <span class="cco-tl-legend-group">
          <span class="cco-tl-legend-label">session cost</span>
          <For each={COST_RAMP}>
            {(c, i) => (
              <span class="cco-tl-swatch" style={{ background: c }} title={`step ${i() + 1}`} />
            )}
          </For>
          <span class="cco-tl-legend-scale">
            &lt;$1 &nbsp;·&nbsp; $1 &nbsp;·&nbsp; $10 &nbsp;·&nbsp; $50 &nbsp;·&nbsp; $200+
          </span>
        </span>
        <span class="cco-tl-legend-group">
          <span class="cco-tl-swatch" style={{ background: AGENT_COLOR.subagent }} />
          <span class="cco-tl-legend-label">subagent</span>
          <span class="cco-tl-swatch" style={{ background: AGENT_COLOR["workflow-agent"] }} />
          <span class="cco-tl-legend-label">workflow agent</span>
          <span class="cco-tl-fork-key" />
          <span class="cco-tl-legend-label">fork</span>
          <span class="cco-tl-fork-key cco-tl-fork-amb" />
          <span class="cco-tl-legend-label">unproven direction</span>
          <span class="cco-tl-ghost-key" />
          <span class="cco-tl-legend-label">fork with no turns</span>
        </span>
      </div>
    </section>
  );
}
