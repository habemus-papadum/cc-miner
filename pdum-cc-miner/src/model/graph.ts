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
import { cell, hotCellGraph } from "@habemus-papadum/aiui-viz";
import { projectScale } from "./palette";
import type { ReplayRow } from "./replay";
import type { DetailCompaction, DetailTurn } from "./session-detail";
import { appScope, idleGapMinutes, store } from "./store";

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

/**
 * The priciest session, for when nothing is focused.
 *
 * Two cells resolve "the focused session, else the most expensive one" and both
 * had this query inline, byte for byte. One copy, so a change to what "default
 * session" means cannot land in the drill-down and miss the replay.
 */
async function priciestSession(): Promise<string | undefined> {
  const rows = await store.sql<{ sessionId: string }>(`
    SELECT sessionId FROM turns
    GROUP BY 1 ORDER BY sum(costTotal) DESC LIMIT 1
  `);
  return rows[0]?.sessionId;
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
        const id = sessionId ?? (await priciestSession());
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
        const id = sessionId ?? (await priciestSession());
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

// Registering the agent surface is a side effect of building the graph, so any
// consumer of `graph` gets the tools too. Imported LAST: actions.ts imports
// `graph` back, and this ordering keeps that cycle resolvable.
import "./actions";
