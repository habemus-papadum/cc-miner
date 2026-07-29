/**
 * graph.ts — the cell graph (playbook layer 2): every dataflow in the app,
 * notebook-style, plus the agent tool surface. Cells wrap the pure functions
 * of layer 1 with reality — time, failure, cancellation, streaming.
 *
 * This module is *disposable logic*. `hotCellGraph` builds the graph from the
 * durable roots in store.ts and, on a hot edit, disposes the old graph and
 * swaps in a new one — the sliders keep their positions and every cell
 * recomputes from the roots. Components read `graph().someCell` through the
 * stable accessor it returns, so they can never hold a stale cell reference.
 *
 * Add your cells inside the builder — `cell(deps, compute)` handles aborts,
 * progress, and streaming — and test them headless with
 * @habemus-papadum/aiui-viz/testing (one `whenReady` probe per input).
 */
import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { projectScale } from "./palette";
import type { ReplayRow } from "./replay";
import type { DetailCompaction, DetailTurn } from "./session-detail";
import { appScope, brushTime, focusSession, idleGapMinutes, setAllCollapsed, store } from "./store";

/** One row of the "where did the money go" breakdown. */
export interface CostSlice {
  key: string;
  cost: number;
  turns: number;
}

/** Everything the drill-down draws for one session. */
export interface SessionDetailData {
  sessionId: string;
  name: string;
  nameWas: string | null;
  project: string;
  turns: DetailTurn[];
  compactions: DetailCompaction[];
}

/** One session's replay, or the fact that this dataset has none. */
export interface ReplayData {
  sessionId: string;
  /** False when the dataset was built without `--replay`. */
  available: boolean;
  rows: ReplayRow[];
}

/** A session as the timeline view needs it: wall-clock vs work. */
export interface SessionShape {
  sessionId: string;
  project: string;
  /** The resolved display name; see cc-assay's `resolveSessionName`. */
  name: string | null;
  /** The name this session started with, when it was later renamed. */
  nameWas: string | null;
  firstTs: number;
  lastTs: number;
  spanSeconds: number;
  activeSeconds: number;
  dutyCycle: number;
  nTurns: number;
  nCompactions: number;
  peakContextTokens: number;
  cost: number;
}

