/**
 * actions.ts — the agent tool surface: verbs an agent can perform, and the
 * toolkit they install into.
 *
 * Split from graph.ts so the cell graph reads as a notebook and this reads as an
 * API. They grow for different reasons — a new panel adds a cell, a new
 * capability adds an action — and both lists stay legible when they are not
 * interleaved.
 *
 * Imported for side effects by graph.ts, so anything that pulls in the graph
 * still registers the tools; registration is idempotent by name (HMR-safe).
 */
import { action, agentToolkit, registerStandardTools } from "@habemus-papadum/aiui-viz";
import { isSourceMode } from "./source-mode";
import {
  appScope,
  brushTime,
  focusSession,
  MODES,
  setAllCollapsed,
  setSourceMode,
  sourceMode,
  store,
} from "./store";

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
/**
 * Switch which engine answers, the same verb the header button performs.
 *
 * Declared because declaring IS exposing: the mode is the single biggest
 * question about where an answer came from, and an agent inspecting this app
 * should be able to move it rather than only read it. Note this RELOADS the
 * page — the connector is chosen at boot — so it is the one action here that
 * ends the session it was called in.
 */
export const setSource = action({
  scope: appScope,
  name: "source",
  description:
    "Switch the data source between `local` (DuckDB-WASM in the page) and `host` " +
    "(a native DuckDB answering over Quack). Reloads the page. Asking for `host` " +
    "with no host running is a terminal error, never a quiet downgrade. `local` " +
    "exists only in dev builds — read `modes` from the result to see what this " +
    "build actually offers.",
  params: { mode: "`local` or `host`, whichever this build has." },
  run: async (args?: Record<string, unknown>) => {
    const mode = String(args?.mode ?? "");
    if (!isSourceMode(mode)) throw new Error(`not a data source: ${mode || "(missing)"}`);
    // Named explicitly rather than left to setSourceMode's throw: an agent that
    // asked for a mode this build does not have should be told what it CAN ask
    // for, in the same breath.
    if (!MODES.includes(mode)) {
      throw new Error(`this build has no \`${mode}\` data source; it offers: ${MODES.join(", ")}`);
    }
    const from = sourceMode.get();
    if (from === mode) return { mode, changed: false, modes: [...MODES] };
    setSourceMode(mode);
    return { mode, changed: true, reloading: true, modes: [...MODES] };
  },
});

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
