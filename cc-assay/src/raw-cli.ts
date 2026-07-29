#!/usr/bin/env node
/**
 * `cc-assay raw` — stage 1. Ingest this machine's transcripts into a per-host
 * raw Parquet set.
 *
 *   pnpm -C apps/cc-assay raw -- --out ~/.cache/aiui/cc-raw
 *
 * The output directory is one host's artifact: `raw.parquet`, `files.parquet`
 * and `host.json`. It is meant to travel — copy several hosts' directories
 * together and stage 2 merges them.
 */

import { homedir } from "node:os";
import path from "node:path";
import { ingestCorpus } from "./raw-run.ts";
import { defaultRoots } from "./scan.ts";

const argv = process.argv.slice(2);
const roots: string[] = [];
let out = path.join(homedir(), ".cache", "aiui", "cc-raw", "local");
let quiet = false;

for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === "--out") out = path.resolve(argv[++i]);
  else if (k === "--root") roots.push(path.resolve(argv[++i]));
  else if (k === "--quiet") quiet = true;
  else if (k === "--help" || k === "-h") {
    process.stdout.write("usage: cc-assay raw [--out dir] [--root dir]... [--quiet]\n");
    process.exit(0);
  } else {
    // An unknown flag must not degrade into a default run: `--raw` being
    // silently ignored by the stage-2 CLI once sent a whole-corpus ingest
    // where a three-project one was asked for, and the numbers looked fine.
    process.stderr.write(`cc-assay raw: unknown argument ${k}\n`);
    process.exit(2);
  }
}

const t0 = Date.now();
const { host, stats, tables } = await ingestCorpus({
  roots: roots.length ? roots : defaultRoots(),
  out,
  ...(quiet
    ? {}
    : {
        onProgress: (root, s) =>
          process.stderr.write(`  ${root}: ${s.files} files, ${s.lines} lines\n`),
      }),
});

if (!quiet) {
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  const f = (n: number) => n.toLocaleString("en-US");
  process.stderr.write(`
RAW INGEST -> ${out}
  host                  ${host.hostname} (${host.hostId.slice(0, 8)}) ${host.platform}
  files scanned         ${f(stats.files)}   (${f(stats.jsonlFiles)} jsonl, ${f(stats.sidecarFiles)} sidecar)
  lines                 ${f(stats.lines)}   parse errors ${stats.parseErrors}
  source bytes          ${mb(stats.bytes)}

  raw.parquet           ${f(tables.raw.rows)} rows   ${mb(tables.raw.bytes)}
  files.parquet         ${f(tables.files.rows)} rows   ${mb(tables.files.bytes)}
  compression           ${((tables.raw.bytes / Math.max(1, stats.bytes)) * 100).toFixed(0)}% of source

${((Date.now() - t0) / 1000).toFixed(1)}s
`);
}
