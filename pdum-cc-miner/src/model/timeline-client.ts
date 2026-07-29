/**
 * timeline-client.ts — the session graph as a first-class Mosaic client.
 *
 * This is the seam where the timeline meets the crossfilter. It is a real
 * `MosaicClient`, not a chart that happens to read a signal, and it plays both
 * roles a crossfilter participant can play:
 *
 *  - **Consumer.** `filterBy` is the shared `Selection`; the coordinator calls
 *    `query(predicate)` whenever anyone's clause changes and hands the rows to
 *    `queryResult`, which pushes them into a durable Solid signal. From there
 *    it is pure Solid — layout (timeline.ts) and SVG.
 *  - **Producer.** Brushing the time axis calls `publish`, which puts a
 *    `clauseInterval` into the same Selection. Every other client re-queries.
 *
 * Why a custom client rather than stock vgplot marks: the vertical position of
 * every mark is a *lane*, and lanes are computed by packing the result set that
 * comes back — they are a property of the query result, not a column in it. A
 * mark's `y` channel can only name a column or a constant, so a stock mark
 * would need the lane materialised in SQL (an interval-graph coloring, i.e. a
 * recursive CTE re-run on every brush) and would still have nowhere to put the
 * fork beziers, whose endpoints are two different rows' lanes. `queryResult` is
 * the hook that exists precisely for "I will do my own rendering", so that is
 * the one we use.
 *
 * One query, three row kinds, one round trip — `kind` discriminates sessions,
 * agents, and fork edges. Expanding or collapsing anything is pure layout and
 * never comes back here.
 */
import { clauseInterval, MosaicClient, type Selection } from "@uwdata/mosaic-core";
import { count, Query, sql, sum } from "@uwdata/mosaic-sql";
import type { ForkEdgeInput, TimelineSpan } from "./timeline";

/**
 * What something is called, and what it used to be called.
 *
 * `was` is present only when the name actually changed, so a tooltip can say
 * so without carrying a redundant field on every row.
 */
export interface TimelineName {
  name: string;
  /** `explicit` | `ai` | `slug` | `id` for a session; `named` | `fork` for an agent. */
  kind: string;
  /** The first name this thing had, when it later changed. */
  was?: string;
}

/** What one query delivers: everything the layout needs, already parsed. */
export interface TimelineData {
  /** ALWAYS the whole corpus, so lanes do not reflow when a brush moves. */
  spans: TimelineSpan[];
  forks: ForkEdgeInput[];
  /** sessionId → name, and agentId → name. Static across brushes. */
  names: Map<string, TimelineName>;
  /** Ids surviving the crossfilter; undefined when nothing is filtered. */
  live?: Set<string>;
}

/** The unfiltered extent of the corpus, resolved once in `prepare`. */
export interface TimelineDomain {
  t0: number;
  t1: number;
}

/** Arrow/flechette table or plain array — the same shape seismos handles. */
function rows(data: unknown): Array<Record<string, unknown>> {
  const t = data as { toArray?: () => Array<Record<string, unknown>> };
  if (typeof t?.toArray === "function") return t.toArray();
  return Array.from((data ?? []) as Iterable<Record<string, unknown>>);
}

/** DuckDB hands INT64 back as BigInt, which poisons every later `new Date`. */
const n = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
const s = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * The union arm shapes must line up positionally, and an untyped `NULL` in one
 * arm makes DuckDB guess. Naming the type once keeps the three arms compatible.
 */
const NULL_TEXT = sql`NULL::VARCHAR`;

export interface TimelineClientOptions {
  /** The crossfilter this client both reads and publishes into. */
  filterBy: Selection;
  onResult: (data: TimelineData) => void;
  onPending?: () => void;
  onError?: (error: Error) => void;
  onDomain?: (domain: TimelineDomain) => void;
  /**
   * Whether cc-assay's `forkEdges` grain is loaded. False in an older dataset,
   * where the client falls back to deriving edges from the turns table.
   */
  hasForkEdges?: boolean;
}