// --- the graph: rebuilt over the durable roots on every hot edit --------------

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph(
  appScope.name,
  () => ({
    /**
     * The loading cell. It exists so the load is driven by the GRAPH, not by a
     * component: `ensureLoaded` writes its first progress signal synchronously,
     * and Solid 2.0 rejects a reactive write inside an owned scope
     * (REACTIVE_WRITE_IN_OWNED_SCOPE) — which is exactly what calling it from
     * a component body does. Same reason seismos drives its catalog from a cell.
     */
    dataset: cell(
      () => ({}),
      async () => {
        await store.ensureLoaded();
        return store.summary();
      },
      { scope: appScope },
    ),

    /**
     * Spend per day per project — the entry-point series. Kept as a cell rather
     * than a Mosaic client because the summary strip and the agent tools read
     * the same numbers, and one SQL round-trip is cheaper than three.
     */
    dailyCost: cell(
      // Keyed on the crossfilter's version, not on any one brush: `filterSql`
      // composes every clause, so this recomputes for the timeline's time
      // range and the scatter's cost range alike.
      () => ({ v: store.filterVersion() }),
      async () =>
        store.sql<{ day: number; project: string; cost: number; turns: number }>(`
          SELECT epoch_ms(date_trunc('day', ts)) AS day,
                 project,
                 sum(costTotal)                  AS cost,
                 count(*)                        AS turns
          FROM turns
          WHERE ${store.filterSql()}
          GROUP BY 1, 2
          ORDER BY 1
        `),
      { scope: appScope },
    ),

    /**
     * Spend per day for the WHOLE corpus, never filtered.
     *
     * The context layer behind `dailyCost`. Same crossfilter idiom the scatter
     * uses: a selection is only readable against the shape it came from, and
     * bars that vanish leave nothing to judge the survivors against.
     */
    dailyTotals: cell(
      () => ({}),
      async () =>
        store.sql<{ day: number; cost: number }>(`
          SELECT epoch_ms(date_trunc('day', ts)) AS day, sum(costTotal) AS cost
          FROM turns GROUP BY 1 ORDER BY 1
        `),
      { scope: appScope },
    ),

    /** Unfiltered attribution totals — the ghost behind each bar. */
    attributionTotals: cell(
      () => ({}),
      async () =>
        store.sql<{ kind: string; key: string; cost: number }>(`
          SELECT 'agent' AS kind, coalesce(agentType, '(main loop)') AS key, sum(costTotal) AS cost
          FROM turns GROUP BY 1, 2
          UNION ALL
          SELECT 'skill', coalesce(attributionSkill, '(none)'), sum(costTotal) FROM turns GROUP BY 1, 2
          UNION ALL
          SELECT 'mcp', coalesce(attributionMcpServer, '(none)'), sum(costTotal) FROM turns GROUP BY 1, 2
        `),
      { scope: appScope },
    ),

    /**
     * The headline finding, per project: what fraction of spend is context
     * re-transmission rather than generation. Cache reads dominate, and this is
     * the cell that makes that visible.
     */
    tokenClasses: cell(
      () => ({ v: store.filterVersion() }),
      async () =>
        store.sql<
          CostSlice & { cacheRead: number; cacheCreate: number; output: number; input: number }
        >(`
          SELECT project                AS key,
                 sum(costTotal)         AS cost,
                 count(*)               AS turns,
                 sum(costCacheRead)     AS cacheRead,
                 sum(costCacheCreate)   AS cacheCreate,
                 sum(costOutput)        AS output,
                 sum(costInput)         AS input
          FROM turns
          WHERE ${store.filterSql()}
          GROUP BY 1
          ORDER BY cost DESC
        `),
      { scope: appScope },
    ),

    /**
     * Cost by what *caused* it — skill, MCP server, agent type. The efficiency
     * axis: these columns are sparse, so the null bucket is a real category and
     * is labelled rather than dropped.
     */
    attribution: cell(
      () => ({ v: store.filterVersion() }),
      async () =>
        store.sql<CostSlice & { kind: string }>(`
          WITH t AS (SELECT * FROM turns WHERE ${store.filterSql()})
          SELECT 'agent'      AS kind, coalesce(agentType, '(main loop)') AS key,
                 sum(costTotal) AS cost, count(*) AS turns
          FROM t GROUP BY 1, 2
          UNION ALL
          SELECT 'skill', coalesce(attributionSkill, '(none)'),
                 sum(costTotal), count(*)
          FROM t GROUP BY 1, 2
          UNION ALL
          SELECT 'mcp', coalesce(attributionMcpServer, '(none)'),
                 sum(costTotal), count(*)
          FROM t GROUP BY 1, 2
          ORDER BY kind, cost DESC
        `),
      { scope: appScope },
    ),

    /**
     * Sessions recomputed against the reader's idle threshold.
     *
     * The parquet already carries an activeSeconds computed at normalize time,
     * but it was computed with ONE threshold. Recomputing here from raw turn
     * timestamps is what makes `idleGapMinutes` a live control instead of a
     * decoration — the whole point of exposing it.
     */
    sessions: cell(
      () => ({ gapMin: idleGapMinutes.get(), v: store.filterVersion() }),
      async ({ gapMin }) => {
        const gapMs = Math.max(1, gapMin) * 60_000;
        return store
          .sql<SessionShape>(`
          WITH gaps AS (
            SELECT sessionId,
                   epoch_ms(ts) AS t,
                   epoch_ms(ts) - lag(epoch_ms(ts)) OVER (PARTITION BY sessionId ORDER BY ts) AS dt,
                   costTotal,
                   cacheReadTokens
            FROM turns
            WHERE ${store.filterSql()}
          )
          SELECT g.sessionId,
                 any_value(s.project)                              AS project,
                 any_value(s.name)                                 AS name,
                 any_value(CASE WHEN s.nameChanged THEN s.nameFirst END) AS nameWas,
                 min(g.t)                                          AS firstTs,
                 max(g.t)                                          AS lastTs,
                 (max(g.t) - min(g.t)) / 1000.0                    AS spanSeconds,
                 coalesce(sum(CASE WHEN g.dt > 0 AND g.dt < ${gapMs} THEN g.dt END), 0) / 1000.0
                                                                   AS activeSeconds,
                 count(*)                                          AS nTurns,
                 any_value(s.nCompactions)                         AS nCompactions,
                 max(g.cacheReadTokens)                            AS peakContextTokens,
                 sum(g.costTotal)                                  AS cost
          FROM gaps g
          LEFT JOIN sessions s USING (sessionId)
          GROUP BY g.sessionId
          HAVING count(*) > 1
          ORDER BY cost DESC
        `)
          .then((rows) =>
            rows.map((r) => ({
              ...r,
              dutyCycle: r.spanSeconds > 0 ? r.activeSeconds / r.spanSeconds : 1,
            })),
          );
      },
      { scope: appScope },
    ),

    /**
     * The headline numbers under the current filter.
     *
     * The scatter's caption promises a brush filters "every panel above", and
     * the summary strip is above it — so it has to follow, or the promise is
     * false and the biggest numbers on the page are the stale ones.
     *
     * The unfiltered totals stay reachable through `store.summary()`, which is
     * what the "of N" denominators read.
     */
    liveSummary: cell(
      () => ({ v: store.filterVersion() }),
      async () => {
        const [row] = await store.sql<{
          turns: number;
          sessions: number;
          projects: number;
          firstTs: number;
          lastTs: number;
          totalCost: number;
          costInput: number;
          costOutput: number;
          costCacheCreate: number;
          costCacheRead: number;
        }>(`
          SELECT count(*)                       AS turns,
                 count(DISTINCT sessionId)      AS sessions,
                 count(DISTINCT project)        AS projects,
                 epoch_ms(min(ts))              AS firstTs,
                 epoch_ms(max(ts))              AS lastTs,
                 sum(costTotal)                 AS totalCost,
                 sum(costInput)                 AS costInput,
                 sum(costOutput)                AS costOutput,
                 sum(costCacheCreate)           AS costCacheCreate,
                 sum(costCacheRead)             AS costCacheRead
          FROM turns WHERE ${store.filterSql()}
        `);
        return row ?? null;
      },
      { scope: appScope },
    ),

    /**
     * Every project in the corpus, with its total, and the colour scale the
     * project-coloured charts share.
     *
     * Unfiltered on purpose — this IS the filter's own vocabulary. Deriving it
     * from filtered data would delete a chip the moment you deselected it,
     * leaving no way back.
     */
    projects: cell(
      () => ({}),
      async () => {
        const rows = await store.sql<{ project: string; cost: number; turns: number }>(`
          SELECT project, sum(costTotal) AS cost, count(*) AS turns
          FROM turns GROUP BY 1 ORDER BY cost DESC
        `);
        const names = rows.map((r) => r.project);
        return { rows, scale: projectScale(names) };
      },
      { scope: appScope },
    ),

    /**
     * The two numbers the scatter's caption needs, counted rather than
     * hardcoded so they cannot go stale against a regenerated dataset.
     *
     * Unfiltered on purpose: the caption describes the CHART's scale, and a
     * brush must not rewrite the sentence explaining what the axis means.
     */
    scatterMeta: cell(
      () => ({}),
      async () => {
        const [row] = await store.sql<{ turns: number; zeroCost: number }>(`
          SELECT count(*) AS turns,
                 sum(CASE WHEN costTotal <= 0 THEN 1 ELSE 0 END) AS zeroCost
          FROM turns
        `);
        return { turns: row?.turns ?? 0, zeroCost: row?.zeroCost ?? 0 };
      },
      { scope: appScope },
    ),

    /**
     * The drill-down: every turn of ONE session, plus its compactions.
     *
     * Keyed on `focusedSession`, so choosing a session in the table re-runs
     * exactly this cell and nothing else. A null focus resolves to the priciest
     * session — the panel is more useful with something in it than with a
     * "choose a session" placeholder, and the priciest is the one worth looking
     * at first.
     *
     * Deliberately unfiltered by the crossfilter: see `focusedSession` in
     * store.ts. This answers "what happened inside this session", not "how do
     * these dimensions co-vary".
     */
    sessionDetail: cell(
      () => ({ sessionId: store.focusedSession() }),
      async ({ sessionId }): Promise<SessionDetailData | null> => {
        const id =
          sessionId ??
          (
            await store.sql<{ sessionId: string }>(`
              SELECT sessionId FROM turns
              GROUP BY 1 ORDER BY sum(costTotal) DESC LIMIT 1
            `)
          )[0]?.sessionId;
        if (!id) return null;
        const quoted = `'${id.replace(/'/g, "''")}'`;

        const [turns, compactions, meta] = await Promise.all([
          store.sql<DetailTurn>(`
            SELECT epoch_ms(ts)      AS ts,
                   costCacheRead, costCacheCreate, costOutput, costInput, costTotal,
                   cacheReadTokens + cacheCreate5m + cacheCreate1h + inputTokens
                                     AS contextTokens,
                   outputTokens, model, context, agentType, hadFallback
            FROM turns WHERE sessionId = ${quoted}
            ORDER BY ts
          `),
          // The payload is deliberately untyped JSON in the grain, so the
          // fields come out through json_extract rather than as columns.
          store
            .sql<DetailCompaction>(`
              SELECT epoch_ms(ts)                                        AS ts,
                     CAST(json_extract(payload, '$.preTokens')  AS BIGINT) AS preTokens,
                     CAST(json_extract(payload, '$.postTokens') AS BIGINT) AS postTokens,
                     json_extract_string(payload, '$.trigger')             AS trigger
              FROM events WHERE kind = 'compaction' AND sessionId = ${quoted}
              ORDER BY ts
            `)
            .catch(() => [] as DetailCompaction[]),
          store
            .sql<{ name: string; project: string; nameWas: string | null }>(`
              SELECT name, project,
                     CASE WHEN nameChanged THEN nameFirst END AS nameWas
              FROM sessions WHERE sessionId = ${quoted} LIMIT 1
            `)
            .catch(() => []),
        ]);

        return {
          sessionId: id,
          name: meta[0]?.name ?? id.slice(0, 8),
          nameWas: meta[0]?.nameWas ?? null,
          project: meta[0]?.project ?? "",
          turns,
          compactions,
        };
      },
      { scope: appScope },
    ),

    /**
     * The replay of the focused session — the finest drill-down.
     *
     * Keyed on the same `focusedSession` as `sessionDetail`, so the two panels
     * always show the same session and picking one in the table moves both.
     *
     * The fetch is lazy and per session: the replay grain is 29.5 MB across 109
     * files, so it is not part of the startup load. `ensureReplay` returns null
     * when the dataset was built without `--replay`, which the panel reports as
     * a missing feature rather than an error.
     */
    replay: cell(
      () => ({ sessionId: store.focusedSession() }),
      async ({ sessionId }): Promise<ReplayData | null> => {
        const id =
          sessionId ??
          (
            await store.sql<{ sessionId: string }>(`
              SELECT sessionId FROM turns
              GROUP BY 1 ORDER BY sum(costTotal) DESC LIMIT 1
            `)
          )[0]?.sessionId;
        if (!id) return null;
        const table = await store.ensureReplay(id);
        if (!table) return { sessionId: id, available: false, rows: [] };
        const rows = await store.sql<ReplayRow>(`
          SELECT seq, epoch_ms(ts) AS ts, agentId, context, uuid, parentUuid,
                 role, kind, text, truncated, fullChars,
                 toolName, toolUseId, ok, errorKind, exitCode, durationMs, model
          -- Time, not file order. seq follows the walk, which yields a
          -- session's subagents/ directory BEFORE the session file beside it,
          -- so ordering by it opens the transcript on an agent's work rather
          -- than on the conversation that launched it. Every block in this
          -- corpus carries a real timestamp (0 nulls of 113,569), so ordering
          -- by ts is total; seq breaks same-millisecond ties in file order.
          FROM "${table}" ORDER BY ts, seq
        `);
        return { sessionId: id, available: true, rows };
      },
      { scope: appScope },
    ),

    /**
     * Images: estimated tokens, deduplicated by content hash. `tool_result` and
     * `toolUseResult` are two views of one payload, so a naive count of rows
     * would nearly double the real image count.
     */
    images: cell(
      () => ({}),
      async () =>
        store.sql<{ mediaType: string; n: number; estTokens: number; megapixels: number }>(`
          WITH distinct_images AS (
            SELECT hash, any_value(mediaType) AS mediaType,
                   any_value(estTokens) AS estTokens,
                   any_value(width) AS width, any_value(height) AS height
            FROM images GROUP BY hash
          )
          SELECT mediaType,
                 count(*)                          AS n,
                 sum(estTokens)                    AS estTokens,
                 sum(width * height) / 1e6         AS megapixels
          FROM distinct_images
          GROUP BY 1 ORDER BY estTokens DESC
        `),
      { scope: appScope },
    ),
  }),
  // Passed, not read here: `import.meta.hot` is bound to THIS module, and a
  // library can't self-accept on our behalf. See hotCellGraph's docs.
  import.meta.hot,
);

