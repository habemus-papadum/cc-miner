/**
 * Writing the grains to Parquet.
 *
 * `hyparquet-writer` is pure JS — no native module, so CI installs cannot break
 * on it, and the same files are read back by DuckDB-WASM in the browser demo.
 *
 * Two things it demands that shape the code below:
 *
 *  - **INT64 columns want BigInt**, not number. Timestamps and token counts are
 *    therefore converted at the boundary. Costs stay DOUBLE (they are fractions
 *    of a cent and exactness is meaningless).
 *  - **Columns are typed up front**, so a column that is all-null still needs a
 *    declared type. `col()` handles that rather than letting the writer infer
 *    from an empty array.
 *
 * **This file is where `number` becomes `TIMESTAMP`.** Every `*Ts` field is a
 * plain JS epoch-millisecond `number` in the row types, and lands in Parquet as
 * a real `TIMESTAMP` column — so SQL gets `WHERE ts BETWEEN TIMESTAMP '…'`
 * rather than integer arithmetic, and a consumer that wants the millis back asks
 * for `epoch_ms(ts)`. The row interfaces describe the in-memory shape, not the
 * column type; this is the only place the two are related, deliberately.
 *
 * A `*Ts` of 0 means "unknown" and is written as **NULL**, never as 1970 — an
 * epoch-zero timestamp is a mark in the wrong place in any chart that forgets to
 * check, while a null just does not draw.
 */

import { parquetWriteFile } from "hyparquet-writer";
import type {
  AgentRunRow,
  EventRow,
  ForkEdgeRow,
  ImageRow,
  LineageRow,
  Normalized,
  SessionRow,
  ToolCallRow,
  TurnRow,
} from "./normalize.ts";
import type { ReplayRow } from "./replay.ts";

type ColType = "STRING" | "DOUBLE" | "INT64" | "BOOLEAN" | "TIMESTAMP";
interface ColumnData {
  name: string;
  data: unknown[];
  type: ColType;
}

/** Pull one column out of a row array, coercing to what the writer accepts. */
function col<T>(name: string, rows: T[], type: ColType, pick: (r: T) => unknown): ColumnData {
  const data = rows.map((r) => {
    const v = pick(r);
    if (v === undefined || v === null) return null;
    if (type === "INT64" || type === "TIMESTAMP") {
      const n = typeof v === "bigint" ? v : BigInt(Math.round(Number(v)));
      return n;
    }
    if (type === "DOUBLE") return Number(v);
    if (type === "BOOLEAN") return Boolean(v);
    return String(v);
  });
  return { name, data, type };
}

