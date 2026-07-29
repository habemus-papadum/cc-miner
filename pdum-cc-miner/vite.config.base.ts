/**
 * vite.config.base.ts — everything the two hosts share.
 *
 * cc-miner runs in two shells: a browser tab (`pnpm dev`) and an Electron
 * window (`pnpm dev:electron`). Both are Vite DEV SERVERS serving the same
 * renderer over http://localhost — Electron is not a different build, it is a
 * different window pointed at an equivalent server. That is the whole point of
 * this split: the delta between the two configs should stay small enough to
 * read in one screen, and today it is one line (the dev port).
 *
 * So the renderer never asks a build flag which shell it is in — it asks the
 * runtime (`src/host.ts`, which sniffs the Electron user-agent). A build-time
 * `define` would make the two bundles genuinely different, which is the
 * opposite of what we want to be able to claim.
 *
 * This is a FACTORY, not a shared object literal: each config gets its own
 * plugin instances, so the two can never accidentally share mutable plugin
 * state if both are ever loaded in one process.
 */
import aiui from "@habemus-papadum/aiui-source-processor";
import type { UserConfig } from "vite";
import solid from "vite-plugin-solid";
import { duckdbHost } from "./server/vite-plugin";

/**
 * Solid 2.0 (beta) via vite-plugin-solid@next (bundles solid-refresh for HMR).
 *
 * aiui() is the build-time integration (@habemus-papadum/aiui-source-processor): the
 * source-locator compiler pass — JSX gets data-source-loc = "src/…:line:col"
 * (dev-only stamps; production bundles ship clean) and `cell()` call sites get
 * their `{ name, loc }` identity injected in EVERY mode (load-bearing for
 * durable cells) — plus the dev-only sourceRoot seed. Nothing else: no overlay
 * injection, no channel port; connectivity arrives from the intent client
 * (window.__AIUI__ itself is the viz runtime's job, production included).
 *
 * Order matters: aiui() comes BEFORE solid() so the locator's `pre` babel pass
 * stamps JSX before vite-plugin-solid (also `pre`) compiles each element into
 * an opaque template. Same-enforce plugins run in array order.
 */
export function ccMinerConfig(): UserConfig {
  return {
    // Relative, so ONE `dist/` is valid everywhere it gets served from: the
    // root of a static host, a subdirectory of one, and `app://pdum-cc-miner/` inside
    // the packaged Electron app. An absolute base would pin the build to a
    // deploy path and force a second build for the desktop package — which is
    // exactly the "two artifacts, one claim" trap this split exists to avoid.
    base: "./",

    // duckdbHost() exposes `/quack` and `/__duckdb-host` so the page reaches the
    // DuckDB process without ever knowing its port. It mounts on the dev server
    // AND the preview server, so the BUILT app can run host mode too.
    plugins: [aiui(), solid(), duckdbHost()],

    build: {
      // Never base64-inline an asset. The default 4 KB limit swept 22 of the
      // replay Parquet files into the entry chunk — measured — which costs the
      // 33% base64 tax on the critical path and, worse, makes "how big is the
      // data" unanswerable by looking at the assets. Parquet is data; data is a
      // file.
      assetsInlineLimit: 0,
      // The entry chunk is genuinely ~200 KB and DuckDB's wasm is genuinely
      // 36 MB; the default 500 KB warning has nothing useful to say about
      // either. Silenced with a number rather than ignored, so a real regression
      // in the app chunk still shows up.
      chunkSizeWarningLimit: 2000,
    },
  };
}
