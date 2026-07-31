/**
 * duckdb-sidecar.mjs — the DuckDB host, running inside the packaged app.
 *
 * In a checkout you start the host yourself (`pnpm serve`). A shipped app has
 * no terminal, so the shell has to start it — and the interesting question is
 * *when*, because this app deliberately has no IPC between renderer and main.
 *
 * The answer falls out of the existing seam: the renderer asks
 * `GET /__duckdb-host` when, and only when, it is in host mode. So the Electron
 * mount of that lookup starts the sidecar on the way to answering it. No new
 * route, no `ipcRenderer`, and the lifetime is exactly right — a user who never
 * leaves local mode never pays for a DuckDB process.
 *
 * `utilityProcess` rather than `child_process`: it is a real Node runtime with
 * Electron's own binary, it dies with the app, and — measured — `@duckdb/node-api`
 * loads inside it as ESM with no rebuild (DuckDB v1.5.5, N-API, so ABI-stable
 * across Electron versions).
 *
 * The host program itself is UNCHANGED and unaware of Electron. That is the
 * point: `pnpm serve` and the packaged app run the same file, so there is one
 * host implementation to reason about rather than two that agree today.
 */
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";
import { corpusDir, hostPort, readHostRuntime, runtimeFile } from "../server/host-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = resolve(HERE, "..", "server", "duckdb-host.mjs");

/** How long to wait for the host to advertise itself before giving up. */
const BOOT_TIMEOUT_MS = 45_000;

/** @type {import("electron").UtilityProcess | null} */
let child = null;
/** @type {Promise<string | null> | null} */
let booting = null;

/**
 * Where the corpus lives — re-exported from the shared definition so the shell,
 * the DuckDB host, and the `/__corpus` route cannot disagree.
 *
 * It used to be `<userData>/corpus`, which was right about one thing and wrong
 * about another. Right: nothing may be written inside a `.app` bundle, which is
 * read-only and signed. Wrong: it was a THIRD location, known only to the
 * packaged shell — so host mode in the packaged app looked somewhere the miner
 * never writes and the renderer never reads. Caught by the smoke test the first
 * time it ran without a `PDUM_CC_MINER_CORPUS` override:
 *
 *     local  ✓ 69,915 marks, 37 charts
 *     host   ✗ no corpus found at ~/Library/Application Support/pdum-cc-miner/corpus
 *
 * `~/.cache/cc-miner` satisfies the real constraint (outside the bundle,
 * writable) without inventing a per-host path.
 *
 * @returns {string}
 */
export { corpusDir };

/** The arguments the host is started with, from the environment. */
function hostArgs() {
  const s3Prefix = process.env.PDUM_CC_MINER_S3_PREFIX;
  const s3Profile = process.env.PDUM_CC_MINER_S3_PROFILE;
  if (s3Prefix) {
    return ["--s3-prefix", s3Prefix, ...(s3Profile ? ["--s3-profile", s3Profile] : [])];
  }
  return ["--data", corpusDir()];
}

/**
 * Does the advertised endpoint accept a connection?
 *
 * @param {string} hostAndPort e.g. `127.0.0.1:54514`
 * @returns {Promise<boolean>}
 */
function accepts(hostAndPort) {
  const [host, port] = hostAndPort.split(":");
  return new Promise((res) => {
    const sock = createConnection({ host, port: Number(port) }, () => {
      sock.end();
      res(true);
    });
    sock.on("error", () => res(false));
    // Short: this runs on the lookup path, and a loopback port that has not
    // answered in 300 ms is not going to.
    sock.setTimeout(300, () => {
      sock.destroy();
      res(false);
    });
  });
}

/**
 * Is the advertised host actually reachable?
 *
 * A pid check ALONE is not an answer, and believing it was cost real time.
 * `process.kill(pid, 0)` proves *a* process exists — not that it is our sidecar,
 * and not that anything is listening. MEASURED: a sidecar died leaving its
 * runtime file behind, macOS recycled its pid onto a Helper process of the
 * installed app, and from then on every launch read `pid 12223 is alive`,
 * skipped the respawn, and handed the renderer port 54514 with nothing on it.
 * Two smoke runs failed that way, identically, against a file written the
 * previous day — and it presents as a renderer error three processes from the
 * cause, which is why it read as "the second navigation is flaky".
 *
 * So the socket is the authority. The pid check stays only as a cheap negative:
 * when the process is plainly gone there is no reason to wait on a connect.
 *
 * This is the read-side twin of `assertAccepting` in duckdb-host.mjs — that one
 * refuses to *advertise* an endpoint nothing answers on, this one refuses to
 * *believe* one.
 *
 * @returns {Promise<boolean>}
 */