/** The graph's shape, inferred — components can type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface: derived from the declarations -------------------------
//
// Controls (store.ts) and actions (declared next to their features) surface
// automatically: `registerStandardTools` provides `report` (the whole picture:
// controls, cells, actions, dependency edges), `set` (validated through each
// control's own meta), `locate`, and one real tool per action. Hand-write a
// kit.registerTool(...) only for operations that are genuinely neither a value
// nor a verb-with-args. Registration is idempotent by name (HMR-safe).

// The toolkit namespace is the app's slug: tools install at window.__<slug>.
const kit = agentToolkit(appScope.name);

// `locate` (element → source) and the `cells` attribution table: app-independent,
// and every aiui app should have them.
registerStandardTools(kit);

/**
 * Ad-hoc SQL over the five grains. This is the one genuinely bespoke tool here:
 * "what did I spend on X" is an open-ended question and no fixed set of
 * controls covers it, so the agent gets the query surface directly. Read-only
 * by construction — DuckDB-WASM holds a throwaway in-memory database built from
 * the parquet, so the worst a bad query can do is fail.
 */
export const querySql = action({
  scope: appScope,
  name: "query",
  description:
    "Run read-only SQL over the loaded tables: turns, toolCalls, events, sessions, images. " +
    "Returns at most 200 rows as JSON. See aiui-cc-assay's normalize.ts for the column list.",
  params: { sql: "A DuckDB SELECT statement over turns/toolCalls/events/sessions/images." },
  run: async (args?: Record<string, unknown>) => {
    const query = typeof args?.sql === "string" ? args.sql : "";
    if (!query.trim()) return { error: "no sql provided" };
    const rows = await store.sql(`SELECT * FROM (${query}) LIMIT 200`);
    return { rows: rows.length, data: rows };
  },
});

