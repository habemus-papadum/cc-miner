/**
 * Stage 1 of ingestion: the raw layer.
 *
 * One row per JSONL line, per host, with as little interpretation as this
 * package can manage. The analytic grains (`normalize.ts`) are a *transform*
 * over this; they are opinionated, they drop message content, and they have
 * changed shape five times already. The raw layer exists so that changing them
 * again costs a SQL pass rather than a re-read of 560 MB across every machine.
 *
 * It also exists because the finest drill-down — replaying a session — needs
 * the message bodies the analytic grains deliberately throw away.
 *
 * ## Two tables
 *
 * `raw`   — one row per JSONL line. Filesystem facts as real columns, the
 *           record itself as a Parquet **VARIANT**.
 * `files` — one row per file *including the non-JSONL sidecars* (`.json`,
 *           `.md`, `.txt`, images, …). We do not know what all of them are yet;
 *           that is a reason to capture them, not to skip them. Small text
 *           sidecars carry their content inline, everything else is recorded by
 *           metadata and hash.
 *
 * ## Why VARIANT, and the two rules it imposes
 *
 * Measured against a real session file: unshredded VARIANT is 48% of the JSONL
 * size — smaller than storing the raw text (49%) — while being the only layout
 * DuckDB can navigate with native dot paths and preserved types. See the
 * proposal, §6.1.
 *
 *  1. **Lossless means value-lossless.** VARIANT normalises JSON object key
 *     order, and two JSON texts differing only in key order encode the same
 *     value. The round-trip test is deep equality. A line that fails to parse
 *     is not dropped — it keeps its original text in `rawText`.
 *  2. **Never project a bare VARIANT.** DuckDB reads VARIANT parquet fine but
 *     cannot hand one across the Arrow bridge to JavaScript. Every consumer
 *     must `CAST(rec.some.path AS VARCHAR)`. Deep paths and array indexing both
 *     work; only the un-cast projection fails.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { HostIdentity } from "./host.ts";
import { projectKey } from "./host.ts";
import { repoRoot, slugToPath } from "./scan.ts";

/** Sidecars up to this size get their text captured inline; larger are hashed only. */
const INLINE_TEXT_LIMIT = 256 * 1024;
const TEXT_EXT = new Set([".json", ".md", ".txt", ".jsonl", ".log", ".yaml", ".yml", ".toml"]);

export interface RawRow {
  hostId: string;
  /** Directory name under `projects/` — the cwd with `/` replaced by `-`. */
  projectSlug: string;
  /** Cross-host project key; see `projectKey`. */
  project: string;
  /** Path relative to the projects root, so it means the same on every machine. */
  relPath: string;
  fileKind: string;
  /** Session id taken from the path, which can differ from a record's own. */
  fileSessionId: string;
  /** 1-based line number within the file — the stable address of a record. */
  lineNo: number;
  /** Byte offset of the line start, so an incremental pass can resume. */
  byteOffset: number;
  /** The parsed record, stored as a Parquet VARIANT. */
  rec: unknown;
  /** Only set when the line could not be parsed — never silently dropped. */
  rawText?: string;
}

export interface FileRow {
  hostId: string;
  projectSlug: string;
  project: string;
  relPath: string;
  fileKind: string;
  ext: string;
  bytes: number;
  mtimeMs: number;
  /** sha256 of the file's bytes — the identity used for incremental skips. */
  sha256: string;
  /**
   * File birthtime in ms, or undefined where the platform has none.
   *
   * Captured here because it CANNOT be recovered later: once this artifact is
   * copied to another machine the original filesystem is gone. `lineage.ts`
   * needs it twice — a fork's file is created at the moment of the fork, which
   * is the honest position of a fork that produced nothing, and it is the
   * last-resort tiebreak when content cannot say which of two files is the copy.
   */
  createdMs?: number;
  /** Line count for JSONL files; 0 otherwise. */
  lines: number;
  /** Inline content for small text sidecars; absent for binaries and big files. */
  text?: string;
}

export interface RawStats {
  files: number;
  jsonlFiles: number;
  sidecarFiles: number;
  lines: number;
  parseErrors: number;
  bytes: number;
}

/**
 * Classify a path below `projects/<slug>/`. Mirrors `scan.ts`'s `FileKind` for
 * JSONL and adds the sidecar cases, since this layer captures everything.
 */
