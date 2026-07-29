/**
 * export.ts — write the grains into the corpus layout, locally or to S3.
 *
 * The layout, and the reasoning behind every key, is `LAYOUT.md` next door. This
 * file is its implementation and should not invent policy: if you find yourself
 * wanting a different path shape, change the spec first.
 *
 * The whole S3 integration is one `CREATE SECRET`. DuckDB writes Parquet to
 * `s3://` exactly as it writes to a directory, so there is no SDK here, no
 * credential plumbing, and one code path for both destinations.
 */
import { statSync } from "node:fs";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";

/** A grain, and how (or whether) it is partitioned by month. */
export interface GrainSpec {
  name: string;
  /**
   * The grain's own timestamp column. They are NOT uniform — `turns` has `ts`,
   * `sessions` has `firstTs`, `forkEdges` has `forkPointTs` — which is why this
   * is a per-grain fact rather than a constant.
   */
  timeColumn: string;
  /**
   * Whether to add a `month=` level. Only worth it where incremental upload
   * matters; see LAYOUT.md for the ~8 MB rule of thumb. Everything else would be
   * a directory of 20 KB files.
   */
  partitionedByMonth: boolean;
}

export const GRAINS: readonly GrainSpec[] = [
  { name: "turns", timeColumn: "ts", partitionedByMonth: true },
  { name: "toolCalls", timeColumn: "ts", partitionedByMonth: true },
  { name: "events", timeColumn: "ts", partitionedByMonth: false },
  { name: "sessions", timeColumn: "firstTs", partitionedByMonth: false },
  { name: "images", timeColumn: "ts", partitionedByMonth: false },
  { name: "forkEdges", timeColumn: "forkPointTs", partitionedByMonth: false },
  { name: "agentRuns", timeColumn: "firstTs", partitionedByMonth: false },
  { name: "lineages", timeColumn: "firstTs", partitionedByMonth: false },
];

export interface ShardEntry {
  grain: string;
  username: string;
  host: string;
  month?: string;
  path: string;
  /**
   * Exact size, when the writer could see it. Absent for an S3 prefix, where
   * there is no cheap stat — a fabricated number would be worse than none, so
   * local-bytes selection falls back to Content-Length at fetch time.
   */
  bytes?: number;
  rows: number;
}

export interface CorpusIndex {
  version: 1;
  generatedAt: string;
  layout: string;
  users: string[];
  /** hostId → the current human-readable hostname. Paths use the id. */
  hosts: Record<string, string>;
  grains: Record<string, { partitionedByMonth: boolean; timeColumn: string }>;
  shards: ShardEntry[];
  totals: { bytes: number; rows: number };
}

export const LAYOUT_DESCRIPTION =
  "<grain>/username=<u>/host=<hostId>[/month=<YYYY-MM>]/part0.parquet";

/**
 * A partition value has to survive a round trip through a filesystem path and a
 * Hive parser, so anything outside a conservative set is rejected rather than
 * escaped. A username with a `/` in it is not a case to be clever about.
 */
function assertKeySafe(kind: string, value: string): void {
  const bad =
    !/^[A-Za-z0-9._@-]+$/.test(value) ||
    // `.` has to be allowed — plenty of usernames are `first.last` — which lets
    // `..` through the character class. A dot-only segment is path traversal
    // whether or not it also passes the allowlist, so it is rejected by shape.
    /(^|[^A-Za-z0-9_@-])\.\.(?![A-Za-z0-9_@-])/.test(value) ||
    /^\.+$/.test(value);
  if (bad) {
    throw new Error(
      `${kind} ${JSON.stringify(value)} is not safe as a partition key ` +
        `(allowed: letters, digits, dot, underscore, at, hyphen; no ".." segment)`,
    );
  }
}

/** `CREATE SECRET` for the chosen AWS profile. The entire S3 integration. */
export async function attachS3(conn: DuckDBConnection, profile: string): Promise<void> {
  assertKeySafe("aws profile", profile);
  await conn.run("INSTALL httpfs");
  await conn.run("LOAD httpfs");
  await conn.run("INSTALL aws");
  await conn.run("LOAD aws");
  // CHAIN is NOT optional. The default credential chain has no SSO step, so an
  // SSO profile fails at CREATE with "Secret Validation Failure" — measured
  // against a real `sso_session` profile. 'sso' alone then breaks static
  // profiles, so the chain names all three sources: env vars, SSO cache, then
  // ~/.aws/credentials.
  await conn.run(
    `CREATE OR REPLACE SECRET cc_s3 (TYPE s3, PROVIDER credential_chain, ` +
      `CHAIN 'env;sso;config', PROFILE '${profile}')`,
  );
}