export class SessionTimelineClient extends MosaicClient {
  private readonly opts: TimelineClientOptions;
  /** The last range published, so the view can render its own brush. */
  private range: [number, number] | null = null;
  /** Resolved once in `prepare` from the `forkEdges` grain; see `loadForkEdges`. */
  private forks: ForkEdgeInput[] = [];
  /** Zero-turn fork nodes, also resolved once; see `loadGhostSessions`. */
  private ghosts: TimelineSpan[] = [];
  /**
   * Every span in the corpus, resolved once — the layout's stable input.
   *
   * The filtered query then only says which of these are *live*. Drawing the
   * full set and dimming the rest is the crossfilter idiom the other charts
   * use, and it additionally stops the chart reflowing under a drag: lanes are
   * packed from a set that never changes.
   */
  private allSpans: TimelineSpan[] = [];
  /** sessionId → name and agentId → name, resolved once; see `loadNames`. */
  private readonly names = new Map<string, TimelineName>();
  private readonly agentNames = new Map<string, TimelineName>();

  constructor(opts: TimelineClientOptions) {
    super(opts.filterBy);
    this.opts = opts;
  }

  /**
   * Never `true` here, and not merely as a precaution.
   *
   * `filterStable` promises the coordinator that changing the filter does not
   * change the client's groupby domain — which is exactly what this client's
   * filter *does*: the group keys ARE the surviving sessions and agents, so a
   * narrower brush returns a different (smaller) set of rows, and lanes repack
   * around it. Claiming stability would let the pre-aggregation index serve a
   * fixed set of groups and the timeline would stop losing and gaining tracks.
   * (seismos hit the milder version of this: its histogram kept a fixed
   * magnitude domain and the index silently dropped point clauses. See
   * demos/seismos/src/NOTES.md, finding 1.)
   */
  get filterStable(): boolean {
    return false;
  }

  /**
   * Resolve the corpus's full time extent *before* the first filtered query.
   *
   * The x scale must be the unfiltered domain: it is the axis the user brushes
   * on, and rescaling it to the brush would make every drag chase its own
   * tail. `prepare` is the lifecycle slot for exactly this — one metadata query
   * the coordinator awaits before it starts calling `query`. (In Mosaic 0.28
   * `prepare` replaced the older `fields`/`fieldInfo` pair; there is no
   * `fieldInfo` hook to hang this on any more.)
   */
  async prepare(): Promise<void> {
    if (this.opts.hasForkEdges) await this.loadForkEdges();
    await this.loadGhostSessions();
    await this.loadNames();
    await this.loadAllSpans();
    if (!this.opts.onDomain) return;
    const q = Query.from("turns").select({
      t0: sql`epoch_ms(min(ts))`,
      t1: sql`epoch_ms(max(ts))`,
    });
    const result = rows(await this.coordinator?.query(q))[0];
    if (result) this.opts.onDomain({ t0: n(result.t0), t1: n(result.t1) });
  }

  /**
   * What each session and agent is called, read once from the grains.
   *
   * Names belong in `prepare` and not in the filtered query for the same reason
   * the fork edges do: a brush cannot change what something is called, and the
   * filtered query aggregates `turns`, which carries no name column. Two small
   * lookups (109 sessions, 368 agents here) beat widening every grouped query.
   *
   * `nameFirst` rides along so the tooltip can show a rename rather than
   * silently adopting the new label — the old one is what any note written
   * before the rename refers to.
   */
  private async loadNames(): Promise<void> {
    const put = async (
      table: string,
      idCol: string,
      into: Map<string, TimelineName>,
      extra: Record<string, string> = {},
    ) => {
      const q = Query.from(table).select({ id: idCol, name: "name", ...extra });
      for (const row of rows(await this.coordinator?.query(q))) {
        const id = s(row.id);
        const name = s(row.name);
        if (!id || !name) continue;
        const first = s(row.nameFirst);
        into.set(id, {
          name,
          kind: s(row.nameKind) ?? "",
          ...(first && first !== name ? { was: first } : {}),
        });
      }
    };
    try {
      await put("sessions", "sessionId", this.names, {
        nameKind: "nameKind",
        nameFirst: "nameFirst",
      });
      await put("agentRuns", "agentId", this.agentNames, { nameKind: "nameKind" });
    } catch {
      /* a dataset predating the name columns simply has no names to show */
    }
  }

