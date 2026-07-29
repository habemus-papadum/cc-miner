/**
 * host-runtime.mjs — how anything finds the DuckDB host.
 *
 * ONE route, `GET /__duckdb-host`, mounted in three places:
 *
 *   `pnpm dev`       Vite dev server        → server/vite-plugin.ts
 *   `pnpm preview`   Vite preview server    → server/vite-plugin.ts
 *   the packaged app Electron `app://`      → electron/app-scheme.mjs
 *
 * ── Why there is no `/quack` proxy any more ──────────────────────────────────
 * There used to be one, to keep the host's port out of the client. It could not
 * survive the packaged app, and the reason is worth recording because it is a
 * design lesson rather than a bug: the client built its endpoint as
 * `quack:${location.host}/quack`. Under `http://localhost:5191` that is right.
 * Under `app://pdum-cc-miner/` it becomes `quack:cc-miner/quack` — a hostname DuckDB
 * dials over TCP, never touching the custom scheme. The renderer was **deriving
 * an assumption about its own origin**, and the assumption was false in one
 * host. It failed by hanging with no request and no error.
 *
 * So the origin now TELLS the page where the data is, and the page uses it
 * verbatim. Measured, and the reason the proxy is not merely relocated:
 * `quack_serve` answers `OPTIONS` with `access-control-allow-origin: *`,
 * `-headers: *`, `-methods: GET, POST, OPTIONS`, so a direct cross-origin POST
 * works from an http page, from `app://`, and from inside a worker via the
 * synchronous XHR duckdb-wasm actually uses.
 *
 * The port still appears in no client code. It arrives from a lookup — which is
 * exactly what deployment-shapes.md §1.9 asks for. What it warns against is a
 * *hardcoded* port, which fails silently when contended.
 *
 * Plain `.mjs`, not TypeScript, for one reason: the Electron main process runs
 * this file as-is out of a packaged bundle, where there is no transpiler. The
 * types are JSDoc so `tsconfig.node.json` still checks it.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the host advertises itself.
 *
 * Defaults to the app directory, which is right for a checkout and wrong for a
 * packaged app — inside a `.app` bundle that path is read-only. The packaged
 * shell therefore sets `PDUM_CC_MINER_HOST_RUNTIME` to a file under `userData` and
 * passes the same value to the sidecar it spawns, so both ends of the lookup
 * agree by construction rather than by coincidence.
 *
 * A FUNCTION, not a constant, and that is load-bearing. ESM evaluates imports
 * before the importing module's body, so a constant here would be frozen from
 * the environment before `electron/main.mjs` ever got to set it — and the shell
 * cannot know `userData` any earlier. Read it per call and the ordering
 * question disappears instead of being something to remember.
 *
 * @returns {string}
 */
export function runtimeFile() {
  return (
    process.env.PDUM_CC_MINER_HOST_RUNTIME || resolve(HERE, "..", ".aiui-cache/duckdb-host.json")
  );
}

/**
 * @typedef {object} HostRuntime
 * @property {number} port
 * @property {string} token
 * @property {number} pid
 * @property {string} url
 * @property {{kind: "local" | "s3", [k: string]: unknown}} source
 * @property {string} replayBase
 * @property {unknown} manifest
 * @property {unknown} replayIndex
 * @property {string[]} grains
 * @property {string[]} missing
 * @property {string} startedAt
 */

/**
 * The host's advertisement, or null.
 *
 * Read PER REQUEST, deliberately. It makes start order irrelevant: the page's
 * origin can come up first and answer `{ ok: false }` until a host appears, and
 * a host restart (new port, new token) is picked up with nothing to invalidate.
 *
 * @returns {HostRuntime | null}
 */
export function readHostRuntime() {
  try {
    return JSON.parse(readFileSync(runtimeFile(), "utf8"));
  } catch {
    return null;
  }
}

/** What `GET /__duckdb-host` answers. */
export function hostInfo() {
  const rt = readHostRuntime();
  if (!rt) {
    return {
      ok: false,
      error:
        "no DuckDB host is running — start it with `pnpm serve` (or `pnpm serve --flat` for the legacy flat data layout)",
    };
  }
  return {
    ok: true,
    token: rt.token,
    // The endpoint, stated rather than derived. `127.0.0.1` and not `localhost`
    // deliberately: `localhost` may resolve to ::1 first, and quack_serve is
    // bound to the IPv4 loopback only.
    quackUri: `quack:127.0.0.1:${rt.port}/quack`,
    grains: rt.grains,
    missing: rt.missing,
    source: rt.source,
    replayBase: rt.replayBase,
    manifest: rt.manifest,
    replayIndex: rt.replayIndex,
  };
}

/**
 * Mount the lookup route on a Connect-style middleware stack.
 *
 * The Node `(req, res)` adapter, used by BOTH Vite servers. Electron has its
 * own because `protocol.handle` speaks web `Request`/`Response` — the adapters
 * differ, the answer they serve does not.
 *
 * @param {{use: (path: string, fn: (req: unknown, res: import("node:http").ServerResponse) => void) => unknown}} stack
 */
export function mountHostRoutes(stack) {
  stack.use("/__duckdb-host", (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(hostInfo()));
  });
}
