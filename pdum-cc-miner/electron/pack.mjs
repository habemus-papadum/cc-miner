/**
 * pack.mjs — build the installable artifacts.
 *
 *   node electron/pack.mjs mac      → release/*.dmg, release/*.zip, latest-mac.yml
 *   node electron/pack.mjs linux    → release/*.AppImage, release/*.deb, latest-linux.yml
 *   node electron/pack.mjs dir      → release/mac-arm64/pdum-cc-miner.app (fast, unpackaged)
 *
 * This wrapper exists for ONE reason worth stating plainly: two fields in
 * cc-miner's package.json are correct for a workspace member and wrong for a
 * desktop app, and neither may be edited in the tree.
 *
 *   main      `./src/index.ts` — the library barrel. Every sibling in this
 *             workspace consumes cc-miner source-first through it; a desktop
 *             build needs `electron/main.mjs` instead.
 *   version   the workspace lockstep marker, not the artifact's version — a
 *             release supplies the real one via PDUM_CC_MINER_VERSION. Rewritten
 *             unconditionally because of a semver TRAP: build metadata is
 *             ignored by semver comparison, so a `X.Y.Z+dev` marker of the kind
 *             this repo inherited compares EQUAL to `X.Y.Z` and
 *             electron-updater would decide there is nothing newer. Forever.
 *
 * `extraMetadata` rewrites both in the package.json that goes INTO the bundle,
 * leaving the repo's own untouched. That is the whole trick, and it is why this
 * script exists rather than a line in a README telling someone to remember.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
/** electron-builder's `directories.output`. */
const RELEASE = resolve(APP_ROOT, "release");

/** @type {Record<string, string[]>} */
const TARGETS = { mac: ["--mac"], linux: ["--linux"], dir: ["--dir"] };
const target = process.argv[2] ?? "dir";
if (!(target in TARGETS)) {
  console.error(`usage: pack.mjs <${Object.keys(TARGETS).join("|")}>`);
  process.exit(2);
}

/**
 * The version the artifact carries.
 *
 * `PDUM_CC_MINER_VERSION` when the release pipeline supplies one; otherwise a
 * PRERELEASE derived from the commit — `0.12.0-dev.a1b2c3d`, which semver sorts
 * strictly BELOW `0.12.0`. A local build can therefore never look newer than a
 * real release to an updater, which is the failure mode worth designing out.
 */
function appVersion() {
  if (process.env.PDUM_CC_MINER_VERSION) return process.env.PDUM_CC_MINER_VERSION.replace(/^v/, "");
  const pkg = JSON.parse(readFileSync(resolve(APP_ROOT, "package.json"), "utf8"));
  const base = String(pkg.version).replace(/\+.*$/, "");
  const sha = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" });
  const suffix = sha.status === 0 ? sha.stdout.trim() : "local";
  return `${base}-dev.${suffix}`;
}

/** The keychain common-name prefix that marks a distribution certificate. */
const IDENTITY_PREFIX = "Developer ID Application: ";

/**
 * Decide how (and whether) this build is signed and notarized, and say so.
 *
 * The trap this exists to close: a Mac dev machine usually holds an **Apple
 * Development** certificate, and electron-builder will cheerfully sign with it
 * if left to auto-discover. What comes out looks signed, passes `codesign
 * --verify`, runs on the machine that built it — and is rejected by notarytool
 * and by Gatekeeper on every other Mac. Only **Developer ID Application** is
 * valid for distribution outside the App Store, so this looks for that exact
 * string and treats anything else as unsigned.
 *
 * Note the asymmetry between what we SEARCH for and what we PASS. The keychain's
 * common name is `Developer ID Application: Name (TEAMID)`, and that whole string
 * is what proves the certificate is the right kind — but `-c.mac.identity` must
 * receive only the `Name (TEAMID)` half. electron-builder applies the certificate
 * type itself and rejects a qualifier carrying the prefix outright ("Please
 * remove prefix … — appropriate certificate will be chosen automatically"),
 * which is a hard failure AFTER the renderer has been built and Electron
 * downloaded. Measured against app-builder-lib 26.15.3: `findIdentity` checks
 * the qualifier against `appleCertificatePrefixes` and throws, then matches what
 * survives with `line.includes(qualifier)` over `security find-identity` output.
 *
 * @returns {{args: string[], summary: string, notarytool?: string[]}} `notarytool`
 *   is present exactly when this build will be notarized, and doubles as the
 *   flag for "there is a ticket to staple onto the dmg afterwards".
 */
