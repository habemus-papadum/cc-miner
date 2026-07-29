#!/usr/bin/env node
/**
 * `cc-assay` — scan Claude Code transcripts, write the five Parquet tables.
 *
 *   pnpm -C apps/cc-assay normalize                    # → ./out
 *   pnpm -C apps/cc-assay normalize -- --out ../cc-miner/src/data
 *   pnpm -C apps/cc-assay normalize -- --offline --no-images
 *
 * Prints the measurements that justify the pipeline (how wrong a naive reader
 * would be) and runs `checkInvariants` every time — a silent regression in the
 * dedup path is exactly the failure this tool exists to prevent.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeParquet, writeReplay } from "./parquet.ts";
import { loadPriceTable, normalizeCorpus } from "./run.ts";
import { defaultRoots } from "./scan.ts";

interface Args {
  out: string;
  /** Derive from a raw host set (stage 1) instead of walking the filesystem. */
  rawDir?: string;
  replay?: boolean;
  roots?: string[];
  offline: boolean;
  images: boolean;
  idleGapSeconds: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    out: path.join(process.cwd(), "out"),
    offline: false,
    images: true,
    idleGapSeconds: 1800,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--out") a.out = path.resolve(argv[++i]);
    else if (k === "--raw") a.rawDir = path.resolve(argv[++i]);
    else if (k === "--root") {
      a.roots ??= [];
      a.roots.push(path.resolve(argv[++i]));
    } else if (k === "--offline") a.offline = true;
    else if (k === "--no-images") a.images = false;
    else if (k === "--idle-gap") a.idleGapSeconds = Number(argv[++i]);
    else if (k === "--replay") a.replay = true;
    else if (k === "--quiet") a.quiet = true;
    else if (k === "--help" || k === "-h") {
      process.stdout.write(
        "usage: cc-assay [--out dir] [--raw dir | [--root dir]...] [--offline]\n" +
          "                [--no-images] [--idle-gap seconds] [--quiet]\n" +
          "\n" +
          "  --raw     read the stage-1 raw layer (all hosts found under dir)\n" +
          "  --replay  also write replay/<sessionId>.parquet (message bodies)\n" +
          "  --root    read JSONL directly; repeatable; defaults to this machine's\n",
      );
      process.exit(0);
    } else {
      // Never fall through silently. An unrecognised flag once meant `--raw`
      // was ignored and the run quietly read the whole live corpus instead of
      // the frozen subset it was pointed at — the numbers looked plausible and
      // the mistake showed up only as a failed equivalence check.
      process.stderr.write(`cc-assay: unknown argument ${k}\n`);
      process.exit(2);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const log = (s: string) => {
  if (!args.quiet) process.stderr.write(`${s}\n`);
};
const fmt = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => `$${n.toFixed(2)}`;
const pctMore = (a: number, b: number) => `${((a / b - 1) * 100).toFixed(1)}%`;

const t0 = Date.now();
const cacheFile = path.join(import.meta.dirname, "..", ".cache", "litellm-pricing.json");
const pricing = await loadPriceTable(cacheFile, { offline: args.offline });
log(`pricing: ${Object.keys(pricing.entries).length} models @ ${pricing.version}`);

// Where the records come from: the stage-1 raw layer (every host under one
// directory) or this machine's JSONL. Log which one, because the two produce
// the same table shapes and a mix-up is invisible in the output.
const roots = args.roots ?? defaultRoots();
const source = args.rawDir
  ? { kind: "raw" as const, rawDir: args.rawDir }
  : { kind: "jsonl" as const, roots };
log(args.rawDir ? `source:  raw @ ${args.rawDir}` : `source:  jsonl @ ${roots.join(", ")}`);

const { normalized, invariants, stats, replay } = await normalizeCorpus({
  ...(args.rawDir ? { rawDir: args.rawDir } : {}),
  roots,
  pricing,
  idleGapSeconds: args.idleGapSeconds,
  skipImages: !args.images,
  ...(args.replay ? { replay: true } : {}),
  onProgress: (files, records) => {
    if (files % 50 === 0) log(`  …${files} files, ${fmt(records)} records`);
  },
});

const written = await writeParquet(args.out, normalized, { mkdir, stat }, path.join);
const replayOut = replay
  ? await writeReplay(args.out, replay, { mkdir, stat, writeFile }, path.join)
  : undefined;

// A manifest beside the Parquet: what produced these numbers, and when. The
// demo reads it to label its own figures honestly.
const manifest = {
  $schema: "aiui/cc-usage-manifest@1",
  generatedAt: new Date().toISOString(),
  source,
  pricing: { source: pricing.source, version: pricing.version },
  tables: written,
  ...(replayOut ? { replay: replayOut } : {}),
  stats,
  invariants,
};
await writeFile(path.join(args.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (!args.quiet) {
  process.stderr.write(`
CORPUS
  files                       ${fmt(stats.files)}  (${(stats.bytes / 1e6).toFixed(0)} MB)
  records                     ${fmt(stats.records)}   parse errors ${stats.parseErrors}
  assistant records           ${fmt(stats.assistantRecords)}
  deduped turns               ${fmt(stats.dedupedTurns)}   (${(stats.assistantRecords / Math.max(1, stats.dedupedTurns)).toFixed(2)}x records per response)

DEDUP EARNED ITS KEEP
  naive output-token sum      ${fmt(stats.naiveOutputTokens)}
  deduped                     ${fmt(stats.dedupedOutputTokens)}
  naive overstates by         ${pctMore(stats.naiveOutputTokens, Math.max(1, stats.dedupedOutputTokens))}
  message.ids in >1 file      ${fmt(stats.crossFileDuplicates)}   (fork/resume copies)
  groups w/ partial usage     ${fmt(stats.groupsWithVaryingOutput)}   (final record carries the real output)
  records marked inherited    ${fmt(stats.inheritedTurnsSeen)}   (session_id != sessionId)

FORK LINEAGE
  session files               ${fmt(stats.sessionFiles)}   (${fmt(stats.sessionFilesWithoutMarker)} predate the session_id marker)
  fork edges                  ${fmt(stats.forkEdges)}   (${stats.forkEdgesFromMarker} confirmed by marker, ${stats.forkEdgesAmbiguous} decided by file creation order)
  lineages                    ${fmt(stats.lineages)}   max depth ${stats.maxForkDepth}
  turns re-attributed         ${fmt(stats.reattributedTurns)}   (would have been credited to the file that merely carried them)
  forks left unresolved       ${stats.unresolvedForks}
  agent runs                  ${fmt(stats.agentRuns)}

TABLES → ${args.out}
${Object.entries(written)
  .map(
    ([k, v]) =>
      `  ${k.padEnd(12)} ${String(fmt(v.rows)).padStart(8)} rows  ${(v.bytes / 1024).toFixed(0)} KB`,
  )
  .join("\n")}

DERIVED COST                  ${usd(stats.totalCost)}   (${pricing.source} @ ${pricing.version})
  unpriced turns              ${stats.unpricedTurns}
  turns without a timestamp   ${stats.turnsWithoutTimestamp}

${
  replayOut
    ? `REPLAY → ${args.out}/replay/
  sessions                    ${fmt(replayOut.sessions)}
  blocks                      ${fmt(replayOut.rows)}   ${(replayOut.bytes / 1e6).toFixed(1)} MB total
`
    : ""
}
INVARIANTS                    ${invariants.ok ? "ok" : "FAILED"}
${invariants.problems.map((p) => `  ✗ ${p}`).join("\n")}

${((Date.now() - t0) / 1000).toFixed(1)}s
`);
}

process.exit(invariants.ok ? 0 : 1);
