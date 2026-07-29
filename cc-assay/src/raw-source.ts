/**
 * Stage 2's input: the analytic grains read the raw layer, not JSONL.
 *
 * `run.ts` used to walk `~/.claude/projects` directly. It now reads one or more
 * hosts' raw Parquet sets, which is what makes multi-machine work — you copy
 * each machine's directory next to the others and normalize across all of them
 * in one pass. Re-deriving the grains after a schema change no longer touches
 * the original JSONL at all, on any machine.
 *
 * The rows come back in file order (the writer emits them that way and Parquet
 * preserves it), which matters: `Normalizer` relies on within-file ordering to
 * pair tool results with their calls.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import type { Rec } from "./fields.ts";
import type { HostIdentity } from "./host.ts";
import type { FileKind, TranscriptFile } from "./scan.ts";

/** One host's raw directory: `raw.parquet`, `files.parquet`, `host.json`. */
export interface RawHostSet {
  dir: string;
  host: HostIdentity;
}

/**
 * Find every host set under `dir`. Accepts either a single host directory or a
 * parent holding several — so pointing at one machine's output and pointing at
 * a folder of synced machines both work without a flag.
 */
export async function findHostSets(dir: string): Promise<RawHostSet[]> {
  const readHost = async (d: string): Promise<RawHostSet | null> => {
    try {
      const host = JSON.parse(await readFile(path.join(d, "host.json"), "utf8")) as HostIdentity;
      return host?.hostId ? { dir: d, host } : null;
    } catch {
      return null;
    }
  };
  const self = await readHost(dir);
  if (self) return [self];
  const out: RawHostSet[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true }).catch(
    () => [],
  )) as import("node:fs").Dirent[]) {
    if (!e.isDirectory()) continue;
    const h = await readHost(path.join(dir, e.name));
    if (h) out.push(h);
  }
  return out.sort((a, b) => (a.host.hostId < b.host.hostId ? -1 : 1));
}

/**
 * One step of a host's replay — deliberately the same two events the JSONL path
 * produces, in the same interleaving: announce a file, then feed its records.
 *
 * The `file` event is not bookkeeping. `Normalizer.noteFile` is what registers a
 * session that produced nothing — a fork abandoned before its first turn is
 * exactly the row a timeline must draw to show the fork happened — and such a
 * file contributes no rows to `raw.parquet` at all. Driving the sequence from
 * `files.parquet` is what keeps it visible.
 */
export type HostItem =
  | { kind: "file"; file: TranscriptFile }
  | { kind: "record"; rec: Rec; file: TranscriptFile };

/**
 * Replay one host's raw set as the `Normalizer` expects to see it.
 *
 * The `TranscriptFile` is reconstructed from the raw columns rather than from
 * the filesystem — the original machine may not be this one, and its paths may
 * not exist here.
 */
export async function* readHostRecords(set: RawHostSet): AsyncGenerator<HostItem> {
  const read = async (name: string) => {
    const buf = await readFile(path.join(set.dir, name));
    return (await parquetReadObjects({
      file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    })) as Record<string, unknown>[];
  };

  // `files.parquet` is the authority on which files exist and how big they are.
  // `createdMs` in particular lives only here: the original machine's birthtimes
  // are gone once this artifact is copied, and `lineage.ts` needs them to place
  // a fork that produced no turns.
  const meta = new Map<string, { bytes: number; createdMs?: number }>();
  const order: string[] = [];
  for (const f of await read("files.parquet").catch(() => [])) {
    const rel = String(f.relPath ?? "");
    if (!rel.endsWith(".jsonl")) continue;
    order.push(rel);
    meta.set(rel, {
      bytes: Number(f.bytes ?? 0),
      ...(f.createdMs != null ? { createdMs: Number(f.createdMs) } : {}),
    });
  }

  const files = new Map<string, TranscriptFile>();
  const build = (relPath: string, row?: Record<string, unknown>): TranscriptFile => {
    const cached = files.get(relPath);
    if (cached) return cached;
    // agentId and workflowId are functions of the path, so they are rebuilt
    // here rather than stored — the same derivation `scan.ts` uses.
    const segs = relPath.split("/");
    const name = segs.at(-1) ?? "";
    const wf = segs.indexOf("workflows");
    const m = meta.get(relPath);
    const file: TranscriptFile = {
      path: relPath,
      projectSlug: String(row?.projectSlug ?? segs[0] ?? ""),
      fileSessionId: String(row?.fileSessionId ?? classifySessionId(segs)),
      kind: String(row?.fileKind ?? classifyKind(segs, name)) as FileKind,
      bytes: m?.bytes ?? 0,
      hostId: set.host.hostId,
      ...(m?.createdMs !== undefined ? { createdMs: m.createdMs } : {}),
      ...(name.startsWith("agent-")
        ? { agentId: name.slice("agent-".length, -".jsonl".length) }
        : {}),
      ...(wf >= 0 && segs[wf + 1] ? { workflowId: segs[wf + 1] } : {}),
    };
    files.set(relPath, file);
    return file;
  };

  // Walk the two lists in step. `order` is the full set of transcript files in
  // walk order; the rows cover only those with content. Emitting the announced
  // files that precede each row's file keeps the empty ones in their place.
  let next = 0;
  const announceUpTo = function* (relPath: string | null): Generator<HostItem> {
    while (next < order.length && order[next] !== relPath) {
      yield { kind: "file", file: build(order[next]) };
      next++;
    }
    if (relPath !== null && next < order.length) {
      yield { kind: "file", file: build(relPath) };
      next++;
    }
  };

  let current: string | null = null;
  for (const row of await read("raw.parquet")) {
    const relPath = String(row.relPath ?? "");
    if (relPath !== current) {
      // A file absent from `order` (an artifact written before files.parquet
      // listed it) still gets announced, just without size metadata.
      if (meta.has(relPath)) yield* announceUpTo(relPath);
      else yield { kind: "file", file: build(relPath, row) };
      current = relPath;
    }
    // A line that failed to parse has no record; it is preserved in the raw
    // layer for forensics but there is nothing for the analytics to count.
    const rec = row.rec;
    if (rec === null || typeof rec !== "object") continue;
    yield { kind: "record", rec: rec as Rec, file: build(relPath, row) };
  }
  yield* announceUpTo(null);
}

/** Mirrors `scan.ts`: the session id is the first path segment below the slug. */
const classifySessionId = (segs: string[]): string =>
  segs.length <= 2 ? (segs.at(-1) ?? "").replace(/\.jsonl$/, "") : segs[1];

const classifyKind = (segs: string[], name: string): string => {
  if (segs.length <= 2) return "session";
  if (name === "journal.jsonl") return "workflow-journal";
  if (segs.includes("workflows")) return "workflow-agent";
  if (segs.includes("subagents")) return "subagent";
  return "session";
};