function gatherSigning() {
  if (target !== "mac") return { args: [], summary: "" };

  // CI supplies the certificate as a base64 .p12 in CSC_LINK; electron-builder
  // imports it into a temporary keychain itself.
  const fromEnv = Boolean(process.env.CSC_LINK);
  /** The full common name, for the human reading the build log. */
  let identity = fromEnv ? "from CSC_LINK" : null;
  /** The `Name (TEAMID)` half, which is the only form electron-builder accepts. */
  let qualifier = null;
  if (!fromEnv) {
    const found = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
    const line = (found.stdout ?? "")
      .split("\n")
      .find((l) => l.includes(IDENTITY_PREFIX.trimEnd()));
    identity = line?.match(/"([^"]+)"/)?.[1] ?? null;
    qualifier = identity?.startsWith(IDENTITY_PREFIX)
      ? identity.slice(IDENTITY_PREFIX.length)
      : identity;
  }

  /** `-c.mac.identity`, or nothing when CSC_LINK owns the choice. */
  const identityArgs = fromEnv ? [] : [`-c.mac.identity=${qualifier}`];

  if (!identity) {
    return {
      args: ["-c.mac.identity=null", "-c.mac.notarize=false"],
      summary:
        "  unsigned — no `Developer ID Application` certificate found.\n" +
        "  The artifact runs locally and Gatekeeper will refuse it anywhere else.\n" +
        "  See README → Signing and notarization.",
    };
  }

  // Each branch also spells the SAME credentials for notarytool, which staples
  // the dmg afterwards (see stapleDmgs) — so one place decides which mechanism
  // is in play, and the two can never disagree about it.
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;

  // App Store Connect API key first: it needs no 2FA and no app-specific
  // password, which is what makes it the one that works unattended in CI.
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return {
      args: [...identityArgs, "-c.mac.notarize=true"],
      summary: `  signed as ${identity}, notarizing via App Store Connect API key.`,
      notarytool: [
        "--key",
        APPLE_API_KEY,
        "--key-id",
        APPLE_API_KEY_ID,
        "--issuer",
        APPLE_API_ISSUER,
      ],
    };
  }

  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    return {
      args: [...identityArgs, "-c.mac.notarize=true"],
      summary: `  signed as ${identity}, notarizing via Apple ID.`,
      notarytool: [
        "--apple-id",
        APPLE_ID,
        "--password",
        APPLE_APP_SPECIFIC_PASSWORD,
        "--team-id",
        APPLE_TEAM_ID,
      ],
    };
  }

  return {
    args: [...identityArgs, "-c.mac.notarize=false"],
    summary:
      `  signed as ${identity}, NOT notarized — no Apple credentials in the environment.\n` +
      "  Gatekeeper shows the “cannot be opened” dialog on a machine that has not\n" +
      "  seen this developer before. See README → Signing and notarization.",
  };
}

/**
 * Notarize and staple each `.dmg`, after electron-builder has built them.
 *
 * MEASURED, and the reason this function exists: electron-builder notarizes the
 * `.app`, staples the ticket to it, and only then wraps it in a `.zip` and a
 * `.dmg`. The zip therefore carries a stapled app and is correct as-is — which
 * is what matters most, since `latest-mac.yml` points electron-updater at the
 * zip. The **dmg is left with no ticket of its own**:
 *
 *     xcrun stapler validate …-arm64.dmg
 *     → does not have a ticket stapled to it
 *
 * A dmg is what a human downloads, and an unstapled one still passes Gatekeeper
 * only by asking Apple at open time. Offline — or behind a captive portal, or
 * during an Apple outage — it shows the same "cannot be opened" dialog as an
 * unsigned build, which is the most expensive possible way to present a working
 * app. Stapling makes the verdict local and permanent.
 *
 * The second submission is cheap: the enclosed app is already notarized, so
 * Apple recognises the payload rather than re-scanning it from scratch.
 *
 * STAPLING APPENDS TO THE FILE — measured, ~2 KB — so any checksum electron-
 * builder recorded before this runs is immediately wrong. That is why
 * `electron-builder.yml` sets `dmg.writeUpdateInfo: false`: the dmg must not
 * appear in `latest-mac.yml`, whose entries carry a sha512 and a size. The zip
 * is unaffected (nothing here touches it) and remains what the updater reads.
 *
 * @param {string[]} notarytoolArgs credential flags from gatherSigning()
 * @returns {number} exit code
 */
