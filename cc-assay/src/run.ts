/**
 * The end-to-end run: scan every transcript root, normalize, check invariants.
 *
 * Kept separate from `cli.ts` so tests can drive a full corpus pass without
 * spawning a process, and separate from `normalize.ts` so that module stays
 * filesystem-free.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InvariantResult, Normalized, NormalizeStats } from "./normalize.ts";
import { checkInvariants, Normalizer } from "./normalize.ts";
import type { PriceTable } from "./pricing.ts";
import { LITELLM_URL, tableFromJson } from "./pricing.ts";
import { findHostSets, readHostRecords } from "./raw-source.ts";
import { ReplayBuilder } from "./replay.ts";
import { defaultRoots, findTranscripts, readRecords } from "./scan.ts";

export interface RunOptions {
  /**
   * Directory holding one or more hosts' raw sets (stage 1 output). When set,
   * the grains are derived from the raw layer rather than from JSONL — which is
   * what makes multi-machine work, and what makes a schema change cost a
   * re-derive rather than a re-read on every machine.
   */
  rawDir?: string;
  /** Legacy single-machine path: walk the filesystem directly. */
  roots?: string[];
  pricing: PriceTable;
  idleGapSeconds?: number;
  skipImages?: boolean;
  /**
   * Also build the replay grain — one row per conversational block, keeping the
   * message bodies the analytic grains drop. Off by default because it roughly
   * doubles the run's memory: the grains hold ~30k turns, replay holds ~500k
   * blocks with their text.
   */
  replay?: boolean;
  onProgress?: (files: number, records: number) => void;
}

export interface RunResult {
  normalized: Normalized;
  invariants: InvariantResult;
  stats: NormalizeStats;
  rootsUsed: string[];
  /** Present only when `replay` was requested. */
  replay?: ReadonlyMap<string, import("./replay.ts").ReplayRow[]>;
}

/**
 * Load the LiteLLM price table, refreshing at most once a day.
 *
 * Cached to a local file so a run is reproducible offline and so the exact
 * table that produced a number can be archived beside the Parquet. The cache
 * mtime IS the `pricingVersion` stamped into every row.
 */
export async function loadPriceTable(
  cacheFile: string,
  opts: { maxAgeMs?: number; offline?: boolean } = {},
): Promise<PriceTable> {
  const maxAgeMs = opts.maxAgeMs ?? 864e5;
  let fresh = false;
  try {
    fresh = Date.now() - (await stat(cacheFile)).mtimeMs < maxAgeMs;
  } catch {
    /* no cache yet */
  }
  if (!fresh && !opts.offline) {
    try {
      const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const text = await res.text();
        JSON.parse(text); // fail before overwriting a good cache
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, text);
      }
    } catch (e) {
      process.stderr.write(
        `WARN  pricing refresh failed (${(e as Error).message}); using cached table\n`,
      );
    }
  }
  const json = JSON.parse(await readFile(cacheFile, "utf8"));
  const version = (await stat(cacheFile)).mtime.toISOString();
  return tableFromJson(json, version);
}

export async function normalizeCorpus(options: RunOptions): Promise<RunResult> {
  if (options.rawDir) return normalizeFromRaw(options, options.rawDir);
  const roots = options.roots ?? defaultRoots();
  const n = new Normalizer({
    pricing: options.pricing,
    idleGapSeconds: options.idleGapSeconds,
    skipImages: options.skipImages,
  });
  const replay = options.replay ? new ReplayBuilder() : null;
  const seen = new Set<string>();
  for (const root of roots) {
    for await (const file of findTranscripts(root)) {
      // Two configured roots can resolve to the same directory; reading a file
      // twice would not break dedup, but it would inflate the file/byte stats.
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      n.noteFile(file);
      for await (const rec of readRecords(file.path, () => n.noteParseError())) {
        n.add(rec, file);
        replay?.add(rec, file);
      }
      options.onProgress?.(n.stats.files, n.stats.records);
    }
  }
  const normalized = n.finish();
  return {
    normalized,
    invariants: checkInvariants(normalized),
    stats: normalized.stats,
    rootsUsed: roots,
    ...(replay ? { replay: replay.sessions } : {}),
  };
}

/**
 * Derive the grains from one or more hosts' raw sets.
 *
 * Every host is fed into a single `Normalizer`, so cross-host dedup happens for
 * free: the same session synced from two machines collapses on `billingKey`
 * exactly as a fork copy does within one machine.
 */
async function normalizeFromRaw(options: RunOptions, rawDir: string): Promise<RunResult> {
  const sets = await findHostSets(rawDir);
  if (sets.length === 0) {
    throw new Error(`no host sets under ${rawDir} — run \`cc-assay raw\` first`);
  }
  const n = new Normalizer({
    pricing: options.pricing,
    idleGapSeconds: options.idleGapSeconds,
    skipImages: options.skipImages,
  });
  const replay = options.replay ? new ReplayBuilder() : null;
  for (const set of sets) {
    let seen = 0;
    // The same two-event loop the JSONL path runs, so a file with no readable
    // records is still registered as a file.
    for await (const item of readHostRecords(set)) {
      if (item.kind === "file") n.noteFile(item.file);
      else {
        n.add(item.rec, item.file);
        replay?.add(item.rec, item.file);
      }
      if (++seen % 20000 === 0) options.onProgress?.(n.stats.files, n.stats.records);
    }
    options.onProgress?.(n.stats.files, n.stats.records);
  }
  const normalized = n.finish();
  return {
    normalized,
    invariants: checkInvariants(normalized),
    stats: normalized.stats,
    rootsUsed: sets.map((s) => `${s.host.hostname}:${s.dir}`),
    ...(replay ? { replay: replay.sessions } : {}),
  };
}