/**
 * Move the session graph's time brush — the same path the drag uses, so there
 * is one way to move the selection rather than two that can disagree.
 *
 * Beware the coordinator's batching when scripting this: a `report()` in the
 * same tick reads the pre-brush numbers (seismos hit this too, NOTES.md
 * finding 7). Await a task boundary before reading the result back.
 */
export const brush = action({
  scope: appScope,
  name: "brush",
  description:
    "Brush a wall-clock range into the shared cross-filter, narrowing every view. " +
    "Omit both bounds to clear the brush.",
  params: {
    from: "ISO timestamp or epoch milliseconds for the start of the range.",
    to: "ISO timestamp or epoch milliseconds for the end of the range.",
  },
  run: async (args?: Record<string, unknown>) => {
    const ms = (v: unknown): number | null => {
      if (v == null || v === "") return null;
      const n = typeof v === "number" ? v : Date.parse(String(v));
      return Number.isFinite(n) ? n : null;
    };
    const from = ms(args?.from);
    const to = ms(args?.to);
    if (from === null || to === null) {
      brushTime(null);
      return { brushed: null };
    }
    brushTime([Math.min(from, to), Math.max(from, to)]);
    // The coordinator batches; let it settle so the returned stats are real.
    await new Promise((r) => setTimeout(r, 120));
    return { brushed: [Math.min(from, to), Math.max(from, to)], selection: store.selectionStats() };
  },
});

