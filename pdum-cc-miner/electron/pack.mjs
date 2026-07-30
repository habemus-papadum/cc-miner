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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");

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
 * @returns {{args: string[], summary: string}}
 */
function gatherSigning() {
  if (target !== "mac") return { args: [], summary: "" };

  // CI supplies the certificate as a base64 .p12 in CSC_LINK; electron-builder
  // imports it into a temporary keychain itself.
  const fromEnv = Boolean(process.env.CSC_LINK);
  let identity = fromEnv ? "from CSC_LINK" : null;
  if (!fromEnv) {
    const found = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
    const line = (found.stdout ?? "")
      .split("\n")
      .find((l) => l.includes("Developer ID Application"));
    identity = line?.match(/"([^"]+)"/)?.[1] ?? null;
  }

  if (!identity) {
    return {
      args: ["-c.mac.identity=null", "-c.mac.notarize=false"],
      summary:
        "  unsigned — no `Developer ID Application` certificate found.\n" +
        "  The artifact runs locally and Gatekeeper will refuse it anywhere else.\n" +
        "  See README → Signing and notarization.",
    };
  }

  // App Store Connect API key first: it needs no 2FA and no app-specific
  // password, which is what makes it the one that works unattended in CI.
  const apiKey =
    process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  const appleId =
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;

  if (!apiKey && !appleId) {
    return {
      args: [...(fromEnv ? [] : [`-c.mac.identity=${identity}`]), "-c.mac.notarize=false"],
      summary:
        `  signed as ${identity}, NOT notarized — no Apple credentials in the environment.\n` +
        "  Gatekeeper shows the “cannot be opened” dialog on a machine that has not\n" +
        "  seen this developer before. See README → Signing and notarization.",
    };
  }

  return {
    args: [...(fromEnv ? [] : [`-c.mac.identity=${identity}`]), "-c.mac.notarize=true"],
    summary: `  signed as ${identity}, notarizing via ${apiKey ? "App Store Connect API key" : "Apple ID"}.`,
  };
}

const version = appVersion();
const signing = gatherSigning();
console.log(`\n  cc-miner ${version} → ${target}`);
if (signing.summary) console.log(signing.summary);
console.log("");

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
process.exit(assertAsarBudget());

/**
 * Find the app.asar this run produced, without naming the product.
 *
 * The path used to be spelled `release/mac-arm64/cc-miner.app/…`, and eviction
 * renamed `productName` to `pdum-cc-miner` — after which the path matched
 * nothing, `assertAsarBudget` took its "nothing built here" branch, and the
 * tripwire below reported success without ever weighing anything. That is the
 * precise failure it exists to prevent, so the name is discovered rather than
 * written down: rename the product again and this still finds it.
 *
 * @returns {string | null}
 */
function findAsar() {
  const release = resolve(APP_ROOT, "release");
  if (!existsSync(release)) return null;
  for (const entry of readdirSync(release, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(release, entry.name);
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
