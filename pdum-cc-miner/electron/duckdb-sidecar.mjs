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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";
import { readHostRuntime, runtimeFile } from "../server/host-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = resolve(HERE, "..", "server", "duckdb-host.mjs");

/** How long to wait for the host to advertise itself before giving up. */
const BOOT_TIMEOUT_MS = 45_000;

/** @type {import("electron").UtilityProcess | null} */
let child = null;
/** @type {Promise<string | null> | null} */
let booting = null;

/**
 * Where a packaged app keeps the corpus it serves.
 *
 * Under `userData`, because everything inside a `.app` bundle is read-only and
 * signed — a corpus written there would break the signature even if the write
 * succeeded. `PDUM_CC_MINER_CORPUS` overrides it, which is how this gets tested
 * against a real corpus before the app can import one itself.
 *
 * @returns {string}
 */
export function corpusDir() {
  return process.env.PDUM_CC_MINER_CORPUS || join(app.getPath("userData"), "corpus");
}

/** The arguments the host is started with, from the environment. */
function hostArgs() {
  const s3Prefix = process.env.PDUM_CC_MINER_S3_PREFIX;
  const s3Profile = process.env.PDUM_CC_MINER_S3_PROFILE;
  if (s3Prefix) {
    return [
      "--s3-prefix",
      s3Prefix,
      ...(s3Profile ? ["--s3-profile", s3Profile] : []),
      ...(process.env.PDUM_CC_MINER_FLAT === "1" ? ["--flat"] : []),
    ];
  }
  return ["--data", corpusDir(), ...(process.env.PDUM_CC_MINER_FLAT === "1" ? ["--flat"] : [])];
}

/** Is the advertised host still the process we started, and still alive? */
function hostIsLive() {
  const rt = readHostRuntime();
  if (!rt) return false;
  try {
    // Signal 0 tests for existence without delivering anything. Guards the case
    // where the host was killed hard enough to skip its own cleanup and left a
    // stale runtime file behind — which would otherwise send every query to a
    // port nobody is listening on.
    process.kill(rt.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the host if it is not already running. Idempotent, and safe to call
 * concurrently — overlapping callers await the same boot.
 *
 * @returns {Promise<string | null>} null on success, else a message for the user
 */
export function ensureHost() {
  if (hostIsLive()) return Promise.resolve(null);
  if (booting) return booting;

  booting = new Promise((done) => {
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
    const poll = setInterval(() => {
      if (hostIsLive()) finish(null);
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

  return booting;
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
