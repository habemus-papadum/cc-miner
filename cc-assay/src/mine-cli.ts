#!/usr/bin/env node
/**
 * `cc-assay mine` — the one command that produces a corpus the app can read.
 *
 *   pnpm -C cc-assay mine                    # → ~/.cache/cc-miner
 *   pnpm -C cc-assay mine --months 1         # trim to the last month
 *   pnpm -C cc-assay mine --to s3://bucket/cc --s3-profile personal
 *
 * Mining is two stages, and running only the first is the mistake this exists
 * to prevent:
 *
 *   normalize  transcripts → FLAT grains (`turns.parquet`, `sessions.parquet`)
 *   export     flat grains → the HIVE layout (`turns/username=…/host=…/…`)
 *
 * The app reads the Hive layout in BOTH data modes — the host globs
 * `<grain>/username=*​/host=*​/**​/*.parquet`, and local mode takes the grain name
 * from the first path segment. Point either at a flat corpus and it fails
 * obscurely: `no "turns" grain (it reported: … turns.parquet)`. The README used
 * to document `normalize --out <app>/src/data` as the quick start, which
 * produced exactly that and rendered nothing.
 *
 * So the two stages are chained here and the intermediate is put somewhere
 * deliberately unmistakable (`<corpus>/.staging`) rather than left where a
 * person might point the app at it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { corpusDir, stagingDir } from "./corpus-dir.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

if (has("help") || has("h")) {
  process.stdout.write(
    "usage: cc-assay mine [--to <dir|s3://…>] [--months <n>] [--s3-profile <p>]\n" +
      "                     [--offline] [--no-images] [--replay]\n" +
      "\n" +
      "  Runs normalize then export. Writes the Hive layout the app reads.\n" +
      `  Default destination: ${corpusDir()}\n` +
      "  Override with --to, or with PDUM_CC_MINER_CORPUS.\n",
  );
  process.exit(0);
}

const HERE = import.meta.dirname;
const to = arg("to") ?? corpusDir();
const staging = stagingDir();
mkdirSync(staging, { recursive: true });

/** Flags that belong to stage 1 rather than stage 2. */
const normalizeFlags = ["offline", "no-images", "replay", "quiet"].filter((f) => has(f));
const idleGap = arg("idle-gap");

console.log(`\n  cc-assay mine`);
console.log(`    staging → ${staging}`);
console.log(`    corpus  → ${to}\n`);

const run = (script: string, args: string[]) => {
  const r = spawnSync("npx", ["tsx", path.join(HERE, script), ...args], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("cli.ts", [
  "--out",
  staging,
  ...normalizeFlags.map((f) => `--${f}`),
  ...(idleGap ? ["--idle-gap", idleGap] : []),
]);

run("export-cli.ts", [
  "--from",
  staging,
  "--to",
  to,
  ...(arg("months") ? ["--months", String(arg("months"))] : []),
  ...(arg("s3-profile") ? ["--s3-profile", String(arg("s3-profile"))] : []),
  ...(arg("username") ? ["--username", String(arg("username"))] : []),
]);

console.log(`\n  corpus ready → ${to}`);
console.log(`  the app reads this by default; no --out, no copy into the repo.\n`);