export function classify(rel: string[], name: string): string {
  const jsonl = name.endsWith(".jsonl");
  if (rel.length === 0) return jsonl ? "session" : "project-sidecar";
  if (name === "journal.jsonl") return "workflow-journal";
  if (rel.includes("workflows")) return jsonl ? "workflow-agent" : "workflow-sidecar";
  if (rel.includes("subagents")) return jsonl ? "subagent" : "subagent-sidecar";
  return jsonl ? "session" : "session-sidecar";
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/**
 * Walk one `projects/` root and yield every file, JSONL or not.
 *
 * `scan.ts` deliberately yields only `.jsonl` because the analytic pipeline has
 * no use for anything else. This layer wants everything — we do not yet know
 * what the sidecars are, and that is an argument for capturing them now rather
 * than discovering later that they were never kept.
 */
async function* walkAll(
  dir: string,
  projectSlug: string,
  rel: string[],
): AsyncGenerator<{ abs: string; rel: string[]; name: string }> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkAll(abs, projectSlug, [...rel, e.name]);
    else yield { abs, rel, name: e.name };
  }
}

export interface IngestResult {
  raw: RawRow[];
  files: FileRow[];
  stats: RawStats;
}

/**
 * Ingest one `projects/` root into raw + files rows.
 *
 * `known` lets an incremental run skip files whose (size, mtime) are unchanged
 * since the last pass — JSONL is append-only, so this is safe for everything
 * except the session being written right now, which changes size and is
 * therefore never skipped.
 */
export async function ingestRoot(
  root: string,
  host: HostIdentity,
  known: Map<string, { bytes: number; mtimeMs: number }> = new Map(),
): Promise<IngestResult> {
  const raw: RawRow[] = [];
  const files: FileRow[] = [];
  const stats: RawStats = {
    files: 0,
    jsonlFiles: 0,
    sidecarFiles: 0,
    lines: 0,
    parseErrors: 0,
    bytes: 0,
  };

  let slugs: string[];
  try {
    slugs = (await readdir(root)).sort();
  } catch {
    return { raw, files, stats };
  }

  for (const slug of slugs) {
    const slugDir = path.join(root, slug);
    try {
      if (!(await stat(slugDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const project = projectKey(repoRoot(slugToPath(slug)));

    for await (const { abs, rel, name } of walkAll(slugDir, slug, [])) {
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      const relPath = path.relative(root, abs);
      const fileKind = classify(rel, name);
      const ext = path.extname(name).toLowerCase();
      const isJsonl = name.endsWith(".jsonl");
      const fileSessionId = rel.length === 0 ? name.replace(/\.jsonl$/, "") : rel[0];

      stats.files++;
      stats.bytes += st.size;
      if (isJsonl) stats.jsonlFiles++;
      else stats.sidecarFiles++;

      const prior = known.get(relPath);
      const unchanged = prior && prior.bytes === st.size && prior.mtimeMs === st.mtimeMs;

      if (isJsonl) {
        let lines = 0;
        if (!unchanged) {
          let offset = 0;
          const rl = createInterface({
            input: createReadStream(abs, { encoding: "utf8" }),
            crlfDelay: Infinity,
          });
          for await (const line of rl) {
            const byteOffset = offset;
            offset += Buffer.byteLength(line, "utf8") + 1;
            if (!line.trim()) continue;
            lines++;
            const row: RawRow = {
              hostId: host.hostId,
              projectSlug: slug,
              project,
              relPath,
              fileKind,
              fileSessionId,
              lineNo: lines,
              byteOffset,
              rec: null,
            };
            try {
              row.rec = JSON.parse(line);
            } catch {
              // Keep the bytes rather than lose the line. This is the only case
              // where the raw layer stores text instead of a VARIANT.
              stats.parseErrors++;
              row.rawText = line;
            }
            raw.push(row);
          }
          stats.lines += lines;
        }
        files.push({
          hostId: host.hostId,
          projectSlug: slug,
          project,
          relPath,
          fileKind,
          ext,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
          sha256: unchanged ? "" : sha256(await readFile(abs)),
          lines,
          // ext4 without statx reports 0; an epoch birthtime is worse than none.
          // Floored to whole ms — this column is an INT64, and `scan.ts` floors
          // to match so both ingest paths derive identical values from it.
          ...(st.birthtimeMs > 0 ? { createdMs: Math.floor(st.birthtimeMs) } : {}),
        });
        continue;
      }

      // Non-JSONL sidecar. We do not know what most of these are; capture the
      // metadata always and the text when it is small enough to be free.
      const buf = await readFile(abs).catch(() => null);
      const inlineText =
        buf && TEXT_EXT.has(ext) && st.size <= INLINE_TEXT_LIMIT ? buf.toString("utf8") : undefined;
      files.push({
        hostId: host.hostId,
        projectSlug: slug,
        project,
        relPath,
        fileKind,
        ext,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        sha256: buf ? sha256(buf) : "",
        lines: 0,
        ...(st.birthtimeMs > 0 ? { createdMs: Math.floor(st.birthtimeMs) } : {}),
        ...(inlineText !== undefined ? { text: inlineText } : {}),
      });
    }
  }

  return { raw, files, stats };
}
