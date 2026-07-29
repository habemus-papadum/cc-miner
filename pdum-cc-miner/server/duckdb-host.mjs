/**
 * duckdb-host.mjs — the DuckDB process that answers cc-miner's queries.
 *
 * cc-miner does not query Parquet in the tab any more. A native DuckDB here
 * holds the data and answers over Quack (DuckDB's own HTTP remote protocol);
 * the renderer's duckdb-wasm is reduced to a protocol client. Why: `ATTACH`-ing
 * a remote catalog performs NO pushdown — a bare `count(*)` over a 272 MB table
 * moved 5.26 GB — while `quack_query`, which sends the SQL as a string, answered
 * the same query in 5 ms with ~0 bytes. See docs/guide/duckdb-mosaic.md.
 *
 * It is deliberately NOT Electron-specific. `pnpm dev` (browser) needs it just
 * as much as `pnpm dev:electron` does, so it is a plain Node program that either
 * host can spawn.
 *
 * ── Ports ────────────────────────────────────────────────────────────────────
 * `quack_serve` rejects port 0, so there is no OS-assigned port to ask for. We
 * therefore pick a free one HERE (bind, read, release) and hand quack the
 * number — but the port is never the thing anyone looks up. Discovery is the
 * runtime file this writes, for the reason recorded in
 * docs/proposals/deployment-shapes.md §1.9: a hardcoded port does not fail
 * loudly when contended, it silently routes callers to whoever got there first.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { runtimeFile } from "./host-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");

// Where the host advertises itself. Deliberately resolved by the SHARED helper
// rather than declared here: the readers (Vite's middleware, the packaged app's
// scheme handler) and this writer must agree on one path, and a packaged app
// overrides it by env — so the agreement has to come from one function, not
// from two matching literals. Read the file; never assume a port.
//
// Resolved once, here, because this is a standalone process: whatever env it
// was started with is the env it dies with.
export const RUNTIME_FILE = runtimeFile();

/** Extensions the host needs. `quack` serves; `httpfs`+`aws` reach S3. */
const EXTENSIONS = ["quack", "httpfs", "aws"];

/** Ask the OS for a free port, then release it for quack to claim. */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") {
        s.close(() => rej(new Error("net server reported no numeric address")));
        return;
      }
      s.close(() => res(addr.port));
    });
  });
}

/**
 * A `--name value` argument, or undefined.
 *
 * @param {string} name
 * @returns {string | undefined}
 */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

/**
 * The message of an unknown throw. `catch (e)` gives `unknown`, and every place
 * this is used wants the same thing: something printable.
 *
 * @param {unknown} e
 * @returns {string}
 */
function errText(e) {
  return String(e instanceof Error ? e.message : e);
}

/**
 * The grains the normaliser writes. Kept in step with cc-assay; a grain whose
 * files are absent simply yields an empty view rather than failing the boot.
 */
const GRAINS = [
  "turns",
  "toolCalls",
  "events",
  "sessions",
  "images",
  "forkEdges",
  "agentRuns",
  "lineages",
];

/**
 * The partition layout, in one place. `username` and `host` are partition KEYS,
 * not columns — the corpus is multi-machine from day one, so a read has to be
 * able to say "everyone" or "just me" without two code paths.
 */
export const LAYOUT_GLOB = "/username=*/host=*/**/*.parquet";

/** Legacy flat layout: `<dir>/<grain>.parquet`, what src/data holds today. */
const FLAT_GLOB = ".parquet";

