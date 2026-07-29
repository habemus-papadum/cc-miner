/**
 * vite.config.ts — cc-miner in a browser tab. `pnpm dev`.
 *
 * The default host, and the one the aiui loop is built around: a real tab, real
 * DevTools, the intent client's side panel, the shared session browser. There
 * is nothing here but the shared config — in particular no `server.port`, so
 * this stays Vite's own default (5173, walking forward if taken), exactly as it
 * behaved before the Electron split existed.
 *
 * Its twin is vite.electron.config.ts; what they share is vite.config.base.ts.
 */
import { defineConfig } from "vite";
import { ccMinerConfig } from "./vite.config.base";

export default defineConfig(ccMinerConfig());
