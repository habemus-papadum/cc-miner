/**
 * host.ts — which shell is this renderer running in?
 *
 * Answered at RUNTIME, not build time. cc-miner has two Vite configs (browser
 * and Electron) but deliberately one renderer: if the shell were a `define`,
 * the two bundles would genuinely differ and "it runs the same in both" would
 * stop being a claim anyone could check. Sniffing the user-agent keeps the
 * built artifact identical and moves the difference to where it actually is —
 * the window it happens to be displayed in.
 *
 * Electron stamps `Electron/<version>` into the renderer's user-agent by
 * default (it can be overridden per-session, and if it ever is, this needs to
 * change with it). Under Vitest's jsdom there is no such token, so tests see
 * "browser", which is the right answer for a headless renderer.
 *
 * Use this for cosmetics and for host-specific affordances that have a browser
 * fallback. It is NOT a data-access switch: where the bytes come from is the
 * coordinator's business (see docs/proposals/deployment-shapes.md), and a
 * renderer that branches on its shell to decide how to fetch is exactly the
 * second-path-to-one-truth this app keeps getting bitten by.
 */
export type Host = "browser" | "electron";

/** The shell this renderer is running in. */
export const HOST: Host =
  typeof navigator !== "undefined" && /\bElectron\//.test(navigator.userAgent)
    ? "electron"
    : "browser";