/**
 * Point the drill-down at a session.
 *
 * Takes a name as readily as an id, because a name is what the reader has in
 * front of them — the timeline and the sessions table both show one. Matching
 * is case-insensitive and accepts a prefix of the id, so `inspect march` and
 * `inspect de93c3a5` both land.
 */
export const inspectSession = action({
  scope: appScope,
  name: "inspect",
  description:
    "Focus the session drill-down on one session, by name or session id (a prefix is enough). " +
    "Pass nothing to fall back to the priciest session.",
  params: { session: "A session name or (a prefix of) its id." },
  run: async (args?: Record<string, unknown>) => {
    const q = String(args?.session ?? "").trim();
    if (!q) {
      focusSession(null);
      return { focused: null, note: "reset to the priciest session" };
    }
    const like = q.toLowerCase().replace(/'/g, "''");
    const hits = await store.sql<{ sessionId: string; name: string; cost: number }>(`
      SELECT s.sessionId, s.name, sum(t.costTotal) AS cost
      FROM sessions s JOIN turns t USING (sessionId)
      WHERE lower(s.name) = '${like}' OR lower(s.sessionId) LIKE '${like}%'
         OR lower(s.name) LIKE '%${like}%'
      GROUP BY 1, 2 ORDER BY cost DESC LIMIT 5
    `);
    if (hits.length === 0) return { error: `no session matches ${q}` };
    focusSession(hits[0].sessionId);
    return {
      focused: { sessionId: hits[0].sessionId, name: hits[0].name, cost: hits[0].cost },
      ...(hits.length > 1 ? { alsoMatched: hits.slice(1).map((h) => h.name) } : {}),
    };
  },
});

/** Fold every project in the session graph to one row, or unfold them all. */
export const foldProjects = action({
  scope: appScope,
  name: "fold-projects",
  description: "Collapse every project in the session graph to a single row, or expand them all.",
  params: { collapsed: "true to collapse every project, false to expand them all." },
  run: async (args?: Record<string, unknown>) => {
    const collapsed = args?.collapsed !== false && String(args?.collapsed) !== "false";
    const projects = [...new Set(store.timeline().spans.map((s) => s.project))];
    setAllCollapsed(projects, collapsed);
    return { collapsed, projects: projects.length };
  },
});
