/**
 * vite-plugin.ts — makes the DuckDB host reachable from the page, same-origin.
 *
 *   GET  /__duckdb-host   → { ok, token, quackUri, grains, source, … } or { ok: false, … }
 *   GET  /__corpus/*      → corpus bytes, read from ~/.cache/cc-miner
 *
 * There is deliberately NO `/quack` proxy: it could not survive the packaged
 * app's custom scheme. The long note at the top of host-runtime.mjs says why.
 *
 * Both routes are implemented in `host-runtime.mjs`; this file only mounts them.
 * It mounts them **twice**, and that second mount is the point:
 *
 *   configureServer         `pnpm dev`      — the iteration loop
 *   configurePreviewServer  `pnpm preview`  — the BUILT app, served statically
 *
 * Without the preview mount, host mode would be a dev-server-only feature and
 * the production build could only ever run local bytes — which is precisely the
 * kind of gap that stays invisible until someone ships. The packaged Electron
 * app is the third mount, and it lives in electron/app-scheme.mjs.
 */
import type { Plugin } from "vite";
import { mountHostRoutes } from "./host-runtime.mjs";

export function duckdbHost(): Plugin {
  return {
    name: "cc-miner:duckdb-host",
    configureServer(server) {
      mountHostRoutes(server.middlewares);
    },
    configurePreviewServer(server) {
      mountHostRoutes(server.middlewares);
    },
  };
}