  /**
   * The unfiltered span set: the same three arms `query()` builds, with no
   * predicate. Resolved once, because the corpus does not change under a brush.
   */
  private async loadAllSpans(): Promise<void> {
    try {
      const rows0 = rows(await this.coordinator?.query(this.query([])));
      const out: TimelineSpan[] = [];
      for (const row of rows0) {
        const kind = String(row.kind);
        const id = s(row.id);
        if (!id || kind === "fork") continue;
        out.push({
          kind: kind === "agent" ? "agent" : "session",
          id,
          project: s(row.project) ?? "(unknown)",
          parentId: s(row.parentId),
          t0: n(row.t0),
          t1: n(row.t1),
          nTurns: n(row.nTurns),
          cost: n(row.cost),
          agentType: s(row.agentType),
          context: s(row.context) ?? "main",
        });
      }
      this.allSpans = out;
    } catch (e) {
      // Without this the chart still works, it just loses the dimmed context.
      this.opts.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Fork lineage, read once from cc-assay's `forkEdges` grain.
   *
   * Fetched in `prepare` and held, rather than joined into the per-brush query,
   * for two reasons. It is tiny and static — ten rows for this corpus, and no
   * brush can change them. And `forkEdges` is keyed by `childSessionId` /
   * `parentSessionId`, neither of which is named `sessionId`, so a crossfilter
   * predicate written against `turns` columns cannot be applied to it without a
   * hand-written key translation. Filtering the edges is unnecessary anyway:
   * `layoutTimeline` already drops any edge whose endpoints are not both on
   * screen, which is the same answer and needs no SQL.
   *
   * Two shape hazards in the grain, both handled here rather than downstream:
   * the `*Ts` columns are TIMESTAMP, not epoch milliseconds, so they go through
   * `epoch_ms()` in SQL rather than arriving as a `{micros}` object the layout
   * would silently render at x=NaN; and they are nullable — the writer maps 0
   * to NULL — so a missing fork point falls back to the child's first native
   * record, and an edge with neither is dropped.
   */
  private async loadForkEdges(): Promise<void> {
    const q = Query.from("forkEdges").select({
      childId: "childSessionId",
      parentId: "parentSessionId",
      forkTs: sql`coalesce(epoch_ms(forkPointTs), epoch_ms(childFirstNativeTs))`,
      kind: "kind",
      ambiguous: "ambiguous",
      parentMissing: "parentMissing",
    });
    try {
      for (const row of rows(await this.coordinator?.query(q))) {
        const childId = s(row.childId);
        const parentId = s(row.parentId);
        const forkTs = row.forkTs == null ? null : n(row.forkTs);
        // A named-but-absent parent has nothing to draw from.
        if (!childId || !parentId || forkTs === null || row.parentMissing === true) continue;
        this.forks.push({
          childId,
          parentId,
          forkTs,
          kind: s(row.kind) === "continuation" ? "continuation" : "copy",
          ambiguous: row.ambiguous === true,
        });
      }
    } catch (e) {
      // An older dataset without the grain must degrade to no edges, not to a
      // blank timeline — the sessions themselves are the point.
      this.opts.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * The session files that produced no billed turn AND have a parent — forks
   * taken and never continued.
   *
   * `parentSessionId IS NOT NULL` is the load-bearing half of that predicate.
   * Five session files in this corpus billed nothing, but only ONE is a fork;
   * the other four are parentless false starts — sessions that opened, ran for
   * two seconds to three minutes, and never billed a turn. Drawing those on a
   * *fork* graph labels them as something they are not, and one of them
   * manufactures an entire project row for a ten-second false start. They are
   * real data and worth a view; this is not that view.
   *
   * They cannot come from the main query, which aggregates `turns`: a session
   * with no turns has no rows there to aggregate. Without them the fork forest
   * breaks in the middle — in this corpus one such file sits between a parent
   * and its two children, so three of ten edges had nowhere to attach.
   *
   * Read from `sessions` in `prepare`, and **deliberately not filtered**. That
   * is the honest position rather than a shortcut: an activity filter has
   * nothing to say about a session with zero activity, so there is no predicate
   * that would legitimately remove one. They are drawn hollow (`ghost`) so they
   * can never be read as work that happened.
   *
   * Times use cc-assay's own recipe. `firstTs`/`lastTs` now strictly mean
   * "first/last billed turn" and are NULL on exactly these rows — they used to
   * be epoch zero, which planted marks in 1970 — so the fallback chain runs
   * through `firstNativeTs` and the file's birthtime.
   */
  private async loadGhostSessions(): Promise<void> {
    const startTs = sql`coalesce(firstNativeTs, firstTs, createdTs)`;
    const q = Query.from("sessions")
      .select({
        id: "sessionId",
        project: "project",
        t0: sql`epoch_ms(${startTs})`,
        t1: sql`epoch_ms(greatest(coalesce(lastNativeTs, lastTs, ${startTs}), ${startTs}))`,
      })
      .where(
        sql`coalesce(nTurnsNative, 0) = 0 AND parentSessionId IS NOT NULL AND ${startTs} IS NOT NULL`,
      );
    try {
      for (const row of rows(await this.coordinator?.query(q))) {
        const id = s(row.id);
        if (!id || row.t0 == null) continue;
        this.ghosts.push({
          kind: "session",
          id,
          project: s(row.project) ?? "(unknown)",
          parentId: null,
          t0: n(row.t0),
          t1: row.t1 == null ? n(row.t0) : n(row.t1),
          nTurns: 0,
          cost: 0,
          agentType: null,
          context: "main",
          ghost: true,
        });
      }
    } catch {
      /* older dataset without the lineage columns — no ghosts, edges just drop */
    }
  }

  /**
   * Sessions, agents and fork edges in one pass over the filtered turns.
   *
   * Everything aggregates from `turns` rather than the pre-rolled `sessions`
   * table, and that is a crossfilter requirement, not a preference: a clause
   * published by any other view is a predicate over *turn* columns
   * (`ts`, `project`, `model`, `agentType`, …). Applied to `sessions`, whose
   * columns are `firstTs`/`lastTs`, most of them would not resolve at all. One
   * filtered CTE, three arms off it, and every clause anyone can raise lands
   * somewhere it makes sense.
   */
  query(filter: Parameters<MosaicClient["query"]>[0] = []) {
    const t = Query.from("turns")
      .select("*")
      .where(filter ?? []);

    const sessions = Query.from("t")
      .select({
        kind: sql`'session'`,
        id: "sessionId",
        project: sql`any_value(project)`,
        parentId: NULL_TEXT,
        t0: sql`epoch_ms(min(ts))`,
        t1: sql`epoch_ms(max(ts))`,
        nTurns: count(),
        cost: sum("costTotal"),
        agentType: NULL_TEXT,
        context: sql`'main'`,
      })
      .groupby("sessionId");

    // An agent's span is its own turns; its parent is the session that paid for
    // them. This is what makes subagent and workflow launches visible without
    // any lineage table — `agentId` is already the per-instance identity.
    const agents = Query.from("t")
      .select({
        kind: sql`'agent'`,
        id: "agentId",
        project: sql`any_value(project)`,
        parentId: sql`any_value(sessionId)`,
        t0: sql`epoch_ms(min(ts))`,
        t1: sql`epoch_ms(max(ts))`,
        nTurns: count(),
        cost: sum("costTotal"),
        agentType: sql`any_value(agentType)`,
        context: sql`any_value(context)`,
      })
      .where(sql`context <> 'main' AND agentId IS NOT NULL`)
      .groupby("agentId");

    if (this.opts.hasForkEdges) return Query.unionAll(sessions, agents).with({ t });

    // Fallback for a dataset predating cc-assay's `forkEdges` grain: infer the
    // edge from a turn whose containing file is not its origin session, which
    // means a fork copied it there. Unsound, and knowingly so — dedup keeps ONE
    // copy of each billed turn and which file wins is arbitrary, so when the
    // parent's copy survives the fork leaves no trace at all. It recovers 3 of
    // this corpus's 10 real edges. `loadForkEdges` is the correct path.
    const forks = Query.from("t")
      .select({
        kind: sql`'fork'`,
        id: "fileSessionId",
        project: sql`any_value(project)`,
        parentId: "sessionId",
        t0: sql`epoch_ms(max(ts))`,
        t1: sql`epoch_ms(max(ts))`,
        nTurns: count(),
        cost: sql`0.0`,
        agentType: NULL_TEXT,
        context: sql`'fork'`,
      })
      .where(sql`fileSessionId IS NOT NULL AND fileSessionId <> sessionId`)
      .groupby("fileSessionId", "sessionId");

    return Query.unionAll(sessions, agents, forks).with({ t });
  }

  queryPending(): this {
    this.opts.onPending?.();
    return this;
  }

  queryError(error: Error): this {
    this.opts.onError?.(error);
    return this;
  }

  /**
   * Split the row kinds apart and hand the layout its inputs.
   *
   * The fork edges come from `prepare` (real lineage) and are re-emitted with
   * every result; only the fallback path finds them in the rows. Either way the
   * layout drops the ones whose endpoints did not survive the filter, so the
   * edge set narrows with the brush without the edges themselves being queried.
   */
  queryResult(data: unknown): this {
    const live = new Set<string>();
    const spans: TimelineSpan[] = [...this.ghosts];
    const forks: ForkEdgeInput[] = [...this.forks];
    for (const row of rows(data)) {
      const kind = String(row.kind);
      const id = s(row.id);
      if (!id) continue;
      if (kind === "fork") {
        const parentId = s(row.parentId);
        if (parentId && parentId !== id) {
          forks.push({ childId: id, parentId, forkTs: n(row.t0) });
        }
        continue;
      }
      live.add(id);
      spans.push({
        kind: kind === "agent" ? "agent" : "session",
        id,
        project: s(row.project) ?? "(unknown)",
        parentId: s(row.parentId),
        t0: n(row.t0),
        t1: n(row.t1),
        nTurns: n(row.nTurns),
        cost: n(row.cost),
        agentType: s(row.agentType),
        context: s(row.context) ?? "main",
      });
    }
    // One lookup for both kinds: ids are disjoint (a session id is a uuid, an
    // agent id starts with `a`), and the view holds a bar without knowing which
    // map it came from.
    const names = new Map([...this.names, ...this.agentNames]);
    // Hand the layout the WHOLE corpus plus the live set, so lanes stay put and
    // the excluded bars are drawn faint rather than removed. Zero-turn ghosts
    // are always live — they have no activity for an activity filter to act on
    // (see `loadGhostSessions`), so dimming them would assert something false.
    const all = this.allSpans.length ? [...this.ghosts, ...this.allSpans] : spans;
    for (const g of this.ghosts) live.add(g.id);
    this.opts.onResult({
      spans: all,
      forks,
      names,
      ...(this.allSpans.length ? { live } : {}),
    });
    return this;
  }

  /** The range this client currently has published, if any. */
  get published(): [number, number] | null {
    return this.range;
  }

  /**
   * Publish a brushed time range into the crossfilter — or `null` to clear it.
   *
   * `clients: new Set()` — EMPTY, and explicitly so. Omitting the option does
   * not mean "no clients": `clauseInterval` defaults it to `new Set([source])`
   * whenever the source is a MosaicClient, which is exactly the self-exclusion
   * being removed here. Only an empty set actually opts out.
   *
   * Why opt out at all: excluding itself used to keep the graph from deleting
   * the very tracks being brushed over. That danger is gone — the layout is fed
   * the whole corpus and marks excluded spans `dim` (see `loadAllSpans`), so
   * our own clause now narrows the *highlight* rather than the chart. Keeping
   * the exclusion would mean the one chart you are dragging on is the one chart
   * that never responds.
   *
   * The field is `epoch_ms(ts)` rather than `ts` because the value is a number:
   * comparing a TIMESTAMP column against epoch-millisecond literals is a cast
   * away from either an error or a silent misread, and every other client here
   * already thinks in epoch ms.
   */
  publish(range: [number, number] | null): void {
    this.range = range;
    this.filterBy?.update(
      clauseInterval(sql`epoch_ms(ts)`, range, { source: this, clients: new Set() }),
    );
  }
}

/** What the selection currently covers. */
export interface SelectionStats {
  turns: number;
  sessions: number;
  agents: number;
  cost: number;
}

/**
 * The timeline's counterpart: a second client that reports what the selection
 * covers.
 *
 * Its job is partly to be useful and partly to be *evidence*. It raises no
 * clause of its own, so in a crossfilter it sees every clause including the
 * timeline's — which makes it the readout that proves the brush propagates
 * through the coordinator rather than through a local callback. If these
 * numbers move when the timeline is dragged, the client contract is wired.
 */
export class SelectionStatsClient extends MosaicClient {
  private readonly onResult: (stats: SelectionStats) => void;

  constructor(filterBy: Selection, onResult: (stats: SelectionStats) => void) {
    super(filterBy);
    this.onResult = onResult;
  }

  /** Same reasoning as the timeline's: one scalar row, no stable group domain. */
  get filterStable(): boolean {
    return false;
  }

  query(filter: Parameters<MosaicClient["query"]>[0] = []) {
    return Query.from("turns")
      .select({
        turns: count(),
        sessions: sql`count(DISTINCT sessionId)`,
        agents: sql`count(DISTINCT agentId)`,
        cost: sum("costTotal"),
      })
      .where(filter ?? []);
  }

  queryResult(data: unknown): this {
    const row = rows(data)[0];
    this.onResult({
      turns: n(row?.turns),
      sessions: n(row?.sessions),
      agents: n(row?.agents),
      cost: n(row?.cost),
    });
    return this;
  }
}
