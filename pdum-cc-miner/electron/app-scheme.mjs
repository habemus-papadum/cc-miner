/**
 * app-scheme.mjs — serving the BUILT renderer inside the packaged app.
 *
 * The dev shell points a window at a Vite server. There is no Vite in a shipped
 * app, so something has to answer the two things Vite was answering: static
 * assets out of `dist/`, and `GET /__duckdb-host`.
 *
 * Two ways to do that, and the choice matters:
 *
 *   a loopback HTTP server   the most literal parity with dev — a real http
 *                            origin — but it opens a port that ANY local
 *                            process can reach, and what sits behind it is a
 *                            lookup handing out a token for your whole corpus.
 *   a custom `app://` scheme this. No port, nothing outside the process can
 *                            address it, and Chromium still treats it as a
 *                            proper secure origin.
 *
 * So: `app://pdum-cc-miner/`. The renderer cannot tell the difference — it asks
 * `/__duckdb-host` on its own origin either way, and is TOLD where the data is
 * rather than deriving it. That last part is not cosmetic: deriving the
 * endpoint from `location.host` is precisely what broke this app under
 * `app://`, and the fix lives in server/host-runtime.mjs.
 *
 * The privilege flags are load-bearing, not boilerplate:
 *   standard        a real origin — without it there is no origin, and workers,
 *                   localStorage and relative URLs all behave differently
 *   secure          a secure context: `crypto.subtle`, and WASM treated as it is
 *                   over https
 *   supportFetchAPI `fetch()` may target the scheme at all
 *   stream          a 36 MB wasm response can stream instead of buffering
 *   corsEnabled     the page may make cross-origin requests (DuckDB fetches its
 *                   own extensions from extensions.duckdb.org on first query)
 */
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { hostInfo } from "../server/host-runtime.mjs";
import { ensureHost } from "./duckdb-sidecar.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the built renderer lives, in BOTH shapes.
 *
 * Resolved from this module rather than from `app.getAppPath()` because the two
 * disagree: unpackaged, this file is `<app>/electron/app-scheme.mjs`; packaged,
 * it is the same path inside `app.asar`, which `fs` reads through transparently.
 * `../dist` is correct in both, so there is one expression rather than a branch.
 */
export const DIST = resolve(HERE, "..", "dist");

/** The scheme and host the packaged renderer is served from. */
export const APP_ORIGIN = "app://pdum-cc-miner";

/**
 * Content types we must get right, keyed by extension.
 *
 * Not decoration: `WebAssembly.instantiateStreaming` REJECTS a response whose
 * type is not exactly `application/wasm`, and it fails at DuckDB's first query
 * rather than at load, which reads as a data bug rather than a MIME bug.
 *
 * @type {Record<string, string>}
 */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".parquet": "application/vnd.apache.parquet",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

/** @param {string} p */
function contentType(p) {
  const dot = p.lastIndexOf(".");
  return (dot >= 0 && TYPES[p.slice(dot).toLowerCase()]) || "application/octet-stream";
}

/**
 * Resolve a URL path to a file inside DIST, or null if it escapes.
 *
 * The guard is by RESOLVED PREFIX, not by scanning for `..`. A blocklist of
 * suspicious substrings loses to encoding; asking the path resolver where the
 * path actually lands does not.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
export function resolveAsset(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const abs = normalize(join(DIST, rel));
  if (abs !== DIST && !abs.startsWith(DIST + sep)) return null;
  return abs;
}

/**
 * Register the scheme's privileges. MUST be called before `app.whenReady()` —
 * Chromium fixes a scheme's capabilities at startup, and a late call is not an
 * error, it is silently ignored, leaving a scheme with no origin.
 */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Serve the built app, plus the host lookup. Call after `app.whenReady()`.
 *
 * This is the THIRD mount of that lookup (dev server, preview server, here),
 * and the only one that is not Connect-shaped — `protocol.handle` speaks web
 * `Request`/`Response`. The adapter differs; the answer does not, because both
 * call `hostInfo()` in server/host-runtime.mjs.
 */
export function serveApp() {
  protocol.handle("app", async (req) => {
    const { pathname } = new URL(req.url);
    if (process.env.PDUM_CC_MINER_TRACE_SCHEME === "1")
      console.error(`[scheme] ${req.method} ${pathname}`);

    if (pathname === "/__duckdb-host") {
      // Starting the host HERE is what removes the need for IPC. The renderer
      // asks this question only in host mode, so the sidecar's lifetime is
      // already exactly the lifetime we want, with no signal to invent.
      const failure = await ensureHost();
      const body = failure ? { ok: false, error: failure } : hostInfo();
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    }

    // No `/quack` route here. The page talks to the DuckDB host directly, at the
    // address `/__duckdb-host` gave it — see the note in server/host-runtime.mjs
    // for why a same-origin proxy cannot work under a custom scheme.

    const file = resolveAsset(pathname === "/" ? "index.html" : pathname);
    if (!file) return new Response("forbidden", { status: 403 });

    try {
      // `net.fetch` over file:// reads through app.asar and streams, which
      // matters for a 36 MB wasm. Its inferred content-type does not know
      // .parquet and cannot be trusted for .wasm, so the body is re-wrapped
      // with a type we chose.
      const res = await net.fetch(pathToFileURL(file).toString());
      if (!res.ok) throw new Error(String(res.status));
      return new Response(res.body, {
        status: 200,
        headers: { "content-type": contentType(file) },
      });
    } catch {
      // An SPA fallback is deliberately NOT here. cc-miner is one page, so a
      // miss is a genuinely missing asset, and answering it with index.html
      // would turn a 404 into an unexplained blank window.
      return new Response(`not found: ${pathname}`, {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
  });
}

/**
 * Does a built renderer exist? Checked so the shell can say "run `pnpm build`"
 * instead of opening a window onto a 404.
 *
 * @returns {Promise<boolean>}
 */
export async function distExists() {
  try {
    await readFile(join(DIST, "index.html"));
    return true;
  } catch {
    return false;
  }
}