async function main() {
  const dataDir = resolve(APP_ROOT, arg("data") ?? "src/data");
  const s3Profile = arg("s3-profile") ?? null;
  const s3Prefix = arg("s3-prefix") ?? null;
  const flat = process.argv.includes("--flat");

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  for (const ext of EXTENSIONS) {
    // INSTALL reaches extensions.duckdb.org on first run. A packaged build sets
    // extension_directory to the bundled copies and skips this (verified: with
    // autoinstall/autoload off, LOAD alone works from a bundled directory).
    await conn.run(`INSTALL ${ext}`).catch(() => {});
    await conn.run(`LOAD ${ext}`);
  }

  if (s3Profile) {
    // One statement is the entire AWS integration — no SDK, no credential
    // plumbing. `credential_chain` honours SSO profiles, so an expired session
    // surfaces here as a clear error rather than a cryptic S3 failure later.
    // CHAIN is NOT optional — the default chain has no SSO step and an SSO
    // profile fails outright at CREATE. Naming all three sources covers env
    // vars, the SSO cache, and static ~/.aws/credentials profiles alike.
    await conn.run(
      `CREATE OR REPLACE SECRET cc_s3 (TYPE s3, PROVIDER credential_chain, ` +
        `CHAIN 'env;sso;config', PROFILE '${s3Profile}')`,
    );
  }

  const base = s3Prefix ?? dataDir;
  /** @type {{grain: string, err: string}[]} */
  const failures = [];
  for (const grain of GRAINS) {
    const src = flat ? `${base}/${grain}${FLAT_GLOB}` : `${base}/${grain}${LAYOUT_GLOB}`;
    const sql =
      `CREATE OR REPLACE VIEW "${grain}" AS SELECT * FROM ` +
      `read_parquet('${src}', hive_partitioning=true, union_by_name=true)`;
    try {
      await conn.run(sql);
    } catch (e) {
      // A missing grain is normal — the normaliser grew some of these late, and
      // a checkout with older data should still boot. Record, do not fail.
      failures.push({ grain, err: errText(e).split("\n")[0] });
    }
  }

  // A missing grain is normal; ALL of them missing is not — it means the path
  // is wrong, or empty, or the layout does not match. Booting anyway would put
  // the app in front of eight empty views, which reads as "you have no usage"
  // rather than "I looked in the wrong place". This distinction only started
  // mattering when the app began spawning its own host, where nobody is
  // watching a terminal for the per-grain warnings.
  if (failures.length === GRAINS.length) {
    throw new Error(
      `no corpus at ${base} — all ${GRAINS.length} grains failed to open.\n` +
        `  expected ${base}/<grain>${flat ? FLAT_GLOB : LAYOUT_GLOB}\n` +
        `  first error: ${failures[0]?.err}`,
    );
  }

  // The manifest is JSON, not a grain, and it must come from the SAME source as
  // the data — otherwise an S3-backed app silently reports the local checkout's
  // provenance. read_text works identically on a directory and an s3:// key.
  let manifest = null;
  try {
    const r = await conn.runAndReadAll(`SELECT content FROM read_text('${base}/manifest.json')`);
    manifest = JSON.parse(String(r.getRowObjects()[0]?.content ?? "null"));
  } catch {
    /* a corpus without a manifest is legal; the app shows no provenance line */
  }

  // Same reasoning as the manifest: the replay index has to describe the corpus
  // being served, not whatever happens to be in the local checkout.
  let replayIndex = null;
  try {
    const r = await conn.runAndReadAll(
      `SELECT content FROM read_text('${base}/replay/index.json')`,
    );
    replayIndex = JSON.parse(String(r.getRowObjects()[0]?.content ?? "null"));
  } catch {
    /* a corpus built without --replay; the panel says so */
  }

  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  const served = await conn.runAndReadAll(
    `SELECT * FROM quack_serve('quack:127.0.0.1:${port}', token => '${token}', disable_ssl => true)`,
  );
  const row = served.getRowObjects()[0];

  mkdirSync(dirname(RUNTIME_FILE), { recursive: true });
  const runtime = {
    port,
    token,
    pid: process.pid,
    url: String(row.listen_url),
    source: s3Prefix
      ? { kind: "s3", prefix: s3Prefix, profile: s3Profile }
      : { kind: "local", dataDir },
    // Where per-session replay Parquet lives. The page cannot know this — the
    // base differs between a local checkout and an S3 prefix — so the host
    // advertises it and the page appends `<sessionId>.parquet`.
    replayBase: `${base}/replay`,
    manifest,
    replayIndex,
    grains: GRAINS.filter((g) => !failures.some((f) => f.grain === g)),
    missing: failures.map((f) => f.grain),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(RUNTIME_FILE, `${JSON.stringify(runtime, null, 2)}\n`);

  console.log(`[duckdb-host] quack on ${row.listen_url}`);
  console.log(`[duckdb-host] source: ${runtime.source.kind} ${base}`);
  console.log(`[duckdb-host] grains: ${runtime.grains.join(", ") || "(none)"}`);
  if (failures.length) console.log(`[duckdb-host] absent: ${runtime.missing.join(", ")}`);
  console.log(`[duckdb-host] runtime: ${RUNTIME_FILE}`);

  const bye = () => {
    rmSync(RUNTIME_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  process.on("exit", () => rmSync(RUNTIME_FILE, { force: true }));
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  const msg = String(e?.message ?? e);
  console.error("[duckdb-host] failed:", msg);
  // Same ambiguity as the exporter: DuckDB reports an expired SSO session and a
  // bad profile name with the identical "Secret Validation Failure", so name
  // both rather than guessing.
  if (/Secret Validation Failure|credential_chain/i.test(msg)) {
    const p = process.argv[process.argv.indexOf("--s3-profile") + 1] ?? "<profile>";
    console.error(
      `\n  AWS credentials for profile '${p}' could not be resolved. Check both:\n` +
        `    • expired SSO session  →  aws sso login --profile ${p}\n` +
        `    • wrong/missing profile in ~/.aws/config\n` +
        `  Confirm with: aws sts get-caller-identity --profile ${p}\n`,
    );
  }
  process.exit(1);
});
