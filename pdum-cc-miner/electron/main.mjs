/**
 * electron/main.mjs — the Electron main process, in both of its shapes.
 *
 * ONE file, two ways in, and which one is live is decided by a single fact:
 *
 *   PDUM_CC_MINER_URL set    DEV. A window onto the Vite server electron/dev.mjs
 *                       started. HMR, source maps, the whole iteration loop.
 *   PDUM_CC_MINER_URL unset  PACKAGED. A window onto `app://pdum-cc-miner/`, served out
 *                       of `dist/` by electron/app-scheme.mjs.
 *
 * The renderer is the same build either way, and it is never told which of the
 * two it is in. `src/host.ts` answers "am I in Electron?" at runtime, and
 * nothing answers "am I packaged?" at all, because nothing above this file is
 * allowed to care. That is what makes "it runs the same in a tab and in a
 * window" a claim someone can check rather than a hope.
 *
 * Deliberately still absent: preload, IPC, a menu. Every one of them is a place
 * where the packaged app could start behaving differently from the browser one.
 * The transport between renderer and data is HTTP in all three hosts.
 *
 *   PDUM_CC_MINER_URL        dev server URL — presence selects dev mode
 *   PDUM_CC_MINER_CDP_PORT   Chrome DevTools Protocol port, "" to disable
 *   PDUM_CC_MINER_DEVTOOLS   "1" to open DevTools detached on start
 */
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { APP_ORIGIN, distExists, registerAppScheme, serveApp } from "./app-scheme.mjs";
import { bindSidecarLifetime } from "./duckdb-sidecar.mjs";
import { initUpdater } from "./updater.mjs";

const devUrl = process.env.PDUM_CC_MINER_URL ?? "";
const isDev = devUrl !== "";

// Named explicitly so `userData` — where the runtime file and the corpus live —
// is the same directory whether this is run from a checkout or from a packaged
// bundle. Left to default, the two disagree: unpackaged Electron calls itself
// "Electron" and would put a shipped user's data somewhere else entirely.
app.setName("pdum-cc-miner");

// Must happen before `app.whenReady()`: Chromium fixes a scheme's privileges at
// startup and ignores a late registration silently. Registered unconditionally
// so that the dev and packaged paths differ only in what the window is pointed
// at, rather than in which subsystems exist.
registerAppScheme();

// Must also be appended before the app is ready. NOT 9222: that port belongs to
// the shared aiui session browser, and colliding with it would make `aiui open`
// and the Chrome DevTools MCP attach to this window by mistake. Unset in a
// packaged app — a shipped product should not open a debug port by default.
const cdpPort = process.env.PDUM_CC_MINER_CDP_PORT ?? "";
if (cdpPort) app.commandLine.appendSwitch("remote-debugging-port", cdpPort);

/** @param {string} url */
function createWindow(url) {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    // --cco-bg from src/styles.css. Without it the window paints white for a
    // frame or two before the app's dark stylesheet lands, which reads as a
    // flash of broken rendering rather than a load.
    backgroundColor: "#14161a",
    title: "pdum-cc-miner",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(url);
  if (process.env.PDUM_CC_MINER_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });

  // Anything off our own origin (docs links, an issue tracker) belongs in the
  // user's real browser, not in a chromeless window with no address bar.
  const ownOrigin = isDev ? devUrl : `${APP_ORIGIN}/`;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(ownOrigin)) {
      shell.openExternal(target);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

async function start() {
  if (isDev) {
    createWindow(devUrl);
    return;
  }
  // Set BEFORE anything reads it. `userData` is not knowable until the app is
  // ready, which is why server/host-runtime.mjs resolves this path per call
  // rather than at import: a constant would have been frozen before this line.
  process.env.PDUM_CC_MINER_HOST_RUNTIME ??= join(app.getPath("userData"), "duckdb-host.json");
  bindSidecarLifetime();

  initUpdater();
  serveApp();
  if (!(await distExists())) {
    // A window onto a 404 is a mystery; this is a sentence. Reachable in a
    // checkout (`electron .` with no build), never in a packaged app, where
    // dist/ is packaged or the build failed.
    console.error("[cc-miner] no built renderer at dist/ — run `pnpm build` first.");
    app.quit();
    return;
  }
  createWindow(`${APP_ORIGIN}/`);
}

app.whenReady().then(start);

// One window, one lifetime. Closing it ends the run on every platform — for a
// dev shell so electron/dev.mjs can take the Vite server down with it, and for
// the packaged app because a single-window utility that lingers in the dock
// with nothing on screen is a puzzle, not a feature.
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(isDev ? devUrl : `${APP_ORIGIN}/`);
});