export interface ExportOptions {
  /** Destination root: a local directory or an `s3://bucket/prefix`. */
  prefix: string;
  username: string;
  /** The STABLE host id, never `os.hostname()` — see LAYOUT.md. */
  hostId: string;
  /** How to read a grain's source rows, e.g. a `read_parquet(…)` expression. */
  sourceSql: (grain: string) => string;
  /**
   * Keep only the most recent N months. This is what makes a corpus small
   * enough to ship as local bytes — the whole point of the local path is that
   * it stays fast to start, so it carries a trailing window rather than
   * everything. Absent means the whole corpus.
   */
  months?: number;
}

/**
 * Write one grain. Returns the SQL that was run, so callers can log or dry-run.
 *
 * `OVERWRITE_OR_IGNORE` plus a deterministic `FILENAME_PATTERN` is what makes a
 * re-export idempotent: the same partition is replaced rather than joined by a
 * second file with a fresh name.
 */
export function exportGrainSql(grain: GrainSpec, opts: ExportOptions): string {
  assertKeySafe("username", opts.username);
  assertKeySafe("hostId", opts.hostId);
  const keys = ["username", "host", ...(grain.partitionedByMonth ? ["month"] : [])];
  const monthExpr = grain.partitionedByMonth
    ? `, strftime("${grain.timeColumn}", '%Y-%m') AS month`
    : "";
  // The window is applied to EVERY grain, month-partitioned or not: a trimmed
  // corpus whose `sessions` still covered all time would show sessions with no
  // turns behind them. The cut uses each grain's own time column.
  const where =
    opts.months && opts.months > 0
      ? ` WHERE "${grain.timeColumn}" >= (SELECT max("${grain.timeColumn}") ` +
        `FROM ${opts.sourceSql(grain.name)}) - INTERVAL ${Math.floor(opts.months)} MONTH`
      : "";
  return (
    `COPY (SELECT *, '${opts.username}' AS username, '${opts.hostId}' AS host${monthExpr} ` +
    `FROM ${opts.sourceSql(grain.name)}${where}) ` +
    `TO '${opts.prefix}/${grain.name}' ` +
    `(FORMAT parquet, COMPRESSION zstd, PARTITION_BY (${keys.join(", ")}), ` +
    `FILENAME_PATTERN 'part', OVERWRITE_OR_IGNORE)`
  );
}

/** Build the index from what was actually written. Local prefixes only get sizes. */
export function buildIndex(
  shards: ShardEntry[],
  meta: { users: string[]; hosts: Record<string, string> },
): CorpusIndex {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    layout: LAYOUT_DESCRIPTION,
    users: meta.users,
    hosts: meta.hosts,
    grains: Object.fromEntries(
      GRAINS.map((g) => [
        g.name,
        { partitionedByMonth: g.partitionedByMonth, timeColumn: g.timeColumn },
      ]),
    ),
    shards,
    totals: {
      bytes: shards.reduce((a, s) => a + (s.bytes ?? 0), 0),
      rows: shards.reduce((a, s) => a + s.rows, 0),
    },
  };
}

/**
 * Who and which machine, for the two partition keys.
 *
 * The host id comes from `resolveHost` — the stable minted UUID, deliberately
 * not `os.hostname()`, because a rename must not fork one machine's history
 * (see host.ts and LAYOUT.md). The username defaults to the OS login and can be
 * overridden, since the corpus may be shared under a name that is not the local
 * account.
 */
export async function resolveHostIdentity(
  dir: string,
  usernameOverride?: string,
): Promise<{ username: string; hostId: string; hostname: string }> {
  const { resolveHost } = await import("./host");
  const identity = await resolveHost(dir);
  const { userInfo } = await import("node:os");
  return {
    username: usernameOverride ?? userInfo().username,
    hostId: identity.hostId,
    hostname: identity.hostname,
  };
}

/** Size a written shard on a local prefix; `null` when it is not on disk. */
export function localShardBytes(prefix: string, relPath: string): number | null {
  if (prefix.startsWith("s3://")) return null;
  try {
    return statSync(path.join(prefix, relPath)).size;
  } catch {
    return null;
  }
}

/**
 * Greedily choose shards for local-bytes mode: everything undated first (those
 * are the small grains and are always wanted), then newest months, stopping
 * before the budget is exceeded. Deterministic, so two clients with the same
 * index and budget load the same subset.
 */
export function selectShards(index: CorpusIndex, budgetBytes: number): ShardEntry[] {
  const ordered = [...index.shards].sort((a, b) => {
    if (!a.month && b.month) return -1;
    if (a.month && !b.month) return 1;
    if (a.month && b.month && a.month !== b.month) return a.month < b.month ? 1 : -1;
    return a.path < b.path ? -1 : 1;
  });
  const out: ShardEntry[] = [];
  let total = 0;
  for (const s of ordered) {
    // An unsized shard (an S3 index) cannot be budgeted ahead of time; take it
    // and let the fetcher stop on actual Content-Length.
    const size = s.bytes ?? 0;
    if (total + size > budgetBytes) continue;
    out.push(s);
    total += size;
  }
  return out;
}
