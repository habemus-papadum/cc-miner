/**
 * Stage 1's orchestrator: walk some roots, write one host's raw Parquet set.
 *
 * Split out of `raw-cli.ts` for the same reason `run.ts` is split out of
 * `cli.ts` — the pipeline is the thing worth testing, and a top-level script
 * cannot be called from a test. `raw-cli.ts` is now argument parsing and
 * reporting over this.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type HostIdentity, resolveHost } from "./host.ts";
import { type FileRow, ingestRoot, type RawRow, type RawStats } from "./raw.ts";
import { writeRaw } from "./raw-parquet.ts";

export interface RawIngestOptions {
  /** `projects/` directories to walk. */
  roots: string[];
  /** Destination directory — one host's artifact lives here. */
  out: string;
  onProgress?: (root: string, stats: RawStats) => void;
}

export interface RawIngestResult {
  host: HostIdentity;
  stats: RawStats;
  raw: RawRow[];
  files: FileRow[];
  tables: { raw: { rows: number; bytes: number }; files: { rows: number; bytes: number } };
  manifestPath: string;
}

const emptyStats = (): RawStats => ({
  files: 0,
  jsonlFiles: 0,
  sidecarFiles: 0,
  lines: 0,
  parseErrors: 0,
  bytes: 0,
});

/**
 * Ingest `roots` into `out`, writing `raw.parquet`, `files.parquet`,
 * `host.json` and a manifest.
 *
 * The host identity is resolved *from the output directory*, so re-running
 * against the same directory keeps the same `hostId` even if the machine was
 * renamed — that is the whole point of `host.json` living beside the data.
 */
export async function ingestCorpus(options: RawIngestOptions): Promise<RawIngestResult> {
  const { roots, out } = options;
  await mkdir(out, { recursive: true });
  const host = await resolveHost(out);

  const raw: RawRow[] = [];
  const files: FileRow[] = [];
  const stats = emptyStats();
  for (const root of roots) {
    const r = await ingestRoot(root, host);
    // NOT push(...arr) — the raw layer has ~160k rows and spreading that many
    // arguments overflows the call stack.
    for (const row of r.raw) raw.push(row);
    for (const row of r.files) files.push(row);
    for (const k of Object.keys(stats) as (keyof RawStats)[]) stats[k] += r.stats[k];
    options.onProgress?.(root, r.stats);
  }

  writeRaw(out, raw, files, path.join);

  const size = async (n: string) => (await stat(path.join(out, n))).size;
  const tables = {
    raw: { rows: raw.length, bytes: await size("raw.parquet") },
    files: { rows: files.length, bytes: await size("files.parquet") },
  };
  const manifestPath = path.join(out, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        $schema: "aiui/cc-raw-manifest@1",
        generatedAt: new Date().toISOString(),
        host,
        roots,
        stats,
        tables,
      },
      null,
      2,
    )}\n`,
  );

  return { host, stats, raw, files, tables, manifestPath };
}