const turnColumns = (rows: TurnRow[]): ColumnData[] => [
  col("hostId", rows, "STRING", (r) => r.hostId),
  col("messageId", rows, "STRING", (r) => r.messageId),
  col("requestId", rows, "STRING", (r) => r.requestId),
  col("uuid", rows, "STRING", (r) => r.uuid),
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("lineageId", rows, "STRING", (r) => r.lineageId),
  col("fileSessionId", rows, "STRING", (r) => r.fileSessionId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("project", rows, "STRING", (r) => r.project),
  col("cwd", rows, "STRING", (r) => r.cwd),
  col("gitBranch", rows, "STRING", (r) => r.gitBranch),
  col("ts", rows, "TIMESTAMP", (r) => r.ts),
  col("model", rows, "STRING", (r) => r.model),
  col("modelVariant", rows, "STRING", (r) => r.modelVariant),
  col("effort", rows, "STRING", (r) => r.effort),
  col("stopReason", rows, "STRING", (r) => r.stopReason),
  col("serviceTier", rows, "STRING", (r) => r.serviceTier),
  col("speed", rows, "STRING", (r) => r.speed),
  col("context", rows, "STRING", (r) => r.context),
  col("agentId", rows, "STRING", (r) => r.agentId),
  col("agentType", rows, "STRING", (r) => r.agentType),
  col("workflowId", rows, "STRING", (r) => r.workflowId),
  col("entrypoint", rows, "STRING", (r) => r.entrypoint),
  col("sessionKind", rows, "STRING", (r) => r.sessionKind),
  col("ccVersion", rows, "STRING", (r) => r.ccVersion),
  col("attributionSkill", rows, "STRING", (r) => r.attributionSkill),
  col("attributionPlugin", rows, "STRING", (r) => r.attributionPlugin),
  col("attributionMcpServer", rows, "STRING", (r) => r.attributionMcpServer),
  col("attributionMcpTool", rows, "STRING", (r) => r.attributionMcpTool),
  col("inputTokens", rows, "INT64", (r) => r.inputTokens),
  col("outputTokens", rows, "INT64", (r) => r.outputTokens),
  col("cacheCreate5m", rows, "INT64", (r) => r.cacheCreate5m),
  col("cacheCreate1h", rows, "INT64", (r) => r.cacheCreate1h),
  col("cacheReadTokens", rows, "INT64", (r) => r.cacheReadTokens),
  col("webSearches", rows, "INT64", (r) => r.webSearches),
  col("webFetches", rows, "INT64", (r) => r.webFetches),
  col("hadFallback", rows, "BOOLEAN", (r) => r.hadFallback),
  col("wastedOutputTokens", rows, "INT64", (r) => r.wastedOutputTokens),
  col("nBlocks", rows, "INT64", (r) => r.nBlocks),
  col("nThinkingChars", rows, "INT64", (r) => r.nThinkingChars),
  col("nToolUses", rows, "INT64", (r) => r.nToolUses),
  col("nImages", rows, "INT64", (r) => r.nImages),
  col("estImageTokens", rows, "INT64", (r) => r.estImageTokens),
  col("aborted", rows, "BOOLEAN", (r) => r.aborted),
  col("costInput", rows, "DOUBLE", (r) => r.costInput),
  col("costOutput", rows, "DOUBLE", (r) => r.costOutput),
  col("costCacheCreate", rows, "DOUBLE", (r) => r.costCacheCreate),
  col("costCacheRead", rows, "DOUBLE", (r) => r.costCacheRead),
  col("costTotal", rows, "DOUBLE", (r) => r.costTotal),
  col("pricingVersion", rows, "STRING", (r) => r.pricingVersion),
  col("unpriced", rows, "BOOLEAN", (r) => r.unpriced),
];

const toolCallColumns = (rows: ToolCallRow[]): ColumnData[] => [
  col("messageId", rows, "STRING", (r) => r.messageId),
  col("toolUseId", rows, "STRING", (r) => r.toolUseId),
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("ts", rows, "TIMESTAMP", (r) => r.ts),
  col("toolName", rows, "STRING", (r) => r.toolName),
  col("isMcp", rows, "BOOLEAN", (r) => r.isMcp),
  col("mcpServer", rows, "STRING", (r) => r.mcpServer),
  col("context", rows, "STRING", (r) => r.context),
  col("ok", rows, "BOOLEAN", (r) => r.ok),
  col("interrupted", rows, "BOOLEAN", (r) => r.interrupted),
  col("errorKind", rows, "STRING", (r) => r.errorKind),
  col("exitCode", rows, "INT64", (r) => r.exitCode),
  col("durationMs", rows, "INT64", (r) => r.durationMs),
];

const eventColumns = (rows: EventRow[]): ColumnData[] => [
  col("ts", rows, "TIMESTAMP", (r) => r.ts),
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("kind", rows, "STRING", (r) => r.kind),
  col("payload", rows, "STRING", (r) => r.payload),
];

const sessionColumns = (rows: SessionRow[]): ColumnData[] => [
  col("hostId", rows, "STRING", (r) => r.hostId),
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("project", rows, "STRING", (r) => r.project),
  col("cwd", rows, "STRING", (r) => r.cwd),
  col("slug", rows, "STRING", (r) => r.slug),
  col("name", rows, "STRING", (r) => r.name),
  col("nameKind", rows, "STRING", (r) => r.nameKind),
  col("nameFirst", rows, "STRING", (r) => r.nameFirst),
  col("nameChanged", rows, "BOOLEAN", (r) => r.nameChanged),
  col("customTitle", rows, "STRING", (r) => r.customTitle),
  col("customTitleFirst", rows, "STRING", (r) => r.customTitleFirst),
  col("aiTitle", rows, "STRING", (r) => r.aiTitle),
  col("aiTitleFirst", rows, "STRING", (r) => r.aiTitleFirst),
  col("parentSessionId", rows, "STRING", (r) => r.parentSessionId),
  col("lineageId", rows, "STRING", (r) => r.lineageId),
  col("depth", rows, "INT64", (r) => r.depth),
  col("forkPointTs", rows, "TIMESTAMP", (r) => r.forkPointTs || undefined),
  col("parentSource", rows, "STRING", (r) => r.parentSource),
  col("parentKind", rows, "STRING", (r) => r.parentKind),
  col("parentAmbiguous", rows, "BOOLEAN", (r) => r.parentAmbiguous),
  col("nRecordsInherited", rows, "INT64", (r) => r.nRecordsInherited),
  col("nTurnsInherited", rows, "INT64", (r) => r.nTurnsInherited),
  col("inheritedCost", rows, "DOUBLE", (r) => r.inheritedCost),
  col("createdTs", rows, "TIMESTAMP", (r) => r.createdTs),
  col("firstNativeTs", rows, "TIMESTAMP", (r) => r.firstNativeTs),
  col("lastNativeTs", rows, "TIMESTAMP", (r) => r.lastNativeTs),
  col("firstTs", rows, "TIMESTAMP", (r) => r.firstTs),
  col("lastTs", rows, "TIMESTAMP", (r) => r.lastTs),
  col("spanSeconds", rows, "DOUBLE", (r) => r.spanSeconds),
  col("activeSeconds", rows, "DOUBLE", (r) => r.activeSeconds),
  col("dutyCycle", rows, "DOUBLE", (r) => r.dutyCycle),
  col("nTurnsNative", rows, "INT64", (r) => r.nTurnsNative),
  col("nSubagentTurns", rows, "INT64", (r) => r.nSubagentTurns),
  col("nAgentRuns", rows, "INT64", (r) => r.nAgentRuns),
  col("nCompactions", rows, "INT64", (r) => r.nCompactions),
  col("peakContextTokens", rows, "INT64", (r) => r.peakContextTokens),
  col("nativeCost", rows, "DOUBLE", (r) => r.nativeCost),
  col("models", rows, "STRING", (r) => r.models),
  col("ccVersions", rows, "STRING", (r) => r.ccVersions),
];

const forkEdgeColumns = (rows: ForkEdgeRow[]): ColumnData[] => [
  col("childSessionId", rows, "STRING", (r) => r.childSessionId),
  col("parentSessionId", rows, "STRING", (r) => r.parentSessionId),
  col("lineageId", rows, "STRING", (r) => r.lineageId),
  col("depth", rows, "INT64", (r) => r.depth),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("project", rows, "STRING", (r) => r.project),
  col("kind", rows, "STRING", (r) => r.kind),
  col("forkPointTs", rows, "TIMESTAMP", (r) => r.forkPointTs || undefined),
  col("childCreatedTs", rows, "TIMESTAMP", (r) => r.childCreatedTs || undefined),
  col("childFirstNativeTs", rows, "TIMESTAMP", (r) => r.childFirstNativeTs || undefined),
  col("lagSeconds", rows, "DOUBLE", (r) => r.lagSeconds),
  col("nRecordsInherited", rows, "INT64", (r) => r.nRecordsInherited),
  col("nTurnsInherited", rows, "INT64", (r) => r.nTurnsInherited),
  col("inheritedCost", rows, "DOUBLE", (r) => r.inheritedCost),
  col("source", rows, "STRING", (r) => r.source),
  col("ambiguous", rows, "BOOLEAN", (r) => r.ambiguous),
  col("parentMissing", rows, "BOOLEAN", (r) => r.parentMissing),
  col("parentHasTurns", rows, "BOOLEAN", (r) => r.parentHasTurns),
  col("childHasTurns", rows, "BOOLEAN", (r) => r.childHasTurns),
  col("billedAncestorSessionId", rows, "STRING", (r) => r.billedAncestorSessionId),
  col(
    "billedAncestorForkPointTs",
    rows,
    "TIMESTAMP",
    (r) => r.billedAncestorForkPointTs || undefined,
  ),
];

const lineageColumns = (rows: LineageRow[]): ColumnData[] => [
  col("lineageId", rows, "STRING", (r) => r.lineageId),
  col("rootSessionId", rows, "STRING", (r) => r.rootSessionId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("project", rows, "STRING", (r) => r.project),
  col("nSessions", rows, "INT64", (r) => r.nSessions),
  col("nForks", rows, "INT64", (r) => r.nForks),
  col("maxDepth", rows, "INT64", (r) => r.maxDepth),
  col("firstTs", rows, "TIMESTAMP", (r) => r.firstTs || undefined),
  col("lastTs", rows, "TIMESTAMP", (r) => r.lastTs || undefined),
  col("nTurns", rows, "INT64", (r) => r.nTurns),
  col("totalCost", rows, "DOUBLE", (r) => r.totalCost),
  col("sessionIds", rows, "STRING", (r) => r.sessionIds),
];

const agentRunColumns = (rows: AgentRunRow[]): ColumnData[] => [
  col("agentId", rows, "STRING", (r) => r.agentId),
  col("agentType", rows, "STRING", (r) => r.agentType),
  col("name", rows, "STRING", (r) => r.name),
  col("nameKind", rows, "STRING", (r) => r.nameKind),
  col("parentSessionId", rows, "STRING", (r) => r.parentSessionId),
  col("lineageId", rows, "STRING", (r) => r.lineageId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("project", rows, "STRING", (r) => r.project),
  col("context", rows, "STRING", (r) => r.context),
  col("workflowId", rows, "STRING", (r) => r.workflowId),
  col("firstTs", rows, "TIMESTAMP", (r) => r.firstTs),
  col("lastTs", rows, "TIMESTAMP", (r) => r.lastTs),
  col("spanSeconds", rows, "DOUBLE", (r) => r.spanSeconds),
  col("nTurns", rows, "INT64", (r) => r.nTurns),
  col("nToolUses", rows, "INT64", (r) => r.nToolUses),
  col("cost", rows, "DOUBLE", (r) => r.cost),
  col("inputTokens", rows, "INT64", (r) => r.inputTokens),
  col("outputTokens", rows, "INT64", (r) => r.outputTokens),
  col("cacheReadTokens", rows, "INT64", (r) => r.cacheReadTokens),
  col("models", rows, "STRING", (r) => r.models),
  col("inheritedContextLength", rows, "INT64", (r) => r.inheritedContextLength),
  col("parentLastUuid", rows, "STRING", (r) => r.parentLastUuid),
];

const imageColumns = (rows: ImageRow[]): ColumnData[] => [
  col("uuid", rows, "STRING", (r) => r.uuid),
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("ts", rows, "TIMESTAMP", (r) => r.ts),
  col("carrier", rows, "STRING", (r) => r.carrier),
  col("mediaType", rows, "STRING", (r) => r.mediaType),
  col("width", rows, "INT64", (r) => r.width),
  col("height", rows, "INT64", (r) => r.height),
  col("bytesBase64", rows, "INT64", (r) => r.bytesBase64),
  col("estTokens", rows, "INT64", (r) => r.estTokens),
  col("hash", rows, "STRING", (r) => r.hash),
];

export const TABLES = [
  "turns",
  "toolCalls",
  "events",
  "sessions",
  "forkEdges",
  "lineages",
  "agentRuns",
  "images",
] as const;
export type TableName = (typeof TABLES)[number];

export function columnsFor(name: TableName, n: Normalized): ColumnData[] {
  switch (name) {
    case "turns":
      return turnColumns(n.turns);
    case "toolCalls":
      return toolCallColumns(n.toolCalls);
    case "events":
      return eventColumns(n.events);
    case "sessions":
      return sessionColumns(n.sessions);
    case "forkEdges":
      return forkEdgeColumns(n.forkEdges);
    case "lineages":
      return lineageColumns(n.lineages);
    case "agentRuns":
      return agentRunColumns(n.agentRuns);
    case "images":
      return imageColumns(n.images);
  }
}

export function rowCount(name: TableName, n: Normalized): number {
  switch (name) {
    case "turns":
      return n.turns.length;
    case "toolCalls":
      return n.toolCalls.length;
    case "events":
      return n.events.length;
    case "sessions":
      return n.sessions.length;
    case "forkEdges":
      return n.forkEdges.length;
    case "lineages":
      return n.lineages.length;
    case "agentRuns":
      return n.agentRuns.length;
    case "images":
      return n.images.length;
  }
}

/**
 * Write every table into `dir`. Returns per-table byte sizes.
 *
 * A table with no rows is still written: an absent file makes the demo's
 * queries fail at load, while an empty one just yields no rows.
 */
export async function writeParquet(
  dir: string,
  n: Normalized,
  fs: {
    mkdir: (p: string, o: { recursive: true }) => Promise<unknown>;
    stat: (p: string) => Promise<{ size: number }>;
  },
  join: (...p: string[]) => string,
): Promise<Record<string, { rows: number; bytes: number }>> {
  await fs.mkdir(dir, { recursive: true });
  const out: Record<string, { rows: number; bytes: number }> = {};
  for (const name of TABLES) {
    const filename = join(dir, `${name}.parquet`);
    parquetWriteFile({ filename, columnData: columnsFor(name, n) as never });
    out[name] = { rows: rowCount(name, n), bytes: (await fs.stat(filename)).size };
  }
  return out;
}

// ---------------------------------------------------------------------------
// the replay grain — partitioned, one file per session
// ---------------------------------------------------------------------------

const replayColumns = (rows: ReplayRow[]): ColumnData[] => [
  col("seq", rows, "INT64", (r) => r.seq),
  col("ts", rows, "TIMESTAMP", (r) => r.ts),
  col("agentId", rows, "STRING", (r) => r.agentId),
  col("context", rows, "STRING", (r) => r.context),
  col("uuid", rows, "STRING", (r) => r.uuid),
  col("parentUuid", rows, "STRING", (r) => r.parentUuid),
  col("role", rows, "STRING", (r) => r.role),
  col("kind", rows, "STRING", (r) => r.kind),
  col("text", rows, "STRING", (r) => r.text),
  col("truncated", rows, "BOOLEAN", (r) => r.truncated),
  col("fullChars", rows, "INT64", (r) => r.fullChars),
  col("toolName", rows, "STRING", (r) => r.toolName),
  col("toolUseId", rows, "STRING", (r) => r.toolUseId),
  col("ok", rows, "BOOLEAN", (r) => r.ok),
  col("errorKind", rows, "STRING", (r) => r.errorKind),
  col("exitCode", rows, "INT64", (r) => r.exitCode),
  col("durationMs", rows, "INT64", (r) => r.durationMs),
  col("model", rows, "STRING", (r) => r.model),
];

/**
 * Write `replay/<sessionId>.parquet`, one file per session.
 *
 * Partitioned rather than pooled because the content does not fit in one table
 * — see `replay.ts` — and because a replay is always scoped to one session
 * anyway, so the viewer fetches exactly the file it needs and nothing else.
 *
 * `sessionId` is deliberately NOT a column: it is the filename, so it would be
 * the same value on every row of every file. The index below carries it once.
 */
export async function writeReplay(
  dir: string,
  bySession: ReadonlyMap<string, ReplayRow[]>,
  fs: {
    mkdir: (p: string, o: { recursive: true }) => Promise<unknown>;
    stat: (p: string) => Promise<{ size: number }>;
    writeFile: (p: string, s: string) => Promise<unknown>;
  },
  join: (...p: string[]) => string,
): Promise<{ sessions: number; rows: number; bytes: number }> {
  const sub = join(dir, "replay");
  await fs.mkdir(sub, { recursive: true });
  const index: Array<{ sessionId: string; rows: number; bytes: number; t0: number; t1: number }> =
    [];
  let rows = 0;
  let bytes = 0;
  for (const [sessionId, list] of bySession) {
    if (list.length === 0) continue;
    // A session id comes from a directory name, but it reaches a URL, so a path
    // separator in one would escape the output directory. Refuse rather than
    // sanitise: a real id is a uuid and anything else is a bug worth seeing.
    if (!/^[\w.-]+$/.test(sessionId)) continue;
    const filename = join(sub, `${sessionId}.parquet`);
    parquetWriteFile({ filename, columnData: replayColumns(list) as never });
    const size = (await fs.stat(filename)).size;
    const ts = list.map((r) => r.ts).filter((t) => t > 0);
    index.push({
      sessionId,
      rows: list.length,
      bytes: size,
      t0: ts.length ? Math.min(...ts) : 0,
      t1: ts.length ? Math.max(...ts) : 0,
    });
    rows += list.length;
    bytes += size;
  }
  // An index so the viewer can tell "no replay for this session" from "not
  // fetched yet" without a 404 round-trip.
  index.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
  await fs.writeFile(join(sub, "index.json"), `${JSON.stringify(index)}\n`);
  return { sessions: index.length, rows, bytes };
}
