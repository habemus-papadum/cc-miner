/**
 * vite.electron.config.ts — cc-miner in an Electron window. `pnpm dev:electron`.
 *
 * DEV MODE ONLY. There is no packaging story yet: this serves the app from a
 * Vite dev server exactly like the browser config does, and `electron/main.mjs`
 * opens a BrowserWindow onto it. HMR, the source-locator stamps and the DuckDB
 * WASM bundles all work unchanged, because nothing about them is browser-
 * specific — they are same-origin fetches from a localhost http server, which
 * is what Electron's renderer is looking at too.
 *
 * The ONLY difference from the browser config is the port, and it is a
 * convenience rather than a contract: `electron/dev.mjs` starts this server
 * through Vite's Node API and reads the URL it actually resolved to, so the
 * window finds the app even if 5179 is taken and Vite walks forward. Pinning it
 * just means the two shells can run side by side, and that the Electron one
 * lands on a stable, bookmarkable URL between runs.
 *
 * Deliberately NOT here: any flag telling the renderer it is in Electron. The
 * claim this split is meant to support is that the two hosts run the same app,
 * so the shell is detected at runtime (src/host.ts) rather than compiled in.
 * When packaging arrives it will land in this file — a `base` for the app://
 * scheme, a separate build target for the main process — and that is the reason
 * for a second config to exist this early with so little in it.
 */
import { defineConfig } from "vite";
import { ccMinerConfig } from "./vite.config.base";

/** Where the Electron dev server prefers to listen. Not load-bearing — see above. */
export const ELECTRON_DEV_PORT = 5179;

export default defineConfig({
  ...ccMinerConfig(),
  server: { port: ELECTRON_DEV_PORT },
});
