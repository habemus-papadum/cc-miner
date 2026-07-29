/**
 * updater.mjs — check GitHub Releases for a newer cc-miner, and offer it.
 *
 * `autoDownload` is OFF. The download is ~190 MB, and a desktop tool quietly
 * consuming that on someone's tethered connection is not a courtesy. The user is
 * asked first, and the install happens on quit, never mid-session.
 *
 * ── Two conditions that make this a no-op, both deliberate ───────────────────
 *
 * NOT PACKAGED. In a checkout there is no bundle to replace and electron-updater
 * throws outright, so the check is skipped rather than caught.
 *
 * NOT SIGNED. On macOS the update is applied by Squirrel.Mac, which verifies
 * that the replacement's code signature matches the running app's. An unsigned
 * build cannot be updated — the download succeeds and the swap fails with
 * "Could not get code signature for running application". Auto-update is
 * therefore a feature of SIGNED builds only; the unsigned artifacts this repo
 * can currently produce will check, find an update, and be unable to apply it.
 * Better to say that here than to let someone discover it from a shipped app.
 */
import { app, dialog, shell } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

/** How long after launch to check. Long enough not to compete with first paint. */
const FIRST_CHECK_DELAY_MS = 8_000;

/** Where releases live, if it is not what electron-builder compiled in. */
const FEED_REPO = process.env.PDUM_CC_MINER_RELEASE_REPO; // "owner/repo"

/**
 * Wire up update checking. Safe to call unconditionally — it decides for itself
 * whether there is anything it can usefully do.
 */
export function initUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => console.log("[updater]", m),
    warn: (m) => console.warn("[updater]", m),
    error: (m) => console.error("[updater]", m),
    debug: () => {},
  };

  // A plain HTTP base holding latest-mac.yml and the archives. Exists so the
  // update path can be exercised against a local server rather than only
  // against a real GitHub release — "it is configured" and "it detects a newer
  // version" are different claims, and only one of them is testable without
  // publishing something.
  if (process.env.PDUM_CC_MINER_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: "generic", url: process.env.PDUM_CC_MINER_UPDATE_URL });
  } else if (FEED_REPO?.includes("/")) {
    const [owner, repo] = FEED_REPO.split("/");
    autoUpdater.setFeedURL({ provider: "github", owner, repo });
  }

  autoUpdater.on("update-available", async (info) => {
    console.log(`[updater] update-available: ${info.version} (running ${app.getVersion()})`);
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Download", "Release notes", "Later"],
      defaultId: 0,
      cancelId: 2,
      message: `pdum-cc-miner ${info.version} is available.`,
      detail: `You have ${app.getVersion()}. The download is about 190 MB and installs when you quit.`,
    });
    console.log(`[updater] user chose ${["download", "notes", "later"][response] ?? response}`);
    if (response === 0) autoUpdater.downloadUpdate();
    if (response === 1 && FEED_REPO) {
      shell.openExternal(`https://github.com/${FEED_REPO}/releases/tag/v${info.version}`);
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    console.log(`[updater] up to date (newest is ${info.version})`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] ${info.version} staged; it will install on quit.`);
  });

  autoUpdater.on("error", (err) => {
    // Never a dialog. A failed update check is not the user's problem to solve
    // mid-session, and the most likely causes — offline, or an unsigned build —
    // are not actionable from a modal.
    console.error("[updater] check failed:", err?.message ?? err);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      console.error("[updater] check failed:", e?.message ?? e);
    });
  }, FIRST_CHECK_DELAY_MS);
}