function stapleDmgs(notarytoolArgs) {
  const dmgs = existsSync(RELEASE)
    ? readdirSync(RELEASE)
        .filter((f) => f.endsWith(".dmg"))
        .map((f) => resolve(RELEASE, f))
    : [];
  if (dmgs.length === 0) return 0; // zip-only build, or a target that makes none

  for (const dmg of dmgs) {
    console.log(`\n  notarizing ${dmg.slice(RELEASE.length + 1)} …`);
    const sub = spawnSync("xcrun", ["notarytool", "submit", dmg, ...notarytoolArgs, "--wait"], {
      stdio: "inherit",
    });
    if (sub.status !== 0) {
      console.error("\n  notarytool submit failed for the dmg. The .app and .zip are unaffected.");
      return sub.status ?? 1;
    }

    const staple = spawnSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
    if (staple.status !== 0) return staple.status ?? 1;

    // Assert rather than assume. `stapler staple` reporting success and the
    // ticket not validating afterwards is exactly the class of failure this
    // whole file exists to make loud.
    const check = spawnSync("xcrun", ["stapler", "validate", dmg], { encoding: "utf8" });
    if (check.status !== 0) {
      console.error(`\n  stapled, but validation failed:\n${check.stdout}${check.stderr}`);
      return check.status ?? 1;
    }
    console.log(`  ✓ ticket stapled and validated`);
  }
  return 0;
}

const version = appVersion();
const signing = gatherSigning();
console.log(`\n  cc-miner ${version} → ${target}`);
if (signing.summary) console.log(signing.summary);
console.log("");

// ── Publishing versus stapling ───────────────────────────────────────────────
// These cannot currently be combined, and this refuses rather than shipping the
// difference. MEASURED in app-builder-lib 26.15.3: PublishManager schedules each
// upload from the `artifactCreated` event, and `AsyncTaskManager.addTask` is
// handed an ALREADY-STARTED promise — so the dmg begins uploading the moment it
// is built, before `afterAllArtifactBuild` and long before this script regains
// control. There is no hook late enough to get a ticket into the bytes that
// reach users.
//
// A dry run — the release workflow's default — is unaffected. Only a real
// publish is blocked, and the fix is to split it into build → staple → publish
// rather than to weaken this into a warning nobody reads.
if (
  process.env.PDUM_CC_MINER_PUBLISH === "always" &&
  target === "mac" &&
  signing.notarytool != null
) {
  console.error(
    "  refusing to publish: the dmg uploads as soon as it is built, before its\n" +
      "  notarization ticket can be stapled. The published file would then need an\n" +
      "  online Gatekeeper check and would fail offline — indistinguishable from an\n" +
      "  unsigned build. Build and staple first, then publish the stapled artifacts.\n" +
      "  See stapleDmgs() below.",
  );
  process.exit(2);
}

// Wipe the previous build's artifacts. electron-builder overwrites what it
// rebuilds but removes nothing, so release/ otherwise accumulates every version
// ever built here — and every consumer of that directory assumes the opposite.
// `release.yml` uploads `release/*.dmg` by glob, `latest-mac.yml` names only the
// current build, and a `stapler validate release/*.dmg` reaches for whichever
// file the shell expands first. All three quietly mean "what this build made".
rmSync(RELEASE, { recursive: true, force: true });