async function hostIsLive() {
  const rt = readHostRuntime();
  if (!rt) return false;
  try {
    process.kill(rt.pid, 0);
  } catch {
    return false; // definitively gone; skip the socket
  }
  return accepts(hostPort(rt));
}

/**
 * Start the host if it is not already running. Idempotent, and safe to call
 * concurrently — overlapping callers await the same boot.
 *
 * @returns {Promise<string | null>} null on success, else a message for the user
 */
export function ensureHost() {
  // The latch is claimed SYNCHRONOUSLY, before any await. `hostIsLive` now
  // touches a socket, so checking it first and assigning `booting` afterwards
  // would leave a window in which two concurrent lookups both see no boot in
  // progress and both fork a sidecar. Claim first, then decide inside.
  if (booting) return booting;

  booting = (async () => {
    if (await hostIsLive()) {
      booting = null;
      return null;
    }
    return startHost();
  })();

  return booting;
}

/**
 * Fork the sidecar and wait for it to advertise itself.
 *
 * @returns {Promise<string | null>} null on success, else a message for the user
 */
function startHost() {
  return new Promise((done) => {
    const runtime = runtimeFile();
    const args = hostArgs();

    if (!process.env.PDUM_CC_MINER_S3_PREFIX && !existsSync(corpusDir())) {
      // Said before spawning, because DuckDB's own version of this complaint is
      // eight "file not found" errors and an empty app.
      booting = null;
      done(
        `no corpus found at ${corpusDir()}\n` +
          `Export one there with cc-assay, or set PDUM_CC_MINER_CORPUS to point at an existing corpus.`,
      );
      return;
    }

    let stderr = "";
    const proc = utilityProcess.fork(HOST_ENTRY, args, {
      stdio: "pipe",
      env: { ...process.env, PDUM_CC_MINER_HOST_RUNTIME: runtime },
    });
    child = proc;
    proc.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    proc.stdout?.on("data", (d) => process.stdout.write(`[duckdb-host] ${d}`));

    let settled = false;
    const finish = (/** @type {string | null} */ msg) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      booting = null;
      done(msg);
    };

    // Poll for the runtime file rather than have the host message us back. The
    // host must stay identical under `pnpm serve`, where there is no parent port
    // to post to — and the file is how every other reader finds it anyway, so
    // this waits on the real thing rather than on a proxy for it.
    //
    // `checking` guards re-entry: `hostIsLive` is async now, and without the
    // latch a slow connect would have overlapping probes stacking up every
    // 50 ms. Note also that `if (hostIsLive())` would be a bug rather than a
    // slow path — a pending promise is always truthy, so the boot would report
    // success on the first tick, every time.
    let checking = false;
    const poll = setInterval(async () => {
      if (checking || settled) return;
      checking = true;
      try {
        if (await hostIsLive()) finish(null);
      } finally {
        checking = false;
      }
    }, 50);

    const timer = setTimeout(
      () => finish(`the DuckDB host did not start within ${BOOT_TIMEOUT_MS / 1000}s`),
      BOOT_TIMEOUT_MS,
    );

    proc.on("exit", (code) => {
      if (child === proc) child = null;
      // A clean exit that never advertised is still a failure from here.
      finish(
        `the DuckDB host exited (code ${code})` +
          (stderr.trim() ? `:\n${stderr.trim().split("\n").slice(-8).join("\n")}` : ""),
      );
    });
  });
}

/** Stop the host, if we started one. */
export function stopHost() {
  child?.kill();
  child = null;
}

/** Wire the sidecar's lifetime to the app's. */
export function bindSidecarLifetime() {
  app.on("before-quit", stopHost);
  app.on("will-quit", stopHost);
}
