/**
 * duckdb-host.mjs — the DuckDB process that answers cc-miner's queries.
 *
 * cc-miner does not query Parquet in the tab any more. A native DuckDB here
 * holds the data and answers over Quack (DuckDB's own HTTP remote protocol);
 * the renderer's duckdb-wasm is reduced to a protocol client. Why: `ATTACH`-ing
 * a remote catalog performs NO pushdown — a bare `count(*)` over a 272 MB table
 * moved 5.26 GB — while `quack_query`, which sends the SQL as a string, answered
 * the same query in 5 ms with ~0 bytes. Written up upstream, in pdum_aiui's
 * docs/guide/duckdb-mosaic.md.
 *
 * It is deliberately NOT Electron-specific. `pnpm dev` (browser) needs it just
 * as much as `pnpm dev:electron` does, so it is a plain Node program that either
 * host can spawn.
 *
 * ── Ports ────────────────────────────────────────────────────────────────────
 * `quack_serve` rejects port 0, so there is no OS-assigned port to ask for. We
 * therefore pick a free one HERE (bind, read, release) and hand quack the
 * number — but the port is never the thing anyone looks up. Discovery is the
 * runtime file this writes, for the reason recorded upstream in pdum_aiui's
 * docs/proposals/deployment-shapes.md §1.9: a hardcoded port does not fail
 * loudly when contended, it silently routes callers to whoever got there first.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { corpusDir, runtimeFile } from "./host-runtime.mjs";

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

/**
 * Connect to the URL quack says it is serving, and throw if nothing answers.
 *
 * Retries briefly: `quack_serve` returns as soon as it has started listening,
 * and on a loaded machine the accept loop can trail that by a few milliseconds.
 * A short poll distinguishes "not ready yet" from "not there at all"; without
 * one this would trade a late failure for a flaky early one.
 *
 * @param {string} listenUrl e.g. `http://127.0.0.1:51772`
 */
async function assertAccepting(listenUrl) {
  const { port, hostname } = new URL(listenUrl);
  let lastErr;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((res, rej) => {
        const sock = createConnection({ port: Number(port), host: hostname }, () => {
          sock.end();
          res(undefined);
        });
        sock.on("error", rej);
        sock.setTimeout(1000, () => {
          sock.destroy();
          rej(new Error("timed out connecting"));
        });
      });
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(
    `quack reported serving on ${listenUrl}, but nothing accepts a connection there ` +
      `(${lastErr instanceof Error ? lastErr.message : lastErr}). ` +
      `Refusing to advertise an endpoint the page cannot reach.`,
  );
}

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
  // `--data` wins; otherwise the shared corpus directory (~/.cache/cc-miner).
  // It used to default to `src/data` inside the checkout, which is why a corpus
  // ever lived in the repo at all — and `resolve(APP_ROOT, …)` still applies to
  // an explicit relative `--data`, so that flag behaves as it always did.
  const dataDir = arg("data") ? resolve(APP_ROOT, String(arg("data"))) : corpusDir();
  const s3Profile = arg("s3-profile") ?? null;
  const s3Prefix = arg("s3-prefix") ?? null;
  const flat = process.argv.includes("--flat");

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  for (const ext of EXTENSIONS) {
    // INSTALL reaches extensions.duckdb.org whenever the cache is cold, and
    // that includes a packaged build: `extension_directory` is set NOWHERE and
    // the .app bundles ZERO `.duckdb_extension` files (checked). A previous
    // version of this comment claimed the opposite — that packaged builds load
    // bundled copies — which was a plan, never an implementation, and would
    // have told a reader the app makes no network call when it does.
    //
    // MEASURED into a throwaway extension_directory: 62 MB, ~1.8 s cold on a
    // fast link, 23 ms warm. Fast here, minutes on a bad connection — and it
    // sits on the FIRST-QUERY path, which is why a CDN outage presents as a
    // data bug (DEPLOYMENT.md §5).
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

  // A BARRIER, not a health check — do not "simplify" it away.
  //
  // The runtime file below is the only way the renderer learns the endpoint, so
  // writing it is the act of advertising. `quack_serve` returning a row says it
  // STARTED, not that its accept loop is running yet, and the old sequence
  // advertised immediately: file written -> ensureHost() resolves ->
  // /__duckdb-host answers -> the page fires its first query. A query landing
  // inside that gap is refused on a port that is entirely correct.
  //
  // MEASURED in the field, and it explains what looked contradictory: the host
  // logged `quack on http://127.0.0.1:51373`, the page was told 51373, and the
  // renderer still reported `net::ERR_CONNECTION_REFUSED`. Nothing was
  // mismatched; the listener was not accepting yet. It reproduced only on a
  // machine busy enough to widen the window — first launch of a freshly
  // installed bundle, with Gatekeeper verifying 500 MB — which is exactly why
  // it never appeared in the smoke test or a hand probe, both of which happen
  // to wait long enough.
  //
  // Gating the advertisement on a real connection closes it. The failure also
  // now lands here, where the reason is still in hand, instead of in a worker
  // three processes away.
  const listening = String(row.listen_url);
  await assertAccepting(listening);

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