// The renderer first: the bundle's whole reason for existing is dist/, and
// packaging a stale one produces an artifact that looks fine and is not.
const build = spawnSync("npx", ["vite", "build"], { cwd: APP_ROOT, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const args = [
  "electron-builder",
  ...TARGETS[target],
  "--config",
  "electron-builder.yml",
  `-c.extraMetadata.main=electron/main.mjs`,
  `-c.extraMetadata.version=${version}`,
  ...signing.args,
  // Publishing is OPT-IN, via PDUM_CC_MINER_PUBLISH=always from the release
  // workflow. electron-builder's own default is "publish if it detects CI",
  // which is exactly the kind of implicit behaviour that ships something by
  // accident — a `pnpm pack:mac` on a CI runner should build, not release.
  "--publish",
  process.env.PDUM_CC_MINER_PUBLISH === "always" ? "always" : "never",
  ...process.argv.slice(3),
];
const res = spawnSync("npx", args, { cwd: APP_ROOT, stdio: "inherit" });
if (res.status !== 0) process.exit(res.status ?? 1);

// electron-builder staples the .app and then wraps it — so the zip is already
// correct and the dmg is not. See stapleDmgs().
if (target === "mac" && signing.notarytool != null) {
  const stapled = stapleDmgs(signing.notarytool);
  if (stapled !== 0) process.exit(stapled);
}

process.exit(assertAsarBudget());

/**
 * Find the app.asar this run produced, without naming the product.
 *
 * The path used to be spelled `release/mac-arm64/cc-miner.app/…`. When
 * `productName` became `pdum-cc-miner` the path stopped matching anything,
 * `assertAsarBudget` took its "nothing built here" branch, and the
 * tripwire below reported success without ever weighing anything. That is the
 * precise failure it exists to prevent, so the name is discovered rather than
 * written down: rename the product again and this still finds it.
 *
 * @returns {string | null}
 */
function findAsar() {
  if (!existsSync(RELEASE)) return null;
  for (const entry of readdirSync(RELEASE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(RELEASE, entry.name);
    // linux:  release/linux-unpacked/resources/app.asar
    const linux = resolve(dir, "resources/app.asar");
    if (existsSync(linux)) return linux;
    // macOS:  release/mac-arm64/<productName>.app/Contents/Resources/app.asar
    for (const child of readdirSync(dir)) {
      if (!child.endsWith(".app")) continue;
      const mac = resolve(dir, child, "Contents/Resources/app.asar");
      if (existsSync(mac)) return mac;
    }
  }
  return null;
}

/**
 * Fail if app.asar has grown well past the renderer it is supposed to contain.
 *
 * `files` in electron-builder.yml excludes the renderer's dependency tree by
 * NAME, and a denylist rots: add a heavy dependency and it ships silently,
 * discovered later as "why is the download 400 MB". This is the counter-measure
 * — the list cannot maintain itself, but its failure can be made loud.
 *
 * The budget is deliberately slack. It is a tripwire for a regression of tens of
 * megabytes, not a limit to tune.
 *
 * @returns {number} exit code
 */
function assertAsarBudget() {
  const BUDGET_MB = 140; // dist/ is ~108 MB; electron-updater's tree is ~1 MB
  const asar = findAsar();
  if (!asar) {
    // Nothing built here to measure — a dmg-only rebuild, say. Said out loud,
    // because "the budget check quietly did nothing" is how it broke before.
    console.log("\n  app.asar not found under release/ — size budget not checked");
    return 0;
  }

  const mb = statSync(asar).size / 1e6;
  console.log(`\n  app.asar ${mb.toFixed(1)} MB (budget ${BUDGET_MB} MB)`);
  if (mb <= BUDGET_MB) return 0;
  console.error(
    `\n  app.asar is ${mb.toFixed(1)} MB, over the ${BUDGET_MB} MB budget.\n` +
      `  Something joined the bundle that belongs in dist/. Inspect it with:\n` +
      `    npx asar list "${asar}" | grep '^/node_modules/' | cut -d/ -f3,4 | sort -u\n` +
      `  Then either exclude it in electron-builder.yml → files, or raise the\n` +
      `  budget here deliberately.`,
  );
  return 1;
}
